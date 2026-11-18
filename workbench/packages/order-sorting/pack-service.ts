import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { parsePackSource } from './pack-source'
import { checkPackLabelQuantity } from './pack-label-limits'
import type { PackBatch, PackBatchPage, PackDevice, PackLabel } from './pack-types'
import { type AttributeRow, type OrderRow, type SortPlan, sortOrders } from './rules'

const invalid = () =>
  new PublicError('INVALID_INPUT', 'Pack 文件或参数无效，请检查文件类型、数量与大小。', 400)
const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
const missing = () => new PublicError('NOT_FOUND', '没有找到这个 Pack 批次或标签。', 404)
const unavailable = () =>
  new PublicError('UNAVAILABLE', 'Pack 归档暂时不可用，请保留原文件后重试。', 503)
const filename = (extension: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .refine(
      (name) =>
        !/[\\/]/.test(name) &&
        ![...name].some((c) => c.charCodeAt(0) < 32) &&
        name.toLowerCase().endsWith(extension),
    )
const base64 = z
  .string()
  .min(8)
  .max(16_000_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
const importSchema = z
  .object({ requestId: z.uuid(), filename: filename('.xlsx'), base64, warehouse: z.literal('A1C5') })
  .strict()
const labelSchema = z
  .object({ rowIndex: z.number().int().min(0).max(9999), filename: filename('.pdf'), base64 })
  .strict()
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw invalid()
  return result.data
}
function decode(value: string) {
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    if (bytes.length > 12_000_000 || bytes.length < 8) throw invalid()
    return bytes
  } catch {
    throw invalid()
  }
}
async function hash(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('')
}
async function scopeKey(device: PackDevice) {
  let scope: { sellerAccountId: string; marketplaceId: string; warehouseCode: string }
  try {
    scope = parse(
      z
        .object({
          sellerAccountId: z.string().min(1),
          marketplaceId: z.string().min(1),
          warehouseCode: z.literal('A1C5'),
        })
        .strict(),
      JSON.parse(device.scope_json),
    )
  } catch {
    throw new PublicError('FORBIDDEN', '设备没有此仓库的 Pack 权限。', 403)
  }
  return hash(JSON.stringify([scope.sellerAccountId, scope.marketplaceId, scope.warehouseCode]))
}
const identity = (row: OrderRow) => JSON.stringify([row[3], row[1], row[2]])
type Env = { DB: D1Database; ARCHIVE: R2Bucket }
type BatchRecord = {
  id: string
  scope_key: string
  source_hash: string
  source_key: string
  result_key: string
  filename: string
  created_at: number
}
type Config = { revision: number; rows_json: string; attribute_key: string; template_key: string }
type RequestRecord = { source_hash: string; batch_id: string }
type LabelRecord = {
  row_index: number
  sha256: string | null
  object_key: string | null
  filename: string
}

export class PackOrders {
  constructor(private readonly env: Env) {}

  private async put(key: string, value: string | Uint8Array, type: string) {
    try {
      await this.env.ARCHIVE.put(key, value, { httpMetadata: { contentType: type } })
    } catch {
      throw unavailable()
    }
  }
  private async record(id: string, scope?: string): Promise<BatchRecord> {
    const record = await this.env.DB.prepare('SELECT * FROM pack_order_batches WHERE id=?')
      .bind(id)
      .first<BatchRecord>()
    if (!record || (scope !== undefined && record.scope_key !== scope)) throw missing()
    return record
  }
  private async request(scope: string, id: string, sourceHash: string) {
    const record = await this.env.DB.prepare(
      'SELECT source_hash,batch_id FROM pack_order_requests WHERE scope_key=? AND request_id=?',
    )
      .bind(scope, id)
      .first<RequestRecord>()
    if (record && record.source_hash !== sourceHash) throw conflict('同一请求编号不能对应不同订单文件。')
    return record
  }
  private async replay(scope: string, requestId: string, sourceHash: string, exportHash: string) {
    const request = await this.request(scope, requestId, sourceHash)
    if (request) return this.view(request.batch_id)
    const batch = await this.env.DB.prepare(
      'SELECT id FROM pack_order_batches WHERE scope_key=? AND export_hash=?',
    )
      .bind(scope, exportHash)
      .first<{ id: string }>()
    if (!batch) return null
    // Each replay request gets its own immutable mapping, including other devices.
    await this.env.DB.prepare(
      'INSERT INTO pack_order_requests(scope_key,request_id,source_hash,batch_id) VALUES(?,?,?,?) ON CONFLICT(scope_key,request_id) DO NOTHING',
    )
      .bind(scope, requestId, sourceHash, batch.id)
      .run()
    const saved = await this.request(scope, requestId, sourceHash)
    return this.view(saved!.batch_id)
  }
  async import(device: PackDevice, input: unknown): Promise<PackBatch> {
    const data = parse(importSchema, input),
      scope = await scopeKey(device),
      bytes = decode(data.base64)
    if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw invalid()
    const sourceHash = await hash(bytes)
    const known = await this.request(scope, data.requestId, sourceHash)
    if (known) return this.view(known.batch_id)
    const { order, snapshot } = await parsePackSource(bytes, data.warehouse),
      exportHash = await hash(snapshot)
    const replay = await this.replay(scope, data.requestId, sourceHash, exportHash)
    if (replay) return replay
    const sourceKey = `order-sorting/pack/sources/${scope}/${sourceHash}.xlsx`
    await this.put(sourceKey, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    await this.put(
      `order-sorting/pack/sources/${scope}/${sourceHash}.json`,
      snapshot,
      'application/json',
    )
    // A losing transaction retries from the current attributes AND row ledger.
    // D1.batch is atomic: CHECK/unique failures roll back the entire attempt.
    for (let attempt = 0; attempt < 6; attempt++) {
      const replayed = await this.replay(scope, data.requestId, sourceHash, exportHash)
      if (replayed) return replayed
      const config = await this.env.DB.prepare(
        'SELECT * FROM order_sorting_config WHERE singleton=1',
      ).first<Config>()
      if (!config) throw conflict('请先由管理员导入产品属性清单和分拣模板。')
      const keys = [...new Set(order.rows.map(identity))],
        previous = new Map<string, number>()
      for (let start = 0; start < keys.length; start += 100) {
        const records = await this.env.DB.prepare(
          'SELECT identity_key,units FROM pack_order_rows WHERE scope_key=? AND identity_key IN (SELECT value FROM json_each(?))',
        )
          .bind(scope, JSON.stringify(keys.slice(start, start + 100)))
          .all<{ identity_key: string; units: number }>()
        for (const record of records.results) previous.set(record.identity_key, record.units)
      }
      const variants = new Map<string, Set<number>>()
      for (const row of order.rows) {
        const key = identity(row),
          quantities = variants.get(key) ?? new Set<number>()
        quantities.add(row[4])
        variants.set(key, quantities)
      }
      const conflicts: PackBatch['conflicts'] = [],
        fresh: { row: OrderRow; rowIndex: number }[] = []
      let skippedRows = 0
      const seen = new Set<string>()
      order.rows.forEach((row, rowIndex) => {
        const key = identity(row),
          old = previous.get(key)
        if ((old !== undefined && old !== row[4]) || variants.get(key)!.size > 1) {
          conflicts.push({
            rowIndex,
            sku: row[1],
            fnsku: row[2],
            transferId: row[3],
            previousUnits: old ?? [...variants.get(key)!].find((q) => q !== row[4])!,
            units: row[4],
          })
        } else if (old !== undefined || seen.has(key)) skippedRows++
        else {
          fresh.push({ row, rowIndex })
          seen.add(key)
        }
      })
      let plan: SortPlan | null = null
      try {
        if (fresh.length)
          plan = sortOrders(
            { date: order.date, rows: fresh.map((r) => r.row) },
            JSON.parse(config.rows_json) as AttributeRow[],
          )
      } catch {
        throw new PublicError(
          'INVALID_INPUT',
          '当前属性清单存在分类冲突或无效分类名称，请在 ERP 检查后重试。',
          400,
        )
      }
      for (const group of plan?.groups ?? []) checkPackLabelQuantity(group)
      const rowsJson = plan ? JSON.stringify(plan.attributes) : config.rows_json
      if (new TextEncoder().encode(rowsJson).length > 900_000) throw invalid()
      const grouped = new Map<string, string>()
      for (const group of plan?.groups ?? [])
        for (const row of group.raw) grouped.set(identity(row), group.name)
      const labels: PackLabel[] = fresh.map(({ row, rowIndex }) => ({
        rowIndex,
        sku: row[1],
        fnsku: row[2],
        transferId: row[3],
        units: row[4],
        group: grouped.get(identity(row))!,
        filename: `row-${rowIndex + 1}.pdf`,
        received: false,
      }))
      const id = crypto.randomUUID(),
        now = Date.now()
      const result: PackBatch = {
        id,
        createdAt: now,
        filename: data.filename,
        date: order.date,
        state: fresh.length ? 'LABELS_PENDING' : 'NO_NEW',
        totalRows: order.rows.length,
        newRows: fresh.length,
        skippedRows,
        conflicts,
        plan,
        templateKey: config.template_key,
        labels,
        sourceHash,
      }
      const resultKey = `order-sorting/pack/batches/${id}/result.json`
      await this.put(resultKey, JSON.stringify(result), 'application/json')
      const statements = [
        this.env.DB.prepare(
          `INSERT INTO pack_order_batches(id,scope_key,export_hash,source_hash,source_key,result_key,filename,created_at,guard) VALUES(?,?,?,?,?,?,?,?,CASE WHEN (SELECT revision FROM order_sorting_config WHERE singleton=1)=? THEN 1 ELSE 0 END)`,
        ).bind(
          id,
          scope,
          exportHash,
          sourceHash,
          sourceKey,
          resultKey,
          data.filename,
          now,
          config.revision,
        ),
      ]
      if (plan) {
        statements.push(
          this.env.DB.prepare(
            `INSERT INTO order_sorting_versions(revision,rows_json,attribute_key,template_key,actor,created_at,guard) VALUES(?,?,?,?,?,?,CASE WHEN (SELECT revision FROM order_sorting_config WHERE singleton=1)=? THEN 1 ELSE 0 END)`,
          ).bind(
            config.revision + 1,
            rowsJson,
            config.attribute_key,
            config.template_key,
            `pack-device:${device.id}`,
            now,
            config.revision,
          ),
        )
        statements.push(
          this.env.DB.prepare(
            'UPDATE order_sorting_config SET revision=?,rows_json=?,updated_at=? WHERE singleton=1 AND revision=?',
          ).bind(config.revision + 1, rowsJson, now, config.revision),
        )
      }
      statements.push(
        this.env.DB.prepare(
          'INSERT INTO pack_order_requests(scope_key,request_id,source_hash,batch_id) VALUES(?,?,?,?)',
        ).bind(scope, data.requestId, sourceHash, id),
      )
      for (const { row, rowIndex } of fresh) {
        statements.push(
          this.env.DB.prepare(
            'INSERT INTO pack_order_rows(scope_key,identity_key,units,batch_id,row_index) VALUES(?,?,?,?,?)',
          ).bind(scope, identity(row), row[4], id, rowIndex),
        )
        statements.push(
          this.env.DB.prepare(
            'INSERT INTO pack_order_labels(batch_id,row_index,filename) VALUES(?,?,?)',
          ).bind(id, rowIndex, `row-${rowIndex + 1}.pdf`),
        )
      }
      try {
        await this.env.DB.batch(statements)
        return result
      } catch {
        // A replay may have won while this import was preparing its archive.
        const saved = await this.replay(scope, data.requestId, sourceHash, exportHash)
        if (saved) return saved
      }
    }
    throw conflict('订单或属性清单正在更新，本次尚未提交，请重试同一请求。')
  }
  async get(device: PackDevice, id: string): Promise<PackBatch> {
    return this.read(await this.record(id, await scopeKey(device)))
  }
  private async read(record: BatchRecord): Promise<PackBatch> {
    let result: PackBatch
    try {
      const object = await this.env.ARCHIVE.get(record.result_key)
      if (!object) throw unavailable()
      result = await object.json<PackBatch>()
    } catch {
      throw unavailable()
    }
    const received = await this.env.DB.prepare(
      'SELECT row_index,sha256,filename FROM pack_order_labels WHERE batch_id=?',
    )
      .bind(record.id)
      .all<LabelRecord>()
    const slots = new Map(received.results.map((row) => [row.row_index, row]))
    result.labels = result.labels.map((label) => ({
      ...label,
      received: Boolean(slots.get(label.rowIndex)?.sha256),
      filename: slots.get(label.rowIndex)?.filename ?? label.filename,
    }))
    result.state =
      result.newRows === 0
        ? 'NO_NEW'
        : result.labels.every((label) => label.received)
          ? 'READY'
          : 'LABELS_PENDING'
    return result
  }
  async view(id: string): Promise<PackBatch> {
    return this.read(await this.record(id))
  }
  async list(input: unknown = null): Promise<PackBatchPage> {
    const cursor = parse(
      z.object({ time: z.number().int().nonnegative(), id: z.uuid() }).strict().nullable(),
      input,
    )
    const query = this.env.DB.prepare(
      `SELECT * FROM pack_order_batches ${cursor ? 'WHERE created_at < ? OR (created_at = ? AND id < ?)' : ''} ORDER BY created_at DESC,id DESC LIMIT 101`,
    )
    const records = await (cursor
      ? query.bind(cursor.time, cursor.time, cursor.id)
      : query
    ).all<BatchRecord>()
    const page = records.results.slice(0, 100),
      last = page.at(-1)
    return {
      batches: await Promise.all(page.map((record) => this.read(record))),
      next: records.results.length > 100 && last ? { time: last.created_at, id: last.id } : null,
    }
  }
  async source(id: string) {
    const record = await this.record(id)
    try {
      const object = await this.env.ARCHIVE.get(record.source_key)
      if (!object) throw unavailable()
      return { name: record.filename, object }
    } catch {
      throw unavailable()
    }
  }
  async label(device: PackDevice, id: string, input: unknown): Promise<PackBatch> {
    const data = parse(labelSchema, input),
      record = await this.record(id, await scopeKey(device))
    const slot = await this.env.DB.prepare(
      'SELECT * FROM pack_order_labels WHERE batch_id=? AND row_index=?',
    )
      .bind(id, data.rowIndex)
      .first<LabelRecord>()
    if (!slot) throw missing()
    const bytes = decode(data.base64)
    if (
      bytes.length < 32 ||
      !/^%PDF-\d\.\d/.test(new TextDecoder().decode(bytes.slice(0, 8))) ||
      !new TextDecoder().decode(bytes.slice(-1024)).includes('%%EOF')
    )
      throw invalid()
    try {
      const { PDFDocument } = await import('pdf-lib')
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
      if (pdf.isEncrypted || pdf.getPageCount() < 1) throw invalid()
    } catch {
      throw invalid()
    }
    const sha = await hash(bytes)
    if (slot.sha256 && slot.sha256 !== sha) throw conflict('此行已保存不同标签，不能覆盖原始标签。')
    if (!slot.sha256) {
      // Content-addressed objects make concurrent uploads unable to overwrite
      // the winning file, even before the database CAS chooses a winner.
      const key = `order-sorting/pack/batches/${id}/labels/${data.rowIndex}/${sha}.pdf`
      await this.put(key, bytes, 'application/pdf')
      await this.env.DB.prepare(
        'UPDATE pack_order_labels SET sha256=?,object_key=?,filename=? WHERE batch_id=? AND row_index=? AND sha256 IS NULL',
      )
        .bind(sha, key, data.filename, id, data.rowIndex)
        .run()
      const saved = await this.env.DB.prepare(
        'SELECT sha256 FROM pack_order_labels WHERE batch_id=? AND row_index=?',
      )
        .bind(id, data.rowIndex)
        .first<{ sha256: string }>()
      if (saved?.sha256 !== sha) throw conflict('此行已保存不同标签，不能覆盖原始标签。')
    }
    return this.read(record)
  }
  async labelFile(id: string, rowIndex: number) {
    await this.record(id)
    const label = await this.env.DB.prepare(
      'SELECT * FROM pack_order_labels WHERE batch_id=? AND row_index=?',
    )
      .bind(id, rowIndex)
      .first<LabelRecord>()
    if (!label?.object_key) throw missing()
    try {
      const object = await this.env.ARCHIVE.get(label.object_key)
      if (!object) throw unavailable()
      return { name: label.filename, object }
    } catch {
      throw unavailable()
    }
  }
}
