import { PDFDocument, PrintScaling } from 'pdf-lib'
import { PublicError } from '../contracts/errors'
import { connectionDigest, inventoryDeviceScope } from '../inventory-sync/connection'
import { pdfHash } from '../product-labels/cache'
import { downloadMergedProductLabels, type ProductLabelEnvironment } from '../product-labels/download'
import { checkPackLabelQuantity } from './pack-label-limits'
import type { PackBatch } from './pack-types'

type Env = ProductLabelEnvironment & { ARCHIVE: R2Bucket }
const templateKey = 'product-labels/eu-rep-ceramic-80mm-v1.pdf'
const unavailable = () =>
  new PublicError('LABELS_UNAVAILABLE', 'API 标签尚未生成，请重试生成标签。', 503)

/** Only API-derived, validated and composed PDFs are exposed by the Pack download flow. */
export class PackApiLabels {
  constructor(
    private readonly env: Env,
    private readonly generate = downloadMergedProductLabels,
  ) {}

  private async revision() {
    const template = await this.env.ARCHIVE.get(templateKey)
    if (!template)
      throw new PublicError('PRODUCT_LABEL_TEMPLATE_UNAVAILABLE', '固定欧代标签模板尚未配置。', 503)
    return Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await template.arrayBuffer())),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('')
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
      throw new PublicError('FORBIDDEN', '本批次不属于当前 Amazon 店铺，不能获取或生成标签。', 403)
    return scope
  }
  private async key(batch: PackBatch, group: string, revision: string) {
    // The original plan is immutable; include its contents to fail closed if that ever changes.
    const plan = batch.plan?.groups.find((item) => item.name === group)
    if (!plan) throw new PublicError('NOT_FOUND', '没有找到该分拣组。', 404)
    const digest = await connectionDigest(JSON.stringify([group, plan.raw]))
    return `order-sorting/pack/api-labels/v1/${batch.id}/${revision}/${digest}.json`
  }
  private async cached(key: string, metadataOnly = false): Promise<Uint8Array | null> {
    try {
      const manifest = await this.env.ARCHIVE.get(key)
      if (!manifest) return null
      const { objectKey, sha, size, etag } = await manifest.json<{
        objectKey: string
        sha: string
        size: number
        etag?: string
      }>()
      if (
        typeof sha !== 'string' ||
        !/^[a-f0-9]{64}$/.test(sha) ||
        objectKey !== key.replace(/\.json$/, `/${sha}.pdf`) ||
        size > 32 * 1024 * 1024
      )
        return null
      if (metadataOnly && etag && typeof this.env.ARCHIVE.head === 'function') {
        const meta = await this.env.ARCHIVE.head(objectKey)
        return meta && meta.size === size && meta.etag === etag ? new Uint8Array() : null
      }
      const file = await this.env.ARCHIVE.get(objectKey)
      if (!file || file.size !== size) return null
      const bytes = new Uint8Array(await file.arrayBuffer())
      return (await pdfHash(bytes)) === sha ? bytes : null
    } catch {
      return null
    }
  }
  async view(batch: PackBatch): Promise<PackBatch> {
    const groups = batch.plan?.groups ?? []
    let revision = ''
    try {
      await this.scope(batch)
      revision = await this.revision()
    } catch {
      /* Ready must never fall back to old Flex files. */
    }
    const labelGroups = await Promise.all(
      groups.map(async (group) => ({
        group: group.name,
        ready: !!revision && !!(await this.cached(await this.key(batch, group.name, revision), true)),
      })),
    )
    return {
      ...batch,
      labelSource: 'AMAZON_API',
      labelGroups,
      state: !batch.newRows
        ? 'NO_NEW'
        : labelGroups.length > 0 && labelGroups.every((group) => group.ready)
          ? 'READY'
          : 'LABELS_PENDING',
    }
  }
  async prepare(batch: PackBatch): Promise<PackBatch> {
    try {
      for (const group of batch.plan?.groups ?? []) await this.download(batch, group.name)
      return await this.view(batch)
    } catch (error) {
      return {
        ...(await this.view(batch)),
        labelError:
          error instanceof PublicError ? error.message : '标签生成暂未完成，订单已保存，可在 ERP 重试。',
      }
    }
  }
  async download(batch: PackBatch, group: string) {
    const scope = await this.scope(batch)
    const revision = await this.revision()
    const key = await this.key(batch, group, revision)
    let bytes = await this.cached(key)
    if (!bytes) {
      const plan = batch.plan!.groups.find((item) => item.name === group)!
      checkPackLabelQuantity(plan)
      const chunks: { sku: string; fnsku: string; units: number }[][] = []
      let current: { sku: string; fnsku: string; units: number }[] = [],
        count = 0
      for (const [, sku, fnsku, , quantity] of plan.raw) {
        let remaining = quantity
        while (remaining > 0) {
          const units = Math.min(remaining, 1000 - count)
          current.push({ sku, fnsku, units })
          count += units
          remaining -= units
          if (count === 1000) {
            chunks.push(current)
            current = []
            count = 0
          }
        }
      }
      if (current.length) chunks.push(current)
      const merged = chunks.length > 1 ? await PDFDocument.create() : null
      let size = 0
      for (const lines of chunks) {
        const response = await this.generate(this.env, {
          sellerAccountId: scope.sellerAccountId,
          marketplaceId: scope.marketplaceId,
          region: 'NA',
          locale: 'en_US',
          filename: `${group}-${batch.date.replaceAll('-', '')}-SKU标签`,
          lines,
        })
        if (!response.ok || !response.headers.get('content-type')?.includes('application/pdf'))
          throw unavailable()
        const part = new Uint8Array(await response.arrayBuffer())
        size += part.byteLength
        if (size > 32 * 1024 * 1024)
          throw new PublicError('LABELS_TOO_LARGE', '本分组标签文件过大，请拆分订单批次。', 413)
        const pdf = await PDFDocument.load(part)
        if (pdf.getPageCount() !== lines.reduce((n, line) => n + line.units, 0)) throw unavailable()
        if (merged) {
          for (const page of await merged.copyPages(pdf, pdf.getPageIndices())) merged.addPage(page)
        } else bytes = part
      }
      if (merged) {
        merged.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None)
        bytes = await merged.save()
      }
      if (!bytes || bytes.byteLength > 32 * 1024 * 1024) throw unavailable()
      const sha = await pdfHash(bytes),
        objectKey = key.replace(/\.json$/, `/${sha}.pdf`)
      const saved = await this.env.ARCHIVE.put(objectKey, bytes, { httpMetadata: { contentType: 'application/pdf' } })
      await this.env.ARCHIVE.put(key, JSON.stringify({ objectKey, sha, size: bytes.byteLength, etag: saved?.etag }), {
        httpMetadata: { contentType: 'application/json' },
      })
    }
    return new Response(bytes.slice().buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="sku-labels.pdf"; filename*=UTF-8''${encodeURIComponent(`${group}-${batch.date.replaceAll('-', '')}-SKU标签.pdf`)}`,
      },
    })
  }
}
