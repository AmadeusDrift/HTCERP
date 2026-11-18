import { PublicError } from '../contracts/errors'
import { inventoryDeviceScope, connectionDigest } from '../inventory-sync/connection'
import { fileKey, PrivateFileCache } from '../product-images/cache'
import {
  type ImageEnvironment,
  type ImageScope,
  type ProductImage,
  ProductImages,
} from '../product-images/service'
import type { SortGroup } from './rules'
import type { PackBatch } from './pack-types'
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
  private async scope(batch: PackBatch) {
    const scope = await inventoryDeviceScope(this.env.DB)
    const record = await this.env.DB.prepare('SELECT scope_key FROM pack_order_batches WHERE id=?')
      .bind(batch.id)
      .first<{ scope_key: string }>()
    const expected = await connectionDigest(
      JSON.stringify([scope.sellerAccountId, scope.marketplaceId, scope.warehouseCode]),
    )
    if (!record || record.scope_key !== expected)
      throw new PublicError('FORBIDDEN', '本批次不属于当前 Amazon 店铺。', 403)
    return scope
  }
  async view(batch: PackBatch): Promise<PackBatch> {
    let scope: ImageScope
    try {
      scope = await this.scope(batch)
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
  async prepare(batch: PackBatch): Promise<PackBatch> {
    const scope = await this.scope(batch),
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
  async download(batch: PackBatch, name: string) {
    const scope = await this.scope(batch),
      group = batch.plan?.groups.find((g) => g.name === name)
    if (!group) throw new PublicError('NOT_FOUND', '没有找到该分组。', 404)
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
