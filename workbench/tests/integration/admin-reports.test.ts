import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import app from '../../apps/api/src'
import { ingestGeekbi } from '../../packages/catalog/ingest'
import type { AdminReport } from '../../packages/operations/admin-reports'

const runId = '35b04a0d-9a3b-4112-bb32-2ec888d13127'
const runAt = '2026-10-31T16:01:00.000Z' // November 1 in Beijing.
const detailAt = '2026-10-31T16:08:00.000Z'
const yesterdayAt = '2026-10-31T15:59:59.999Z'
const sourceAt = '2026-10-31T16:00:00.000Z'
let db: DatabaseSync
const objects = new Map<string, string>()
function prepare(query: string, args: SQLInputValue[] = []) {
  const statement = db.prepare(query)
  return {
    bind: (...values: SQLInputValue[]) => prepare(query, values),
    first: () => statement.get(...args) ?? null,
    all: () => ({ results: statement.all(...args) }),
    run: () => ({ meta: statement.run(...args) }),
  }
}
const DB = {
  prepare,
  batch: (statements: ReturnType<typeof prepare>[]) => {
    db.exec('BEGIN')
    try {
      const result = statements.map((s) => s.all())
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
} as unknown as D1Database
const bindings = {
  DB,
  GB_APP_KEY: 'fake-key',
  GB_APP_SECRET: 'fake-secret',
  ARCHIVE: {
    get: async (key: string) =>
      objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
    put: async (key: string, payload: string) => {
      if (objects.has(key)) return null
      objects.set(key, payload)
      return { key }
    },
  },
}
const tokens = { admin: 'a'.repeat(64), operator: 'b'.repeat(64), viewer: 'c'.repeat(64) }
function request(role: keyof typeof tokens | null, postRun?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (role) headers.set('Cookie', '__Host-workbench_session=' + tokens[role])
  return app.request(
    'https://example.test/api/admin-reports',
    {
      headers,
      method: postRun ? 'POST' : 'GET',
      body: postRun ? JSON.stringify({ runId: postRun }) : undefined,
    },
    bindings,
  )
}
async function archive() {
  const res = await request('admin')
  expect(res.status).toBe(200)
  return (await res.json()) as { latestRun: string | null; reports: AdminReport[] }
}
function insertRun(id: string, date = runAt) {
  db.prepare(`INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at)
    VALUES(?,'discovery','succeeded','Test discovery',1,'{"mode":"live"}','admin',?,?,?)`).run(
    id,
    id,
    date,
    date,
  )
  const step = db.prepare("INSERT INTO job_steps VALUES(?,?,?,'succeeded','',?,NULL,?)")
  step.run(
    id,
    'plan',
    'plan',
    JSON.stringify({
      settings: { platform: 'temu', maxPrice: 4, tiers: [1000], keyword: '' },
      categoryIds: [],
    }),
    date,
  )
  step.run(id, 'search-1', 'search', JSON.stringify({ matched: 2 }), date)
}
const datum = (goodsId: string, daySold: number, updated = sourceAt) => ({
  goodsId,
  goodsName: '商品 ' + goodsId,
  sold: 2800,
  daySold,
  minPrice: 3.25,
  updateTime: updated,
})
async function seed() {
  insertRun(runId)
  const evidenceRef = 'list/test-discovery.json'
  await ingestGeekbi(DB, {
    platform: 'temu',
    market: 'US',
    rows: [datum('11', 21), datum('12', 10)],
    fetchedAt: runAt,
    evidenceRef,
  })
  for (const id of ['11', '12']) {
    db.prepare(
      'INSERT INTO job_seen(run_id,product_id,tier,first_page,total_sold,evidence_ref) VALUES(?,?,1000,1,2800,?)',
    ).run(runId, 'temu:US:' + id, evidenceRef)
  }
  db.prepare(
    "INSERT INTO usage_reservations(run_id,step_key,unit,business_date,reserved,actual,state,created_at) VALUES(?,'search-1','points','2026-11-01',10,6,'confirmed',?)",
  ).run(runId, runAt)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-31T16:10:00.000Z'))
  db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync('migrations/' + f, 'utf8'))
  for (const [role, token] of Object.entries(tokens)) {
    db.prepare("INSERT INTO accounts(id,username,role,salt,password_hash) VALUES(?,?,?,'','')").run(
      role,
      role,
      role,
    )
    db.prepare('INSERT INTO account_sessions VALUES(?,?,1,?)').run(
      createHash('sha256').update(token).digest('hex'),
      role,
      Math.floor(Date.now() / 1000) + 172800,
    )
  }
  db.exec("UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.dataDailyPoints',100)")
  objects.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  db.close()
})

it('denies both archive reads and generation unless the server session is an administrator', async () => {
  const vendor = vi.fn()
  vi.stubGlobal('fetch', vendor)
  for (const role of [null, 'operator', 'viewer'] as const) {
    const expected = role ? 403 : 401
    expect((await request(role)).status).toBe(expected)
    expect((await request(role, runId)).status).toBe(expected)
  }
  expect(await archive()).toEqual({ latestRun: null, reports: [] })
  expect(vendor).not.toHaveBeenCalled()
})

it('runs the Amazon supplement on an older AI decision, preserves the original archive and reopens without sending another request', async () => {
  await seed()
  const sourceId = 'temu:US:11',
    jobId = 'e8cb4eb0-6191-4fcc-9a3c-c5ec3d579e94'
  db.prepare(`INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at)
    VALUES(?,'research','succeeded','单品研究',1,?,'admin',?,?,?)`).run(
    jobId,
    JSON.stringify({ mode: 'live', productId: sourceId }),
    jobId,
    runAt,
    runAt,
  )
  const step = db.prepare("INSERT INTO job_steps VALUES(?,?,?,'succeeded','',?,NULL,?)")
  step.run(
    jobId,
    'plan',
    '研究资料',
    JSON.stringify({
      target: {
        id: sourceId,
        title: 'Plastic measuring scoop',
        min_price: 3.25,
        currency: 'USD',
        total_sold: 2800,
      },
      variants: [],
    }),
    runAt,
  )
  step.run(
    jobId,
    'decision',
    'AI 分析',
    JSON.stringify({ products: [sourceId], choice: 'review' }),
    runAt,
  )
  const raw = JSON.stringify({
    runId,
    kind: 'selection',
    items: [
      { id: sourceId, researchId: jobId },
      { id: 'temu:US:12', researchId: null },
    ],
  })
  db.prepare("INSERT INTO admin_daily_reports VALUES(?,'selection','2026-11-01',?)").run(runId, raw)
  const path = '/api/jobs/' + jobId + '/amazon-compare'
  const req = (role: keyof typeof tokens, path: string, method = 'GET') =>
    app.request(
      'https://example.test' + path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: '__Host-workbench_session=' + tokens[role],
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      },
      {
        ...bindings,
        SP_CLIENT_ID: 'fake-client',
        SP_CLIENT_SECRET: 'fake-secret',
        SP_REFRESH_TOKEN: 'fake-refresh',
      },
    )
  const vendor = vi.fn(async (req: string | URL | Request) => {
    const url = new URL(req instanceof Request ? req.url : req)
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'dummy-access' })
    if (url.pathname.includes('/catalog/'))
      return Response.json({
        items: [
          {
            asin: 'B000000001',
            summaries: [
              { marketplaceId: 'ATVPDKIKX0DER', itemName: 'Plastic measuring scoop', size: '50 ml' },
            ],
          },
        ],
      })
    if (url.pathname.endsWith('/offers'))
      return Response.json({
        payload: { Offers: [{ ListingPrice: { Amount: 6.5, CurrencyCode: 'USD' } }] },
      })
    throw new Error('Unrelated request: ' + url.hostname)
  })
  vi.stubGlobal('fetch', vendor)
  expect((await req('viewer', path, 'POST')).status).toBe(403)
  expect((await archive()).reports[0].items[0]).toMatchObject({ amazonEligible: true })
  expect(vendor).not.toHaveBeenCalled()
  expect((await req('operator', path, 'POST')).status).toBe(404)
  expect((await req('admin', path, 'POST')).status).toBe(200)
  const checked = (await archive()).reports[0].items
  expect(checked[0].amazonComparison).toMatchObject({
    status: 'found',
    productId: sourceId,
    sourcePrice: 3.25,
    candidates: [expect.objectContaining({ asin: 'B000000001', price: 6.5 })],
  })
  expect(checked[1].amazonComparison).toBeUndefined()
  const res = await req('viewer', '/api/products/' + encodeURIComponent(sourceId) + '/amazon')
  expect(res.status).toBe(200)
  expect(((await res.json()) as { automation: unknown }).automation).toMatchObject({
    runId: jobId,
    comparison: checked[0].amazonComparison,
  })
  const cost = vendor.mock.calls.length
  expect(cost).toBeGreaterThan(1)
  expect((await req('admin', path, 'POST')).status).toBe(200)
  expect(vendor).toHaveBeenCalledTimes(cost)
  // Upgrade a previously completed broad search, retain both catalog pages, and replay only the new result.
  db.prepare(
    "UPDATE amazon_auto_comparisons SET result_json=json_remove(result_json,'$.methodVersion') WHERE run_id=?",
  ).run(jobId)
  db.prepare(
    "UPDATE job_steps SET result_json=json_remove(result_json,'$.comparisons[0].methodVersion') WHERE run_id=? AND step_key='amazon-compare'",
  ).run(jobId)
  const priorPage = db.prepare('SELECT id FROM amazon_searches WHERE product_id=?').get(sourceId)?.id
  expect((await req('admin', path, 'POST')).status).toBe(200)
  expect(vendor).toHaveBeenCalledTimes(cost)
  expect((await archive()).reports[0].items[0].amazonComparison?.methodVersion).toBe(2)
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM amazon_searches WHERE product_id=?').get(sourceId)?.n,
  ).toBe(2)
  expect(db.prepare('SELECT id FROM amazon_searches WHERE id=?').get(String(priorPage))?.id).toBe(
    priorPage,
  )
  expect((await req('admin', path, 'POST')).status).toBe(200)
  expect(vendor).toHaveBeenCalledTimes(cost)
  expect(db.prepare('SELECT report_json FROM admin_daily_reports').get()?.report_json).toBe(raw)
})

it('freezes the search snapshot and the two dated detail responses, and reopens the same archive on the next day without another charge', async () => {
  await seed()
  const vendor = vi.fn(async (req: Request) => {
    const url = new URL(req.url)
    expect(url.pathname).toBe('/api/v2/data/temu/goods/detail')
    expect(url.searchParams.get('regionId')).toBe('211')
    const id = url.searchParams.get('goodsId')!
    const history =
      id === '11'
        ? [{ createTime: yesterdayAt, daySold: 0 }]
        : [
            { createTime: sourceAt, daySold: 40 },
            { createTime: runAt, daySold: 80 },
          ]
    const goods = { ...datum(id, id === '11' ? 5 : 7, detailAt), sold: 2810, minPrice: 3.5 }
    return Response.json(
      { code: 0, data: { goods, history } },
      { headers: { 'x-gb-price-points': '4' } },
    )
  })
  vi.stubGlobal('fetch', vendor)
  expect(await archive()).toEqual({ latestRun: runId, reports: [] })
  expect((await request('admin', runId)).status).toBe(200)
  const saved = await archive()
  expect(saved.reports).toHaveLength(2)
  const selection = saved.reports.find((r) => r.kind === 'selection')!
  const tracking = saved.reports.find((r) => r.kind === 'tracking')!
  expect(selection).toMatchObject({
    runId,
    day: '2026-11-01',
    previousDay: '2026-10-31',
    actor: 'admin',
    examined: 2,
    matched: 2,
    points: 6,
    pendingPoints: 0,
  })
  expect(selection.items[0]).toMatchObject({
    id: 'temu:US:11',
    sold: 2800,
    daily: 21,
    price: 3.25,
    snapshotAt: sourceAt,
    evidence: 'list/test-discovery.json',
    today: null,
    yesterday: null,
  })
  expect(tracking).toMatchObject({
    day: '2026-11-01',
    previousDay: '2026-10-31',
    points: 8,
    pendingPoints: 0,
  })
  expect(tracking.items[0]).toMatchObject({
    id: 'temu:US:11',
    sold: 2810,
    price: 3.5,
    daily: 5,
    snapshotAt: detailAt,
    today: 5,
    yesterday: 0,
    todayAt: detailAt,
    yesterdayAt,
  })
  expect(tracking.items[1]).toMatchObject({
    id: 'temu:US:12',
    today: 7,
    yesterday: null,
    yesterdayAt: null,
    reason: expect.stringContaining('缺少'),
  })
  for (const item of tracking.items) {
    expect(objects.has(item.evidence)).toBe(true)
    const stored = JSON.parse(objects.get(item.evidence)!)
    expect(stored.body.data.goods.goodsId).toBe(item.id.split(':')[2])
    expect(item.detailAt).toBe(stored.fetchedAt)
  }
  // Failure between an archived vendor response and the D1 report commit can be replayed.
  db.exec('DELETE FROM admin_daily_reports')
  expect((await request('admin', runId)).status).toBe(200)
  expect((await archive()).reports).toEqual(saved.reports)
  vi.setSystemTime(new Date('2026-11-01T16:10:00Z'))
  expect((await request('admin', runId)).status).toBe(200)
  expect(await archive()).toEqual({ latestRun: null, reports: saved.reports })
  expect(vendor).toHaveBeenCalledTimes(2)
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n, SUM(actual) points FROM usage_reservations WHERE direct_key IS NOT NULL',
      )
      .get(),
  ).toMatchObject({ n: 2, points: 8 })
  const otherRun = '0512aab9-7e05-4cd1-a14a-abf2693edd00'
  insertRun(otherRun)
  expect((await request('admin', otherRun)).status).toBe(409)
  expect(vendor).toHaveBeenCalledTimes(2)
})
