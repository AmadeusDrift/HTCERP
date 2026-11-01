// Private Node 24 tool. Import the same normalizer as the deployed Worker.
import { closeSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { historyColumns, normalizeHistory, normalizeProduct, sites, utc } from './facts.ts'

const workbench = fileURLToPath(new URL('../../', import.meta.url))
const cache = path.resolve(workbench, '../probe-output')
const expanded = path.join(cache, 'expanded', 'responses')
const [mode, destination] = process.argv.slice(2)
if (!['--sqlite', '--output'].includes(mode) || !destination) throw new Error('Use scripts/bootstrap.py')
const source = 'bootstrap'
const search = new Map()
const details = []
function consider(row, origin) {
  const key = [origin.platform, 'US', row.goodsId].join(':')
  const updated = utc(row.updateTime)
  // Same-day ties follow the pre-existing reviewed CSV's populated-field rule (Beijing).
  const day = updated ? new Date(Date.parse(updated) + 8 * 3600_000).toISOString().slice(0, 10) : ''
  const fields = Object.values(row).filter((x) => x !== null && x !== undefined).length
  const previous = search.get(key)
  if (!previous || day > previous.day || (day === previous.day && fields > previous.fields)) {
    search.set(key, { row, origin, day, fields })
  }
}
for (const name of readdirSync(expanded).sort()) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
  const { job, response } = JSON.parse(readFileSync(path.join(expanded, name), 'utf8'))
  const isSearch = job.path.endsWith('/goods/search')
  if (!isSearch && !job.path.endsWith('/goods/detail')) continue
  if (response.http_status !== 200 || response.body?.code !== 0) continue
  if (!Object.hasOwn(sites, job.platform)) throw new Error('Unknown platform in cache')
  if (job.params.siteId !== undefined && job.params.siteId !== sites[job.platform])
    throw new Error('Unexpected site ID')
  if (job.params.regionId !== undefined && job.params.regionId !== 211)
    throw new Error('Unexpected region ID')
  const origin = {
    platform: job.platform,
    market: 'US',
    source,
    fetchedAt: null,
    evidenceRef: 'expanded/responses/' + name,
  }
  const data = response.body.data
  if (isSearch) {
    for (const row of data.list) consider(row, origin)
  } else {
    details.push({
      id: [job.platform, 'US', job.params.goodsId].join(':'),
      rows: data.history ?? [],
      origin,
    })
  }
}
// The older, overlapping verification cohorts enrich history only for IDs already in the approved set.
for (const dir of ['growth-check', 'zero-sales-check']) {
  for (const name of readdirSync(path.join(cache, dir)).sort()) {
    if (!/^\d+\.json$/.test(name)) continue
    const response = JSON.parse(readFileSync(path.join(cache, dir, name), 'utf8'))
    if (response.http_status !== 200 || response.body?.code !== 0) continue
    const data = response.body.data
    if (String(data.goods?.goodsId) !== path.parse(name).name)
      throw new Error('Mismatched history evidence')
    details.push({
      id: 'temu:US:' + data.goods.goodsId,
      rows: data.history ?? [],
      origin: { platform: 'temu', market: 'US', source, fetchedAt: null, evidenceRef: dir + '/' + name },
    })
  }
}
if (search.size !== 22664)
  throw new Error('Saved sample differs from the reviewed 22,664 products. Re-audit before import.')

const db = mode === '--sqlite' ? new DatabaseSync(destination) : null
const temp = destination + '.partial'
const fd = mode === '--output' ? openSync(temp, 'w') : null
if (db) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN')
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_snapshots'").get()) {
    db.exec(readFileSync(path.join(workbench, 'migrations', '0001_catalog.sql'), 'utf8'))
  }
}
const quote = (v) =>
  v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + v.replaceAll("'", "''") + "'"
let statements = 0,
  maxBytes = 0
function insertRows(table, columns, rows) {
  const prefix = 'INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES '
  const suffix = ' ON CONFLICT DO NOTHING;\n'
  const overhead = Buffer.byteLength(prefix + suffix)
  let packet = [],
    size = overhead
  function flush() {
    if (!packet.length) return
    const sql = prefix + packet.join(',') + suffix
    if (db) db.exec(sql)
    else writeSync(fd, sql)
    maxBytes = Math.max(maxBytes, Buffer.byteLength(sql))
    statements++
    packet = []
    size = overhead
  }
  for (const row of rows) {
    const values = '(' + row.map(quote).join(',') + ')'
    const bytes = Buffer.byteLength(values) + 1
    if (size + bytes > 80000) flush()
    if (size + bytes > 100000) throw new Error('D1 statement size exceeded')
    packet.push(values)
    size += bytes
  }
  flush()
}
function* products() {
  for (const [id, { row, origin }] of search) {
    const p = normalizeProduct(row, origin)
    yield [id, origin.evidenceRef, JSON.stringify(p)]
  }
}
let historical = 0
function* history() {
  for (const { id, rows, origin } of details) {
    if (!search.has(id)) continue
    for (const row of rows) {
      const obs = normalizeHistory(row, id, origin)
      if (!obs) continue
      historical++
      yield historyColumns.map((col) => obs[col])
    }
  }
}
try {
  insertRows('product_snapshots', ['product_id', 'evidence_ref', 'snapshot_json'], products())
  insertRows('observations', historyColumns, history())
  if (db) db.exec('COMMIT')
} finally {
  if (db) db.close()
  if (fd !== null) closeSync(fd)
}
if (!db) renameSync(temp, destination)
console.log(
  JSON.stringify({
    products: search.size,
    historyRows: historical,
    statements,
    maxStatementBytes: maxBytes,
  }),
)
