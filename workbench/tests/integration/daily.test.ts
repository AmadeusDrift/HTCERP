import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import app from '../../apps/api/src'
import type { DailyReport } from '../../packages/operations/daily'
import { promptVersion, selectionPromptVersion } from '../../packages/operations/model'
import { parseTerra } from '../../packages/operations/providers'

let db: DatabaseSync
const dbDir = new URL('../../migrations/', import.meta.url)
const token = 'a'.repeat(64)
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const f of readdirSync(dbDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(f, dbDir), 'utf8'))
  }
  db.exec(
    "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('r','viewer','viewer','','')",
  )
  db.prepare("INSERT INTO account_sessions VALUES(?,'r',1,?)").run(
    createHash('sha256').update(token).digest('hex'),
    Math.floor(Date.now() / 1000) + 3600,
  )
})
afterEach(() => db.close())
function prepare(sql: string, args: SQLInputValue[] = []) {
  return {
    bind: (...values: SQLInputValue[]) => prepare(sql, values),
    first: () => db.prepare(sql).get(...args) ?? null,
    all: () => ({ results: db.prepare(sql).all(...args) }),
  }
}
function request(query = 'date=2026-10-31', signed = true) {
  return app.request(
    'https://erp.test/api/daily?' + query,
    {
      headers: signed ? { Cookie: '__Host-workbench_session=' + token } : {},
    },
    {
      DB: {
        prepare,
        batch: (statements: ReturnType<typeof prepare>[]) => statements.map((s) => s.all()),
      },
    },
  )
}
async function report(extra = '') {
  const res = await request('date=2026-10-31' + extra)
  expect(res.status).toBe(200)
  return (await res.json()) as DailyReport
}
const start = '2026-10-30T16:00:00.000Z'
const end = '2026-10-31T16:00:00.000Z'
const product = (n: number) => 'temu:US:' + n
function job(
  id: string,
  time = start,
  inputs: Record<string, unknown> = { mode: 'live' },
  parent: string | null = null,
) {
  db.prepare(`INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at,parent_id)
    VALUES(?,?,'succeeded','private task title',1,?,'private actor',?,?,?,?)`).run(
    id,
    inputs.productId ? 'research' : 'discovery',
    JSON.stringify(inputs),
    id,
    time,
    time,
    parent,
  )
}
function hit(run: string, n: number, child: string | null = null, tier: number | null = 10000) {
  const ref = 'private-archive/' + run + '-' + n
  db.prepare('INSERT INTO product_snapshots VALUES(?,?,?)').run(
    product(n),
    ref,
    JSON.stringify({
      id: product(n),
      platform: 'temu',
      market: 'US',
      external_id: String(n),
      title: run + ' 标题 ' + n,
      source: 'private supplier',
      variants_json: '[]',
      updated_at: run,
      evidence_ref: ref,
    }),
  )
  db.prepare('INSERT INTO job_seen(run_id,product_id,tier,first_page,total_sold,evidence_ref,child_id) VALUES(?,?,?,1,?,?,?)').run(
    run,
    product(n),
    tier,
    10000 + n,
    ref,
    child,
  )
}
function step(run: string, key: string, data: object, status = 'succeeded') {
  db.prepare('INSERT INTO job_steps VALUES(?,?,?,?,?,?,?,?)').run(
    run,
    key,
    key,
    status,
    '',
    JSON.stringify(data),
    'private-archive',
    end,
  )
}
function research(id: string, n: number, parent: string, verdict?: string) {
  job(id, end, { productId: product(n), mode: 'live' }, parent)
  if (verdict)
    step(id, 'terra', {
      products: [product(n)],
      promptVersion: selectionPromptVersion,
      selection: { verdict, reason: '该商品价格和 GeekBI 缓存中的销量已核对。' },
      model: 'private-model',
    })
}
it('requires a session, rejects invalid dates and pagination, and separates actual searches from plans', async () => {
  expect((await request('', false)).status).toBe(401)
  for (const q of ['date=2026-02-29', 'page=0', 'pageSize=101', 'view=unknown']) {
    expect((await request(q)).status).toBe(400)
  }
  job('next', end)
  job('yesterday', '2026-10-30T15:59:59.999Z')
  job('plan', start, { mode: 'cache' })
  step('plan', 'plan', { matched: 30, examples: [{ id: product(1) }] })
  expect((await report()).summary).toMatchObject({ liveRuns: 0, searchedRuns: 0, selected: 0 })
  job('today')
  expect((await report()).summary).toMatchObject({ liveRuns: 1, searchedRuns: 0, selected: 0 })
  step('today', 'search-1', { matched: 0 })
  hit('today', 1, null, null)
  expect((await report()).summary).toMatchObject({ liveRuns: 1, searchedRuns: 1, selected: 0 })
  hit('today', 2)
  expect((await report()).summary).toMatchObject({ selected: 1, linked: 0, reports: 0, recommended: 0 })
})
it('keeps the latest qualifying snapshot and credits distinct verified research across earlier discoveries', async () => {
  job('a')
  job('b', '2026-10-31T15:59:59.999Z')
  job('c', end)
  research('research-1', 1, 'a', 'recommend')
  hit('a', 1, 'research-1')
  hit('b', 1, 'research-1')
  hit('c', 1)
  research('old-2', 2, 'a', 'recommend')
  hit('a', 2, 'old-2')
  hit('b', 2)
  research('research-3', 3, 'b')
  step('research-3', 'terra', { products: [product(3)], summary: '建议推荐', promptVersion })
  hit('b', 3)
  research('research-4', 4, 'b')
  step('research-4', 'decision', { choice: 'research' })
  hit('b', 4, 'research-4')
  research('research-5', 5, 'b', 'pass')
  hit('b', 5, 'research-5')
  research('wrong-products', 6, 'b')
  step('wrong-products', 'terra', {
    products: [product(5), product(6)],
    promptVersion: selectionPromptVersion,
    selection: { verdict: 'recommend', reason: '多个商品混在一起' },
  })
  hit('b', 6, 'wrong-products')
  const result = await report()
  expect(result.summary).toMatchObject({
    liveRuns: 2,
    searchedRuns: 2,
    selected: 6,
    linked: 6,
    reports: 4,
    recommended: 2,
  })
  expect(result.items.find((i) => i.productId === product(1))).toMatchObject({
    productId: product(1),
    title: 'b 标题 1',
    occurrences: 2,
    independentRecommendations: 1,
    discoveryId: 'b',
    researchId: 'research-1',
    reused: 1,
    outcome: 'recommend',
    reason: '该商品价格和 商品数据服务 缓存中的销量已核对。',
  })
  expect(result.items[0]).toMatchObject({
    productId: product(2),
    title: 'b 标题 2',
    outcome: 'recommend',
    independentRecommendations: 1,
    occurrences: 2,
    discoveryId: 'b',
    researchDiscoveryId: 'a',
    researchId: 'old-2',
  })
  expect(result.items.map((i) => [i.productId, i.outcome])).toContainEqual([product(6), 'pending'])
  expect(result.items.find((i) => i.productId === product(3))).toMatchObject({
    researchId: 'research-3',
    outcome: 'unrated',
    reason: null,
  })
  expect(result.items.find((i) => i.productId === product(4))?.outcome).toBe('triage')
  expect(JSON.stringify(result)).not.toMatch(/private|geekbi|promptVersion|evidenceRef/i)
  expect((await report('&view=recommended')).items).toHaveLength(2)
  const last = await report('&pageSize=2&page=999')
  expect(last.page).toBe(3)
  expect(last.items).toEqual(result.items.slice(4))
})
it('ranks by distinct recommendations before sales and keeps pagination in the same order', async () => {
  for (const run of ['a', 'b', 'c', 'd', 'e']) job(run)
  for (const run of ['a', 'b', 'c']) {
    research('research-' + run, 1, run, 'recommend')
    hit(run, 1, 'research-' + run)
  }
  hit('d', 1, 'research-c')
  research('new-pass', 1, 'e', 'pass')
  hit('e', 1, 'new-pass')
  research('high-sales', 999, 'd', 'recommend')
  hit('d', 999, 'high-sales')
  const first = await report('&view=recommended&pageSize=1')
  expect(first.total).toBe(2)
  expect(first.summary).toMatchObject({ reports: 5, recommended: 2, selected: 2 })
  expect(first.items[0]).toMatchObject({
    productId: product(1),
    independentRecommendations: 3,
    occurrences: 5,
    title: 'e 标题 1',
    discoveryId: 'e',
    researchDiscoveryId: 'd',
    researchId: 'research-c',
    outcome: 'recommend',
  })
  expect((await report('&view=recommended&pageSize=1&page=2')).items[0]).toMatchObject({
    productId: product(999),
    independentRecommendations: 1,
  })
})
it('accepts archived v1 reports without inventing verdicts and requires a reason for new single-product research', () => {
  const fields = {
    summary: '单品研究',
    standardProduct: '',
    differentiation: '',
    missing: [],
    nextActions: [],
  }
  const body = (values: object) => ({
    choices: [{ message: { content: JSON.stringify({ ...fields, ...values }) } }],
  })
  expect(parseTerra(body({}), promptVersion)).toEqual(fields)
  expect(() => parseTerra(body({}), selectionPromptVersion)).toThrow()
  expect(() =>
    parseTerra(body({ selection: { verdict: 'recommend', reason: ' ' } }), selectionPromptVersion),
  ).toThrow()
  expect(
    parseTerra(
      body({ selection: { verdict: 'insufficient', reason: '缺少价格观测。' } }),
      selectionPromptVersion,
    ),
  ).toMatchObject({ selection: { verdict: 'insufficient', reason: '缺少价格观测。' } })
})
