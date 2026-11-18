import { z } from 'zod'
import { type ConnectionBindings, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'

export const sourceMarket = 'ATVPDKIKX0DER'
export type SourceIdentity = { seller: string; revision: string }
export async function sourceConnection(env: ConnectionBindings, expected?: SourceIdentity) {
  const seller = (
    await env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
      seller: string
    }>()
  )?.seller
  if (!seller) throw new Error('SOURCE_SELLER_NOT_CONFIGURED')
  const provider = await providerCredentials(env, 'amazon')
  const c = provider.credentials
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([provider.revision, c.SP_CLIENT_ID, c.SP_CLIENT_SECRET, c.SP_REFRESH_TOKEN]),
    ),
  )
  const revision = Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
  const identity = { seller, revision }
  if (expected && (seller !== expected.seller || revision !== expected.revision))
    throw new Error('SOURCE_CONNECTION_CHANGED')
  return { identity, credentials: c }
}
export const sourceErrorCode = (error: unknown, fallback = 'SOURCE_SYNC_FAILED') =>
  error instanceof Error && /^SOURCE_[A-Z0-9_]{1,130}$/.test(error.message) ? error.message : fallback
// Amazon contracts checked November 2026:
// https://developer-docs.amazon/sp-api/lang-en_EN/docs/report-type-values-fba
// https://developer-docs.amazon/sp-api/lang-us/docs/report-type-values-inventory
// https://developer-docs.amazon/sp-api/lang-en_EN/docs/verify-that-report-processing-is-complete
// https://developer-docs.amazon/sp-api/reference/getreportdocument
export const reportTypes = {
  inventory: 'GET_FBA_MYI_ALL_INVENTORY_DATA',
  listings: 'GET_MERCHANT_LISTINGS_ALL_DATA',
} as const
export type ReportPart = keyof typeof reportTypes
export interface SourceRow {
  sku: string
  fnsku?: string
  sellable?: number | null
  status?: string
  statusRaw?: string | null
  createdAt?: number | null
}
export type SourceReportCoverage = {
  rows: number
  scopedRows: number
  excludedUnknownScope: number
  excludedOtherStore: number
  excludedSku: number
  sourceCharset?: string
}
export const sourceReportCoverage = (): SourceReportCoverage => ({
  rows: 0,
  scopedRows: 0,
  excludedUnknownScope: 0,
  excludedOtherStore: 0,
  excludedSku: 0,
})
export const sourceChannel = (sku: string) =>
  /j1t/i.test(sku) ? 'J1T' : /jit/i.test(sku) ? 'JIT' : null

/** User-confirmed authority: Amazon API sellable quantity; page parity is not a prerequisite. */
export function sourceDecision(
  row: {
    sku: string
    sellable: number | null
    status: string
    ordered: boolean | null
    createdAt: number | null
    newListing?: boolean
  },
  activatedAt: number,
  observedAt = Date.now(),
) {
  const channel = sourceChannel(row.sku)
  let hold = 'SIMULATION_ONLY',
    candidateQuantity = 0
  if (!channel) hold = 'OUTSIDE_SCOPE'
  else if (['banned', 'stopped', 'closed', 'suppressed'].includes(row.status)) hold = 'LISTING_BLOCKED'
  else if (!['active', 'out_of_stock', 'new'].includes(row.status)) hold = 'LISTING_STATUS_UNKNOWN'
  else if (row.createdAt !== null && row.createdAt > observedAt) hold = 'FUTURE_CREATION_TIME'
  else if (row.sellable === null) hold = 'SOURCE_STOCK_UNKNOWN'
  else if (row.sellable >= 5) hold = 'TARGET_MET'
  else if (row.ordered === true) candidateQuantity = 5 - row.sellable
  else if (
    row.newListing ||
    (row.createdAt !== null &&
      row.createdAt <= observedAt &&
      row.createdAt >= activatedAt - 7 * 86400000)
  ) {
    candidateQuantity = Math.max(0, 2 - row.sellable)
    if (!candidateQuantity) hold = 'TARGET_MET'
  } else hold = row.sellable === 0 ? 'ZERO_ELIGIBILITY_UNKNOWN' : 'ELIGIBILITY_UNKNOWN'
  return {
    channel,
    candidateQuantity,
    candidateEligible: candidateQuantity > 0,
    stockAuthority: 'AMAZON_SP_API' as const,
    hold,
    // Source authority does not enable real uploads during integration testing.
    executionEligible: false as const,
  }
}

/** TSV stream parser: bounded memory and strict shape; quotes are literal in Amazon flat reports. */
export async function* parseReport(
  body: ReadableStream<Uint8Array>,
  kind: ReportPart,
  coverage = sourceReportCoverage(),
): AsyncGenerator<SourceRow> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '',
    header: string[] | undefined
  const parse = (line: string): SourceRow | null => {
    const fields = line.replace(/\r$/, '').split('\t')
    if (!header) {
      header = fields.map((s) => s.replace(/^\ufeff/, '').trim())
      const required =
        kind === 'inventory'
          ? ['sku', 'afn-fulfillable-quantity', 'store']
          : ['seller-sku', 'status', 'open-date']
      if (new Set(header).size !== header.length || required.some((s) => !header!.includes(s)))
        throw new Error('SOURCE_REPORT_HEADER_INVALID')
      return null
    }
    if (!line.trim()) return null
    coverage.rows++
    if (fields.length !== header.length) throw new Error('SOURCE_REPORT_ROW_INVALID')
    const get = (key: string) => fields[header!.indexOf(key)] ?? ''
    const sku = get(kind === 'inventory' ? 'sku' : 'seller-sku')
    if (!sku || sku.trim() !== sku || sku.length > 512) throw new Error('SOURCE_SKU_INVALID')
    if (!sourceChannel(sku)) {
      coverage.excludedSku++
      return null
    }
    if (kind === 'inventory') {
      // Amazon can repeat the same SKU across MAIN and Low-Cost Store. These are distinct
      // populations, never quantities to sum or overwrite. Fail if the scope itself is absent.
      if (!get('store')) {
        coverage.excludedUnknownScope++
        return null
      }
      if (get('store') !== 'Low-Cost Store') {
        coverage.excludedOtherStore++
        return null
      }
      const n = get('afn-fulfillable-quantity')
      if (n && (!/^\d+$/.test(n) || !Number.isSafeInteger(Number(n))))
        throw new Error('SOURCE_QUANTITY_INVALID')
      coverage.scopedRows++
      const fnsku = get('fnsku').trim()
      return { sku, sellable: n === '' ? null : Number(n), ...(/^[A-Z0-9]{10}$/.test(fnsku) ? { fnsku } : {}) }
    }
    const raw = get('status'),
      status = raw.toLowerCase()
    // Inactive is ambiguous (out of stock, blocked, closed...); never infer safety.
    const normalized = ['active', 'suppressed', 'closed', 'banned', 'stopped'].includes(status)
      ? status
      : 'unknown'
    const date = get('open-date')
    // Amazon open-date is retained as report listing-open evidence, not first observation.
    // Reject timezone-free dates rather than silently interpreting them in the worker timezone.
    const time = /(?:Z|[+-]\d{2}:?\d{2}|PST|PDT|UTC|GMT)$/.test(date.trim()) ? Date.parse(date) : NaN
    coverage.scopedRows++
    return {
      sku,
      status: normalized,
      statusRaw: raw || null,
      createdAt: Number.isFinite(time) && time >= 0 ? time : null,
    }
  }
  try {
    for (;;) {
      const next = await reader.read()
      buffer += decoder.decode(next.value, { stream: !next.done })
      let end = buffer.indexOf('\n')
      while (end !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const row = parse(line)
        if (row) yield row
        end = buffer.indexOf('\n')
      }
      if (buffer.length > 2_000_000) throw new Error('SOURCE_REPORT_LINE_TOO_LARGE')
      if (next.done) break
    }
    if (buffer) {
      const row = parse(buffer)
      if (row) yield row
    }
    if (!header) throw new Error('SOURCE_REPORT_EMPTY')
  } finally {
    reader.releaseLock()
  }
}

export class SourceStore {
  constructor(readonly db: D1Database) {}
  async begin(
    id: string,
    seller: string,
    started: number,
    activated: number,
    through: number,
    from = activated - 7 * 86400000,
  ) {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO inventory_source_runs(id,seller,started_at,activated_at,order_from,order_through) VALUES(?,?,?,?,?,?)`,
      )
      .bind(id, seller, started, activated, Math.max(0, from), through)
      .run()
  }
  async stage(id: string, kind: ReportPart, rows: SourceRow[], chunk: number) {
    if (rows.length > 500) throw new Error('SOURCE_CHUNK_TOO_LARGE')
    if (!rows.length) return
    const col = kind === 'inventory' ? 'inventory_chunk' : 'listings_chunk'
    const updates =
      kind === 'inventory'
        ? 'sellable=excluded.sellable'
        : 'created_at=excluded.created_at,listing_status=excluded.listing_status,listing_status_raw=excluded.listing_status_raw,creation_source=excluded.creation_source'
    const stage = this.db
      .prepare(`INSERT INTO inventory_source_rows(generation,sku,channel,sellable,created_at,listing_status,listing_status_raw,creation_source,${col})
      SELECT ?,json_extract(value,'$.sku'),CASE WHEN instr(upper(json_extract(value,'$.sku')),'J1T')>0 THEN 'J1T' ELSE 'JIT' END,
      json_extract(value,'$.sellable'),json_extract(value,'$.createdAt'),coalesce(json_extract(value,'$.status'),'unknown'),json_extract(value,'$.statusRaw'),
      CASE WHEN json_extract(value,'$.createdAt') IS NOT NULL THEN 'ALL_LISTINGS_OPEN_DATE' END,?
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM inventory_source_runs WHERE id=? AND state='RUNNING')
      ON CONFLICT(generation,sku) DO UPDATE SET ${updates},${col}=excluded.${col}
      WHERE inventory_source_rows.${col} IS NULL OR inventory_source_rows.${col}=excluded.${col}`)
      .bind(id, chunk, JSON.stringify(rows), id)
    const labels = kind === 'inventory' ? this.fnskuIndex(id, rows, false) : null
    if (labels) await this.db.batch([stage, labels])
    else await stage.run()
  }
  fnskuIndex(id: string, rows: SourceRow[], current: boolean) {
    const mappings = rows.filter(row => row.fnsku)
    if (!mappings.length) return null
    if (mappings.length > 500) throw new Error('SOURCE_CHUNK_TOO_LARGE')
    return this.db.prepare(`INSERT OR IGNORE INTO inventory_source_fnskus(generation,sku,fnsku)
      SELECT ?,json_extract(j.value,'$.sku'),json_extract(j.value,'$.fnsku')
      FROM json_each(?) j WHERE EXISTS(SELECT 1 FROM inventory_source_rows r
        WHERE r.generation=? AND r.sku=json_extract(j.value,'$.sku') COLLATE BINARY AND r.inventory_chunk IS NOT NULL)
      AND EXISTS(SELECT 1 FROM inventory_source_runs s WHERE s.id=? AND
        ((?=0 AND s.state='RUNNING') OR (?=1 AND s.state='COMPLETE'
          AND EXISTS(SELECT 1 FROM inventory_source_current c WHERE c.seller=s.seller AND c.generation=s.id))))`)
      .bind(id,JSON.stringify(mappings.map(({sku,fnsku})=>({sku,fnsku}))),id,id,+current,+current)
  }
  async ordered(id: string, skus: string[], evidence: string) {
    const selected = [...new Set(skus.filter((s) => sourceChannel(s)))]
    if (!selected.length) return
    await this.db
      .prepare(`INSERT INTO inventory_source_rows(generation,sku,channel,ordered,ordered_evidence)
      SELECT ?,value,CASE WHEN instr(upper(value),'J1T')>0 THEN 'J1T' ELSE 'JIT' END,1,? FROM json_each(?)
      WHERE EXISTS(SELECT 1 FROM inventory_source_runs WHERE id=? AND state='RUNNING')
      ON CONFLICT(generation,sku) DO UPDATE SET ordered=1,ordered_evidence=excluded.ordered_evidence`)
      .bind(id, evidence, JSON.stringify(selected), id)
      .run()
  }
  async completePart(
    id: string,
    part: ReportPart | 'orders',
    report: string | null,
    count: number,
    sourceAt: string | null = null,
    coverage: SourceReportCoverage | null = null,
  ) {
    if (part !== 'orders') {
      const actual = await this.db
        .prepare(
          `SELECT count(*) n FROM inventory_source_rows WHERE generation=? AND ${part === 'inventory' ? 'inventory' : 'listings'}_chunk IS NOT NULL`,
        )
        .bind(id)
        .first<{ n: number }>()
      if (actual?.n !== count) throw new Error('SOURCE_REPORT_COUNT_MISMATCH')
    }
    await this.db
      .prepare(
        `UPDATE inventory_source_runs SET ${part}_status='COMPLETE',${part}_count=?${part === 'orders' ? '' : `,${part}_report=?,${part}_source_at=?,${part}_coverage=?`} WHERE id=? AND state='RUNNING'`,
      )
      .bind(
        ...(part === 'orders'
          ? [count, id]
          : [count, report, sourceAt, coverage ? JSON.stringify(coverage) : null, id]),
      )
      .run()
  }
  async publish(id: string) {
    const run = await this.db
      .prepare('SELECT * FROM inventory_source_runs WHERE id=?')
      .bind(id)
      .first<SourceRun>()
    if (run?.state === 'COMPLETE') return
    if (
      !run ||
      run.state !== 'RUNNING' ||
      [run.inventory_status, run.listings_status, run.orders_status].some((s) => s !== 'COMPLETE')
    )
      throw new Error('SOURCE_SNAPSHOT_INCOMPLETE')
    const guard = `EXISTS(SELECT 1 FROM inventory_source_runs WHERE id=? AND state='RUNNING' AND inventory_status='COMPLETE' AND listings_status='COMPLETE' AND orders_status='COMPLETE')`
    await this.db.batch([
      this.db
        .prepare(`UPDATE inventory_source_rows SET
        ordered=CASE WHEN ordered=1 OR EXISTS(SELECT 1 FROM inventory_source_qualifications q WHERE q.seller=? AND q.sku=inventory_source_rows.sku AND q.ordered_generation IS NOT NULL) THEN 1 END,
        new_listing=CASE WHEN (created_at>=? AND created_at<=?) OR EXISTS(SELECT 1 FROM inventory_source_qualifications q WHERE q.seller=? AND q.sku=inventory_source_rows.sku AND q.new_generation IS NOT NULL) THEN 1 ELSE 0 END
        WHERE generation=? AND ${guard}`)
        .bind(run.seller, run.activated_at - 7 * 86400000, run.started_at, run.seller, id, id),
      this.db
        .prepare(`INSERT INTO inventory_source_qualifications(seller,sku,ordered_generation,new_generation)
        SELECT ?,sku,CASE WHEN ordered=1 THEN ? END,CASE WHEN new_listing=1 THEN ? END FROM inventory_source_rows WHERE generation=? AND (ordered=1 OR new_listing=1) AND ${guard}
        ON CONFLICT(seller,sku) DO UPDATE SET ordered_generation=coalesce(inventory_source_qualifications.ordered_generation,excluded.ordered_generation),new_generation=coalesce(inventory_source_qualifications.new_generation,excluded.new_generation)`)
        .bind(run.seller, id, id, id, id),
      this.db
        .prepare(`INSERT INTO inventory_source_current(seller,generation,published_at) SELECT ?,?,? WHERE ${guard}
        ON CONFLICT(seller) DO UPDATE SET generation=excluded.generation,published_at=excluded.published_at
        WHERE inventory_source_current.published_at<=excluded.published_at`)
        .bind(run.seller, id, run.started_at, id),
      this.db
        .prepare(
          `UPDATE inventory_source_runs SET state='COMPLETE',finished_at=? WHERE id=? AND ${guard}`,
        )
        .bind(Date.now(), id, id),
    ])
  }
  async fail(id: string, error: unknown = null) {
    await this.db
      .prepare(
        "UPDATE inventory_source_runs SET state='FAILED',finished_at=?,error=? WHERE id=? AND state='RUNNING'",
      )
      .bind(Date.now(), sourceErrorCode(error), id)
      .run()
  }
  /** Bounded row-only retention after a successful publication. Metadata and positive evidence survive. */
  async prune(publishedId: string, limit = 5000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new Error('SOURCE_PRUNE_LIMIT_INVALID')
    const result = await this.db
      .prepare(`DELETE FROM inventory_source_rows WHERE rowid IN (
      SELECT rows.rowid FROM inventory_source_rows rows JOIN inventory_source_runs old ON old.id=rows.generation
      JOIN inventory_source_runs published ON published.id=? AND published.state='COMPLETE' AND published.seller=old.seller
      WHERE old.state<>'RUNNING' AND old.started_at<=published.started_at
      AND old.id NOT IN (SELECT generation FROM inventory_source_current WHERE seller=published.seller)
      AND old.id NOT IN (SELECT id FROM inventory_source_runs WHERE seller=published.seller AND state='COMPLETE' ORDER BY started_at DESC,id DESC LIMIT 2)
      LIMIT ?
    )`)
      .bind(publishedId, limit)
      .run()
    return result.meta.changes
  }
}

/** R2 requires known lengths. A decompressor emits unknown-length streams, so use bounded
 * 5 MiB byte-array parts; final publication is atomic after the stream successfully ends.
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ */
export async function archiveReportStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  sourceCharset = 'utf-8',
) {
  const size = 5 * 1024 * 1024,
    reader = stream.getReader(),
    parts: R2UploadedPart[] = []
  let buffer = new Uint8Array(size),
    used = 0,
    upload: R2MultipartUpload | undefined
  const metadata = {
    httpMetadata: { contentType: 'text/tab-separated-values; charset=utf-8' },
    customMetadata: { sourceCharset, archiveCharset: 'utf-8' },
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      let offset = 0
      while (offset < next.value.length) {
        const length = Math.min(size - used, next.value.length - offset)
        buffer.set(next.value.subarray(offset, offset + length), used)
        used += length
        offset += length
        if (used === size) {
          upload ??= await bucket.createMultipartUpload(key, metadata)
          parts.push(await upload.uploadPart(parts.length + 1, buffer))
          buffer = new Uint8Array(size)
          used = 0
          if (parts.length >= 1000) throw new Error('SOURCE_REPORT_SIZE_LIMIT')
        }
      }
    }
    if (upload) {
      if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)))
      await upload.complete(parts)
    } else await bucket.put(key, buffer.subarray(0, used), metadata)
  } catch (error) {
    if (upload) await upload.abort().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

/** Honor Amazon's declared encoding. WHATWG CP1252 aliases normalize to windows-1252.
 * https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/#2022-02-25 */
export function normalizeReportStream(body: ReadableStream<Uint8Array>, contentType: string | null) {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType ?? '')
  let decoder: TextDecoder
  try {
    if (!match && /charset\s*=/i.test(contentType ?? '')) throw new Error()
    decoder = new TextDecoder(match ? (match[1] ?? match[2] ?? match[3]) : 'utf-8', { fatal: true })
  } catch {
    throw new Error('SOURCE_REPORT_CHARSET_UNSUPPORTED')
  }
  if (!['utf-8', 'windows-1252'].includes(decoder.encoding))
    throw new Error('SOURCE_REPORT_CHARSET_UNSUPPORTED')
  const encoder = new TextEncoder()
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          const text = decoder.decode(chunk, { stream: true })
          if (text) controller.enqueue(encoder.encode(text))
        } catch {
          throw new Error('SOURCE_REPORT_DECODE_FAILED')
        }
      },
      flush(controller) {
        try {
          const text = decoder.decode()
          if (text) controller.enqueue(encoder.encode(text))
        } catch {
          throw new Error('SOURCE_REPORT_DECODE_FAILED')
        }
      },
    }),
  )
  return { stream, sourceCharset: decoder.encoding }
}
export interface SourceRun {
  id: string
  seller: string
  started_at: number
  activated_at: number
  order_from: number
  order_through: number
  state: string
  inventory_status: string
  listings_status: string
  orders_status: string
}

export async function inventorySourceSettings(db: D1Database) {
  const row = await db
    .prepare(
      'SELECT enabled,mode,interval_minutes AS intervalMinutes,activated_at AS activatedAt FROM inventory_source_settings WHERE singleton=1',
    )
    .first<{ enabled: number; mode: 'READ_ONLY'; intervalMinutes: number; activatedAt: number | null }>()
  return row
    ? { ...row, enabled: !!row.enabled }
    : { enabled: false, mode: 'READ_ONLY' as const, intervalMinutes: 60, activatedAt: null }
}
export async function configureInventorySource(
  db: D1Database,
  role: string,
  input: unknown,
  now = Date.now(),
) {
  if (role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以修改巡检设置。', 403)
  const value = z
    .object({
      enabled: z.boolean(),
      mode: z.literal('READ_ONLY').default('READ_ONLY'),
      intervalMinutes: z.number().int().min(5).max(10080).default(60),
    })
    .strict()
    .parse(input)
  await db
    .prepare(
      `UPDATE inventory_source_settings SET enabled=?,interval_minutes=?,activated_at=CASE WHEN ?=1 THEN coalesce(activated_at,?) ELSE activated_at END,updated_at=? WHERE singleton=1`,
    )
    .bind(+value.enabled, value.intervalMinutes, +value.enabled, now, now)
    .run()
  return inventorySourceSettings(db)
}
export async function inventorySourceStatus(db: D1Database) {
  const settings = await inventorySourceSettings(db)
  const latest = await db
    .prepare(
      `SELECT * FROM inventory_source_runs WHERE seller=(SELECT seller FROM title_audit_store WHERE singleton=1) ORDER BY started_at DESC LIMIT 1`,
    )
    .first()
  const current = await db
    .prepare(
      `SELECT r.* FROM inventory_source_current c JOIN inventory_source_runs r ON r.id=c.generation WHERE c.seller=(SELECT seller FROM title_audit_store WHERE singleton=1)`,
    )
    .first()
  return {
    settings,
    latest,
    current,
    stockScope: 'FBA_LOW_COST_STORE',
    stockAuthority: 'AMAZON_SP_API',
    executionEnabled: false,
    coverage: {
      inventory: 'FBA all-inventory report, exact Low-Cost Store rows only; not SellerFlex bins',
      listings: 'All-listings report; inactive status remains unknown; open-date evidence only',
      orders:
        'Positive AMAZON_HAUL orders since activation minus 7 days, then overlapping cursor; absence is unknown',
    },
  }
}

/** Keyset pagination in J1T-first order. Never exposes staging or failed generation rows. */
export async function inventorySourceCandidates(db: D1Database, input: unknown = {}) {
  const options = z
    .object({
      limit: z.number().int().min(1).max(200).default(50),
      after: z.object({ channel: z.enum(['J1T', 'JIT']), sku: z.string().min(1).max(512) }).optional(),
    })
    .strict()
    .parse(input)
  const current = await db
    .prepare(
      `SELECT r.* FROM inventory_source_current c JOIN inventory_source_runs r ON r.id=c.generation WHERE c.seller=(SELECT seller FROM title_audit_store WHERE singleton=1) AND r.state='COMPLETE'`,
    )
    .first<
      SourceRun & {
        inventory_report: string | null
        inventory_source_at: string | null
        listings_report: string | null
        listings_source_at: string | null
      }
    >()
  if (!current) return { generation: null, rows: [], next: null }
  const after = options.after
  const result = await db
    .prepare(
      `SELECT r.sku,r.channel,r.sellable,r.created_at AS createdAt,r.listing_status AS status,r.listing_status_raw AS statusRaw,
      CASE WHEN r.ordered=1 OR q.ordered_generation IS NOT NULL OR h.sku IS NOT NULL THEN 1 END AS ordered,
      CASE WHEN r.new_listing=1 OR q.new_generation IS NOT NULL THEN 1 ELSE 0 END AS newListing,
      r.stock_source AS stockSource,r.creation_source AS creationSource,COALESCE(r.ordered_evidence,q.ordered_generation,h.evidence_run) AS orderedEvidence
      FROM inventory_source_rows r LEFT JOIN inventory_source_qualifications q ON q.seller=? AND q.sku=r.sku
      LEFT JOIN (SELECT q.seller,q.sku,q.evidence_run FROM inventory_order_history_qualifications q JOIN inventory_order_history_runs h ON h.id=q.evidence_run AND h.seller=q.seller AND h.state='COMPLETE') h ON h.seller=? AND h.sku=r.sku
      WHERE r.generation=? ${after ? 'AND (r.channel>? OR (r.channel=? AND r.sku>?))' : ''} ORDER BY r.channel,r.sku LIMIT ?`,
    )
    .bind(
      current.seller,
      current.seller,
      current.id,
      ...(after ? [after.channel, after.channel, after.sku] : []),
      options.limit + 1,
    )
    .all<{
      sku: string
      channel: 'J1T' | 'JIT'
      sellable: number | null
      createdAt: number | null
      status: string
      statusRaw: string | null
      ordered: 1 | null
      newListing: 0 | 1
      stockSource: string
      creationSource: string | null
      orderedEvidence: string | null
    }>()
  const more = result.results.length > options.limit,
    rows = result.results.slice(0, options.limit).map((row) => {
      const value = { ...row, ordered: row.ordered === 1 ? true : null, newListing: !!row.newListing }
      return {
        ...value,
        ...sourceDecision(value, current.activated_at, current.started_at),
        generation: current.id,
        observedAt: current.started_at,
        inventoryReport: current.inventory_report,
        inventorySourceAt: current.inventory_source_at,
        listingsReport: current.listings_report,
        listingsSourceAt: current.listings_source_at,
      }
    })
  const last = rows.at(-1)
  return {
    generation: current.id,
    rows,
    next: more && last ? { channel: last.channel, sku: last.sku } : null,
  }
}

/** Reports-only client. No inventory, listing, feed, or SellerFlex write endpoints exist here. */
export class AmazonSourceClient {
  private token: { value: string; expires: number } | undefined
  constructor(
    private env: ConnectionBindings,
    private request: typeof fetch = (input, init) => fetch(input, init),
    private expected?: SourceIdentity,
  ) {}
  private async json(
    path: string,
    body?: unknown,
    service: 'reports' | 'fba' = 'reports',
  ): Promise<Record<string, unknown>> {
    try {
      const c = this.expected
        ? (await sourceConnection(this.env, this.expected)).credentials
        : (await providerCredentials(this.env, 'amazon')).credentials
      if (!this.token || this.token.expires <= Date.now()) {
        if (!c.SP_CLIENT_ID || !c.SP_CLIENT_SECRET || !c.SP_REFRESH_TOKEN) throw new Error('credentials')
        const auth = await this.request('https://api.amazon.com/auth/o2/token', {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: c.SP_CLIENT_ID,
            client_secret: c.SP_CLIENT_SECRET,
            refresh_token: c.SP_REFRESH_TOKEN,
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        })
        if (!auth.ok) throw new Error('SOURCE_AMAZON_REQUEST_FAILED_LWA_HTTP_' + auth.status)
        const raw = (await auth.json()) as { access_token?: string; expires_in?: number }
        if (!raw.access_token) throw new Error('auth')
        this.token = {
          value: raw.access_token,
          expires: Date.now() + Math.max(0, (raw.expires_in ?? 300) - 60) * 1000,
        }
      }
      const response = await this.request(
        'https://sellingpartnerapi-na.amazon.com/' +
          (service === 'reports' ? 'reports/2021-06-30/' : 'fba/inventory/v1/') +
          path,
        {
          method: body ? 'POST' : 'GET',
          headers: { 'x-amz-access-token': this.token.value, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(20000),
        },
      )
      if (!response.ok) {
        if (response.status === 401) this.token = undefined
        throw new Error('SOURCE_AMAZON_REQUEST_FAILED_SP_HTTP_' + response.status)
      }
      return (await response.json()) as Record<string, unknown>
    } catch (error) {
      throw new Error(sourceErrorCode(error, 'SOURCE_AMAZON_REQUEST_FAILED'))
    }
  }
  async create(kind: ReportPart) {
    const r = await this.json('reports', {
      reportType: reportTypes[kind],
      marketplaceIds: [sourceMarket],
      ...(kind === 'listings' ? { reportOptions: { preferredReportDocumentLocale: 'en_US' } } : {}),
    })
    if (typeof r.reportId !== 'string' || !r.reportId) throw new Error('SOURCE_REPORT_ID_INVALID')
    return r.reportId
  }
  /** Bounded diagnostics only. This API's marketplace aggregates are never staged as SellerFlex. */
  async inventory(skus: string[]) {
    const values = z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((s) => !s.includes(',')),
      )
      .min(1)
      .max(50)
      .parse(skus)
    const query = new URLSearchParams({
      granularityType: 'Marketplace',
      granularityId: sourceMarket,
      marketplaceIds: sourceMarket,
      details: 'true',
      sellerSkus: values.join(','),
    })
    const raw = await this.json('summaries?' + query, undefined, 'fba')
    const parsed = z
      .object({
        payload: z.object({
          inventorySummaries: z.array(
            z
              .object({
                sellerSku: z.string(),
                fnSku: z.string().optional(),
                asin: z.string().optional(),
                condition: z.string().optional(),
                lastUpdatedTime: z.string().optional(),
                inventoryDetails: z
                  .object({ fulfillableQuantity: z.number().int().nonnegative().optional() })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          ),
        }),
        pagination: z.object({ nextToken: z.string().optional() }).optional(),
      })
      .safeParse(raw)
    if (!parsed.success) throw new Error('SOURCE_INVENTORY_RESPONSE_INVALID')
    return {
      rows: parsed.data.payload.inventorySummaries,
      nextToken: parsed.data.pagination?.nextToken ?? null,
      scope: 'FBA_MARKETPLACE' as const,
      stockAuthority: 'AMAZON_SP_API' as const,
      executionEligible: false,
    }
  }
  async poll(id: string) {
    const r = await this.json('reports/' + encodeURIComponent(id))
    if (!['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FATAL'].includes(String(r.processingStatus)))
      throw new Error('SOURCE_REPORT_STATUS_INVALID')
    return {
      status: String(r.processingStatus),
      documentId: typeof r.reportDocumentId === 'string' ? r.reportDocumentId : null,
      sourceAt: typeof r.createdTime === 'string' ? r.createdTime : null,
    }
  }
  async download(documentId: string, bucket: R2Bucket, key: string) {
    try {
      const r = await this.json('documents/' + encodeURIComponent(documentId))
      if (typeof r.url !== 'string') throw new Error('url')
      const url = new URL(r.url)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !url.hostname.endsWith('.amazonaws.com')
      )
        throw new Error('url')
      if (r.compressionAlgorithm && r.compressionAlgorithm !== 'GZIP') throw new Error('compression')
      const result = await this.request(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) })
      if (!result.ok || !result.body)
        throw new Error('SOURCE_REPORT_DOWNLOAD_FAILED_HTTP_' + result.status)
      // The documented default URL uses identity Content-Encoding; do not double-decompress an encoded HTTP response.
      const stream =
        r.compressionAlgorithm === 'GZIP' && result.headers.get('content-encoding') !== 'gzip'
          ? result.body.pipeThrough(new DecompressionStream('gzip'))
          : result.body
      const normalized = normalizeReportStream(stream, result.headers.get('content-type'))
      await archiveReportStream(bucket, key, normalized.stream, normalized.sourceCharset)
    } catch (error) {
      throw new Error(sourceErrorCode(error, 'SOURCE_REPORT_DOWNLOAD_FAILED'))
    }
  }
}
