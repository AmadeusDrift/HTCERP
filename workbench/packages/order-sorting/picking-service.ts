import { PublicError } from '../contracts/errors'
import { fileKey, PrivateFileCache } from '../product-images/cache'
import {
  type ImageEnvironment,
  type ImageScope,
  type ProductImage,
  ProductImages,
} from '../product-images/service'
import type { SortGroup } from './rules'
import type { OrderOutputBatch } from './pack-types'
import { orderOutputScope } from './output-scope'
import { exportPickingSheet, pickingFilename, pickingMime } from './picking-workbook'

export class PickingSheets {
  private images: ProductImages
  constructor(
    private readonly env: ImageEnvironment,
    images?: ProductImages,
  ) {
    this.images = images ?? new ProductImages(env)
  }
  private key(scope: ImageScope, batch: string, group: SortGroup, date: string) {
    return fileKey('sheet', [
      scope.sellerAccountId,
      scope.marketplaceId,
      batch,
      group,
      date,
      'factory-v1',
    ])
  }
  async generate(scope: ImageScope, batch: string, group: SortGroup, date: string): Promise<Uint8Array> {
    const key = await this.key(scope, batch, group, date)
    const file = await new PrivateFileCache(this.env).getOrCreate(key, async () => {
      const images = new Map<string, ProductImage>(),
        missing: string[] = []
      let size = 0
      for (const sku of new Set(group.detail.map((row) => String(row[5])))) {
        try {
          const image = await this.images.get(scope, sku)
          size += image.bytes.length
          images.set(sku, image)
        } catch (error) {
          missing.push(sku + (error instanceof PublicError ? `（${error.message}）` : ''))
        }
        if (size > 24 * 1024 * 1024)
          throw new PublicError('PICKING_TOO_LARGE', '本组图片文件较大，请拆分订单批次。', 413)
      }
      if (missing.length)
        throw new PublicError(
          'PICKING_IMAGES_MISSING',
          `缺图 ${missing.length} 个 SKU：${missing.slice(0, 20).join('、')}。订单已保留，请重试取图。`,
          503,
        )
      return {
        bytes: await exportPickingSheet(group, date, images),
        metadata: {
          type: pickingMime,
          filename: pickingFilename(group),
          imageCount: images.size,
          units: group.units,
        },
      }
    })
    return file.bytes
  }
  async view<T extends OrderOutputBatch>(batch: T): Promise<T> {
    let scope: ImageScope
    try {
      scope = await orderOutputScope(this.env.DB, batch)
    } catch {
      return {
        ...batch,
        pickingGroups: (batch.plan?.groups ?? []).map((group) => ({ group: group.name, ready: false })),
      }
    }
    const pickingGroups = []
    for (const group of batch.plan?.groups ?? []) {
      const record = await this.env.DB.prepare(
        'SELECT object_key FROM product_image_cache WHERE cache_key=?',
      )
        .bind(await this.key(scope, batch.id, group, batch.date))
        .first<{ object_key: string | null }>()
      pickingGroups.push({ group: group.name, ready: !!record?.object_key })
    }
    return { ...batch, pickingGroups }
  }
  async prepare<T extends OrderOutputBatch>(batch: T): Promise<T> {
    const scope = await orderOutputScope(this.env.DB, batch),
      errors: string[] = []
    for (const group of batch.plan?.groups ?? []) {
      try {
        await this.generate(scope, batch.id, group, batch.date)
      } catch (e) {
        errors.push(e instanceof PublicError ? e.message : `${group.name} 备货单生成失败，请重试。`)
      }
    }
    return { ...(await this.view(batch)), ...(errors.length ? { pickingError: errors.join('\n') } : {}) }
  }
  async download(batch: OrderOutputBatch, name: string, cachedOnly = false) {
    const scope = await orderOutputScope(this.env.DB, batch),
      group = batch.plan?.groups.find((g) => g.name === name)
    if (!group) throw new PublicError('NOT_FOUND', '没有找到该分组。', 404)
    if (cachedOnly) {
      const file = await new PrivateFileCache(this.env).read(await this.key(scope, batch.id, group, batch.date))
      if (!file) throw new PublicError('PICKING_UNAVAILABLE', '带图备货单尚未生成，请重试生成。', 503)
      return pickingResponse(file.bytes, pickingFilename(group))
    }
    return pickingResponse(
      await this.generate(scope, batch.id, group, batch.date),
      pickingFilename(group),
    )
  }
}

export function pickingResponse(bytes: Uint8Array, filename: string) {
  return new Response(bytes.slice().buffer, {
    headers: {
      'Content-Type': pickingMime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="picking.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}
