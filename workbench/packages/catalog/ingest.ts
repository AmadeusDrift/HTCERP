import { historyColumns, normalizeHistory, normalizeProduct, type Platform, utc } from './facts'

export interface IngestInput {
  platform: Platform
  market: 'US'
  rows: Record<string, unknown>[]
  fetchedAt: string
  evidenceRef: string
  detail?: boolean
  history?: Record<string, unknown>[]
}

export async function ingestGeekbi(db: D1Database, input: IngestInput): Promise<{ unique: number }> {
  const fetchedAt = utc(input.fetchedAt)
  if (!fetchedAt || !input.evidenceRef?.trim()) throw new Error('缺少来源时间或证据引用')
  if (input.detail && input.rows.length !== 1) throw new Error('详情响应应对应单一商品')
  if (input.history?.length && !input.detail) throw new Error('历史记录缺少详情商品标识')
  const origin = { ...input, fetchedAt, source: 'geekbi' }
  const products = new Map<string, ReturnType<typeof normalizeProduct>>()
  for (const row of input.rows) {
    const product = normalizeProduct(row, origin)
    const previous = products.get(product.id)
    if (!previous || (product.updated_at ?? '') > (previous.updated_at ?? ''))
      products.set(product.id, product)
  }
  const statements: D1PreparedStatement[] = []
  function insert(table: string, columns: readonly string[], rows: (string | number | null)[][]) {
    const perStatement = Math.floor(90 / columns.length)
    const placeholders = '(' + columns.map(() => '?').join(',') + ')'
    for (let n = 0; n < rows.length; n += perStatement) {
      const group = rows.slice(n, n + perStatement)
      const sql =
        'INSERT INTO ' +
        table +
        '(' +
        columns.join(',') +
        ') VALUES ' +
        group.map(() => placeholders).join(',') +
        ' ON CONFLICT DO NOTHING'
      statements.push(db.prepare(sql).bind(...group.flat()))
    }
  }
  insert(
    'product_snapshots',
    ['product_id', 'evidence_ref', 'snapshot_json'],
    Array.from(products.values(), (p) => [p.id, p.evidence_ref, JSON.stringify(p)]),
  )
  if (input.detail) {
    const [id] = products.keys()
    const rows = (input.history ?? []).flatMap((row) => {
      const obs = normalizeHistory(row, id, origin)
      return obs ? [historyColumns.map((key) => obs[key])] : []
    })
    insert('observations', historyColumns, rows)
  }
  // Each chunk is atomic. Replaying a partially persisted R2 response reuses its immutable keys.
  for (let offset = 0; offset < statements.length; offset += 50)
    await db.batch(statements.slice(offset, offset + 50))
  return { unique: products.size }
}
