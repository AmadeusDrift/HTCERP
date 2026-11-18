import { PublicError } from '../contracts/errors'
import { connectionDigest, inventoryDeviceScope } from '../inventory-sync/connection'
import { fileKey, PrivateFileCache } from '../product-images/cache'
import type { ImageEnvironment } from '../product-images/service'
import { pdfHash } from '../product-labels/cache'
import { PackApiLabels } from './pack-api-labels'
import { checkPackLabelQuantity } from './pack-label-limits'
import { exportPackBundle } from './pack-output'
import { PackOrders } from './pack-service'
import { parsePackSource } from './pack-source'
import type { PackBatch } from './pack-types'
import { PickingSheets } from './picking-service'
import { type AttributeRow, type OrderRow, sortOrders } from './rules'
import { exportGroupWorkbook } from './workbook'

type Env = ImageEnvironment & { ARCHIVE: R2Bucket }
export type FactoryPackage = {
  batchId: string
  key: string
  filename: string
  orderCount: number
  rowCount: number
  units: number
  newRows: number
  skippedRows: number
  attributeRevision: number
  groups: { name: string; filename: string; rows: number; units: number }[]
}
const identity = (r: OrderRow) => JSON.stringify([r[3], r[1], r[2]])
const prefix = 'product-images/v1/pack-factory/'
const absent = () => new PublicError('NOT_FOUND', '工厂包尚未生成或已失效，请重新生成。', 404)
const conflict = () =>
  new PublicError(
    'FACTORY_QUANTITY_CONFLICT',
    '本批存在数量变化或待核对订单，核对完成前不能导出全部订单工厂包。',
    409,
  )

/** A read-only order projection. Writes only generated file caches, never the import ledger/config. */
export class PackFactoryPackages {
  private readonly labels: PackApiLabels
  private readonly picking: PickingSheets
  constructor(
    private readonly env: Env,
    outputs?: { labels: PackApiLabels; picking: PickingSheets },
  ) {
    this.labels = outputs?.labels ?? new PackApiLabels(env)
    this.picking = outputs?.picking ?? new PickingSheets(env)
  }
  private async scope(id: string) {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw absent()
    const scope = await inventoryDeviceScope(this.env.DB)
    const record = await this.env.DB.prepare(
      'SELECT scope_key,source_hash FROM pack_order_batches WHERE id=?',
    )
      .bind(id)
      .first<{ scope_key: string; source_hash: string }>()
    const key = await connectionDigest(
      JSON.stringify([scope.sellerAccountId, scope.marketplaceId, scope.warehouseCode]),
    )
    if (!record || record.scope_key !== key)
      throw new PublicError('FORBIDDEN', '本批次不属于当前 Amazon 店铺。', 403)
    return { scope, record }
  }
  async prepare(id: string): Promise<FactoryPackage> {
    const { scope, record } = await this.scope(id),
      orders = new PackOrders(this.env)
    const batch = await orders.view(id)
    if (batch.conflicts.length) throw conflict()
    const object = (await orders.source(id)).object
    if (object.size > 12_000_000) throw new PublicError('INVALID_INPUT', '原始订单文件过大。', 413)
    const source = new Uint8Array(await object.arrayBuffer())
    if ((await pdfHash(source)) !== record.source_hash)
      throw new PublicError('INVALID_INPUT', '原始订单校验失败，请检查归档。', 409)
    const { order } = await parsePackSource(source, scope.warehouseCode)
    const unique = new Map<string, OrderRow>()
    for (const row of order.rows) {
      const old = unique.get(identity(row))
      if (old && old[4] !== row[4]) throw conflict()
      unique.set(identity(row), row)
    }
    const rows = [...unique.values()]
    for (let offset = 0; offset < rows.length; offset += 100) {
      const part = rows.slice(offset, offset + 100)
      const ledger = await this.env.DB.prepare(
        'SELECT identity_key,units FROM pack_order_rows WHERE scope_key=? AND identity_key IN (SELECT value FROM json_each(?))',
      )
        .bind(record.scope_key, JSON.stringify(part.map(identity)))
        .all<{ identity_key: string; units: number }>()
      const quantities = new Map(ledger.results.map((r) => [r.identity_key, r.units]))
      if (part.some((r) => quantities.get(identity(r)) !== r[4])) throw conflict()
    }
    const config = await this.env.DB.prepare(
      'SELECT revision,rows_json,template_key FROM order_sorting_config WHERE singleton=1',
    ).first<{ revision: number; rows_json: string; template_key: string }>()
    if (!config) throw new PublicError('INVALID_INPUT', '请先配置产品属性清单和分拣模板。', 409)
    let plan
    try {
      plan = sortOrders({ date: order.date, rows }, JSON.parse(config.rows_json) as AttributeRow[])
    } catch {
      throw new PublicError('INVALID_INPUT', '产品属性分类存在冲突，请检查属性清单。', 400)
    }
    for (const group of plan.groups) checkPackLabelQuantity(group)
    const template = await this.env.ARCHIVE.get('order-sorting/assets/' + config.template_key)
    const eu = await this.env.ARCHIVE.get('product-labels/eu-rep-ceramic-80mm-v1.pdf')
    if (!template || !eu) throw new PublicError('UNAVAILABLE', '分拣或欧代模板暂时无法读取。', 503)
    const templateBytes = new Uint8Array(await template.arrayBuffer()),
      euHash = await pdfHash(new Uint8Array(await eu.arrayBuffer()))
    const key = await fileKey('pack-factory', [
      record.scope_key,
      id,
      record.source_hash,
      config.revision,
      plan,
      await pdfHash(templateBytes),
      euHash,
      'v1',
    ])
    const summary: FactoryPackage = {
      batchId: id,
      key: key.slice(prefix.length),
      filename: `Pack-${batch.date}-${id.slice(0, 8)}-全部订单工厂包.zip`,
      orderCount: new Set(rows.map((r) => r[3])).size,
      rowCount: rows.length,
      units: plan.totalUnits,
      newRows: batch.newRows,
      skippedRows: batch.skippedRows,
      attributeRevision: config.revision,
      groups: plan.groups.map((g) => ({
        name: g.name,
        filename: g.filename,
        rows: g.raw.length,
        units: g.units,
      })),
    }
    const groups = new Map(plan.groups.flatMap((g) => g.raw.map((r) => [identity(r), g.name] as const)))
    const projected: PackBatch & { exportScope: 'ALL_ORDERS'; attributeRevision: number } = {
      ...batch,
      plan,
      templateKey: config.template_key,
      exportScope: 'ALL_ORDERS',
      attributeRevision: config.revision,
      state: 'READY',
      labelSource: 'AMAZON_API',
      labels: rows.map((r, i) => ({
        rowIndex: i,
        sku: r[1],
        fnsku: r[2],
        transferId: r[3],
        units: r[4],
        group: groups.get(identity(r))!,
        filename: `row-${i + 1}.pdf`,
        received: true,
      })),
      labelGroups: plan.groups.map((g) => ({ group: g.name, ready: true })),
      pickingGroups: plan.groups.map((g) => ({ group: g.name, ready: true })),
    }
    const result = await new PrivateFileCache(this.env).getOrCreate(key, async () => {
      let inputBytes = source.byteLength
      const bounded = (bytes: Uint8Array) => {
        inputBytes += bytes.byteLength
        if (inputBytes > 24 * 1024 * 1024)
          throw new PublicError('FACTORY_TOO_LARGE', '本次工厂包图片或标签较多，请按时段分批导出。', 413)
        return bytes
      }
      const bytes = await exportPackBundle(
        projected,
        templateBytes,
        source,
        async (group) => bounded(await this.bytes(await this.labels.download(projected, group))),
        async (group) => bounded(await this.bytes(await this.picking.download(projected, group))),
        async (bytes, group, date) => {
          const { default: Workbook } = await import('exceljs/lib/doc/workbook.js')
          const book = new Workbook()
          await book.xlsx.load(bytes as never)
          return bounded(await exportGroupWorkbook(book, group, date))
        },
      )
      return {
        bytes,
        metadata: {
          type: 'application/zip',
          batchId: id,
          scope: record.scope_key,
          sourceHash: record.source_hash,
          summary: JSON.stringify(summary),
        },
      }
    })
    // Scope may have changed while fetching labels/images; never hand out another shop's file.
    await this.scope(id)
    return JSON.parse(String(result.metadata.summary)) as FactoryPackage
  }
  private async bytes(response: Response) {
    if (!response.ok) throw new PublicError('UNAVAILABLE', '标签或备货单暂未完成，请重试。', 503)
    return new Uint8Array(await response.arrayBuffer())
  }
  async download(id: string, digest: string) {
    const { record } = await this.scope(id)
    if (!/^[a-f\d]{64}$/.test(digest)) throw absent()
    const file = await new PrivateFileCache(this.env).read(prefix + digest)
    if (
      !file ||
      file.metadata.batchId !== id ||
      file.metadata.scope !== record.scope_key ||
      file.metadata.sourceHash !== record.source_hash
    )
      throw absent()
    const summary = JSON.parse(String(file.metadata.summary)) as FactoryPackage
    return new Response(file.bytes.slice().buffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="factory-package.zip"; filename*=UTF-8''${encodeURIComponent(summary.filename)}`,
      },
    })
  }
}
