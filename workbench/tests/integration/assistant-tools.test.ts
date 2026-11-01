import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bindings } from '../../apps/api/src/bindings'
import * as agent from '../../packages/assistant/agent'
import * as readTools from '../../packages/assistant/tools'

let sqlite: DatabaseSync, env: Bindings
const actor = { id: 'alice', email: 'alice', role: 'viewer', local: false }
const filters = { platform: 'temu', keyword: '', maxPrice: 4, minSold: 0, category: 'home' }
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('migrations/' + file, 'utf8'))
  sqlite.exec(
    "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('alice','alice','viewer','',''),('bob','bob','admin','','')",
  )
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const stmt = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: (field?: string) => {
        const row = stmt.get(...values)
        return (field ? row?.[field] : row) ?? null
      },
      all: () => ({ results: stmt.all(...values) }),
      run: () => ({ meta: stmt.run(...values) }),
      execute: () => ({ results: stmt.all(...values) }),
    }
  }
  env = {
    DB: { prepare, batch: (stmts: ReturnType<typeof prepare>[]) => stmts.map((s) => s.execute()) },
  } as unknown as Bindings
  for (let n = 1; n <= 3; n++)
    sqlite
      .prepare(
        "INSERT INTO products(id,platform,market,external_id,title,category_id,min_price,currency,total_sold,updated_at,fetched_at) VALUES(?,'temu','US',?,?,'9711',3,'USD',?,'2026-10-31T00:00:00Z','2026-11-01T00:00:00Z')",
      )
      .run('temu:US:' + n, String(n), '商品' + n, 40 - n)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('read tools must remain offline')
    }),
  )
})
afterEach(() => {
  sqlite.close()
  vi.unstubAllGlobals()
})
it('returns stable product IDs, snapshot dates and honest pagination', async () => {
  expect(typeof agent.runReadTool).toBe('function')
  const first = await agent.runReadTool(env, actor, 'search_inventory', { ...filters, pageSize: 2 })
  expect(first).toMatchObject({
    version: 1,
    status: 'ok',
    data: { items: [{ id: 'temu:US:1', currency: 'USD' }, { id: 'temu:US:2' }] },
    coverage: { total: 3, returned: 2, page: 1, hasMore: true },
    evidence: [
      {
        kind: 'product_snapshot',
        objectId: 'temu:US:1',
        observedAt: '2026-10-31T00:00:00Z',
        fetchedAt: '2026-11-01T00:00:00Z',
      },
      {},
    ],
  })
  const second = await agent.runReadTool(env, actor, 'search_inventory', {
    ...filters,
    page: 2,
    pageSize: 2,
  })
  expect(second).toMatchObject({
    data: { items: [{ id: 'temu:US:3' }] },
    coverage: { total: 3, returned: 1, page: 2, hasMore: false },
  })
  expect(first.evidence[0].id).not.toEqual(first.evidence[1].id)
  expect(fetch).not.toHaveBeenCalled()
})
it('reads different current products successively without a same-tool-name cache', async () => {
  for (const id of ['temu:US:1', 'temu:US:2']) {
    expect(await agent.runReadTool(env, actor, 'read_product', { productId: id })).toMatchObject({
      data: { product: { id } },
      evidence: [{ objectId: id }],
    })
  }
})
it('states missing product, review and comparison coverage without online updates', async () => {
  expect(await agent.runReadTool(env, actor, 'read_product', { productId: 'temu:US:99' })).toMatchObject(
    { status: 'empty', missing: expect.arrayContaining(['product']) },
  )
  expect(await agent.runReadTool(env, actor, 'read_reviews', { productId: 'temu:US:1' })).toMatchObject({
    status: 'empty',
    data: { productId: 'temu:US:1', report: null },
    missing: expect.arrayContaining(['saved_review_report']),
  })
  expect(
    await agent.runReadTool(env, actor, 'read_amazon_comparison', { productId: 'temu:US:1' }),
  ).toMatchObject({ status: 'empty', data: { productId: 'temu:US:1', matches: [], haul: false } })
  expect(fetch).not.toHaveBeenCalled()
  expect(sqlite.prepare('SELECT count(*) AS n FROM usage_reservations').get()?.n).toBe(0)
})
it('reads saved review reports while removing supplier internals and secrets', async () => {
  const report = {
    platform: 'temu',
    id: '1',
    updatedAt: '2026-11-01T02:00:00Z',
    data: {
      summary: '已有评论分析',
      withText: 12,
      rawResponse: { secret: 'supplier-secret' },
      evidence_ref: 'r2/private/key',
      debug: 'token-demo-secret',
    },
  }
  sqlite
    .prepare('INSERT INTO product_review_reports(product_key,report_json,updated_at) VALUES(?,?,?)')
    .run('product-reviews/v1/US/temu/1', JSON.stringify(report), Date.parse(report.updatedAt))
  env.OPENROUTER_API_KEY = 'token-demo-secret'
  const result = await agent.runReadTool(env, actor, 'read_reviews', { productId: 'temu:US:1' })
  expect(result).toMatchObject({
    status: 'ok',
    data: { report: { data: { summary: '已有评论分析', withText: 12 } } },
    evidence: [
      {
        kind: 'review_report',
        objectId: 'temu:US:1',
        fetchedAt: new Date(report.updatedAt).toISOString(),
      },
    ],
  })
  expect(JSON.stringify(result)).not.toMatch(/supplier-secret|r2\/private|token-demo-secret/)
})
it('lists only personal jobs and denies cross-account reports before loading steps', async () => {
  for (const name of ['alice', 'bob'])
    sqlite
      .prepare(
        "INSERT INTO job_runs(id,kind,actor,request_key,status,title,strategy_version,inputs_json,created_at,updated_at) VALUES(?,'research',?,?,'succeeded',?,1,'{}','2026-11-01','2026-11-01')",
      )
      .run(name, name, name, name + '-title')
  sqlite
    .prepare(
      "INSERT INTO job_steps VALUES('bob','secret','secret','succeeded','secret','{\"summary\":\"private-report\"}','r2/private','2026-11-01')",
    )
    .run()
  expect(await agent.runReadTool(env, actor, 'my_jobs', {})).toMatchObject({
    data: { items: [{ id: 'alice' }] },
    coverage: { total: 1 },
  })
  const forbidden = await agent.runReadTool(env, actor, 'read_job', { jobId: 'bob' })
  expect(forbidden).toMatchObject({ status: 'denied', data: null, evidence: [] })
  expect(JSON.stringify(forbidden)).not.toMatch(/bob-title|private-report|r2\/private/)
  expect(await agent.runReadTool(env, actor, 'read_job', { jobId: 'alice' })).toMatchObject({
    status: 'ok',
    data: { job: { id: 'alice', steps: [] } },
  })
})
it('checks current account role and activation rather than trusting an old actor snapshot', async () => {
  expect(
    await agent.runReadTool(env, { ...actor, role: 'admin' }, 'read_product', {
      productId: 'temu:US:1',
    }),
  ).toMatchObject({ status: 'ok' })
  await expect(
    agent.runAgentTool(env, { ...actor, role: 'admin' }, 'prepare_discovery', {
      ...filters,
      pages: 1,
      mode: 'cache',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  sqlite.prepare("UPDATE accounts SET active=0 WHERE id='alice'").run()
  expect(await agent.runReadTool(env, actor, 'search_inventory', filters)).toMatchObject({
    status: 'denied',
    data: null,
  })
})
it('registers all seven cached reads and preserves fixed command answers', async () => {
  expect(agent.agentTools.map((t) => t.function.name)).toEqual(
    expect.arrayContaining([
      'search_inventory',
      'list_potential',
      'read_product',
      'read_reviews',
      'read_amazon_comparison',
      'my_jobs',
      'read_job',
      'prepare_discovery',
    ]),
  )
  const result = await agent.runAgentTool(env, actor, 'search_inventory', filters)
  expect(result).toMatchObject({
    answer: expect.stringContaining('商品1'),
    data: { data: { items: expect.arrayContaining([expect.objectContaining({ id: 'temu:US:1' })]) } },
  })
  const potential = await agent.runReadTool(env, actor, 'list_potential', {})
  expect(potential).toMatchObject({ version: 1, coverage: { page: 1 }, warnings: expect.any(Array) })
})
it('rejects malformed IDs and unregistered tools without side effects', async () => {
  await expect(
    agent.runReadTool(env, actor, 'read_product', { productId: 'https://supplier.test' }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(agent.runReadTool(env, actor, 'http', {})).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  })
  expect(fetch).not.toHaveBeenCalled()
})
it('keeps unknown sales when no sales minimum was requested and reports empty page coverage', async () => {
  sqlite.prepare("UPDATE products SET total_sold=NULL WHERE id='temu:US:3'").run()
  const found = await agent.runReadTool(env, actor, 'search_inventory', filters)
  expect(found.coverage.total).toBe(3)
  const empty = await agent.runReadTool(env, actor, 'search_inventory', {
    ...filters,
    page: 4,
    pageSize: 1,
  })
  expect(empty).toMatchObject({
    status: 'empty',
    coverage: { total: 3, returned: 0, page: 4, hasMore: false },
  })
})
it('returns an unavailable saved report when cached JSON cannot be read', async () => {
  sqlite
    .prepare('INSERT INTO product_review_reports(product_key,report_json,updated_at) VALUES(?,?,?)')
    .run('product-reviews/v1/US/temu/1', 'broken-json', 1)
  expect(await agent.runReadTool(env, actor, 'read_reviews', { productId: 'temu:US:1' })).toMatchObject({
    status: 'unavailable',
    data: null,
    evidence: [],
    missing: ['saved_data_invalid'],
  })
  expect(fetch).not.toHaveBeenCalled()
})
it('preserves the original five-item fixed-command preview while exposing the next page', async () => {
  for (let n = 4; n <= 6; n++)
    sqlite
      .prepare(
        "INSERT INTO products(id,platform,market,external_id,title,category_id,min_price,currency,total_sold) VALUES(?,'temu','US',?,?,'9711',3,'USD',1)",
      )
      .run('temu:US:' + n, String(n), '商品' + n)
  expect(await agent.runAgentTool(env, actor, 'search_inventory', filters)).toMatchObject({
    data: { coverage: { total: 6, returned: 5, hasMore: true } },
  })
})
it('shows readable detail and saved-review answers while retaining structured model facts', async () => {
  for (const productId of ['temu:US:1', 'temu:US:2']) {
    const result = await agent.runAgentTool(env, actor, 'read_product', { productId })
    expect(result.answer).toContain(productId === 'temu:US:1' ? '商品1' : '商品2')
    expect(result.answer).toContain('累计销量')
    expect(result.answer).not.toMatch(/^\s*\{|"version"|"product"\s*:/)
    expect(result.data).toMatchObject({ data: { product: { id: productId } } })
  }
  const report = { updatedAt: '2026-11-01T02:00:00Z', data: { summary: '已有评论分析', withText: 12 } }
  sqlite
    .prepare('INSERT INTO product_review_reports(product_key,report_json,updated_at) VALUES(?,?,?)')
    .run('product-reviews/v1/US/temu/1', JSON.stringify(report), Date.parse(report.updatedAt))
  const reviews = await agent.runAgentTool(env, actor, 'read_reviews', { productId: 'temu:US:1' })
  expect(reviews.answer).toContain('已有评论分析')
  expect(reviews.answer).toContain('12')
  expect(reviews.answer).not.toMatch(/^\s*\{|"report"\s*:/)
  const comparison = await agent.runAgentTool(env, actor, 'read_amazon_comparison', {
    productId: 'temu:US:1',
  })
  expect(comparison.answer).toContain('暂无已保存的 Amazon')
  expect(comparison.answer).not.toMatch(/^\s*\{/)
  expect((await agent.runAgentTool(env, actor, 'list_potential', {})).answer).toContain('潜力新品')
  sqlite
    .prepare(
      "INSERT INTO job_runs(id,kind,actor,request_key,status,title,summary,strategy_version,inputs_json,created_at,updated_at) VALUES('alice','research','alice','alice','succeeded','库存研究','已核对两款',1,'{}','2026-11-01','2026-11-01')",
    )
    .run()
  const job = await agent.runAgentTool(env, actor, 'read_job', { jobId: 'alice' })
  expect(job.answer).toContain('库存研究')
  expect(job.answer).toContain('已核对两款')
  expect(job.answer).not.toMatch(/^\s*\{|"job"\s*:/)
})
it('normalizes omitted and explicit tool defaults for semantic replay keys', () => {
  expect(typeof readTools.normalizeReadToolArgs).toBe('function')
  expect(readTools.normalizeReadToolArgs('search_inventory', { platform: 'temu' })).toEqual(
    readTools.normalizeReadToolArgs('search_inventory', {
      platform: 'temu',
      page: 1,
      pageSize: 30,
      sort: 'total_sold',
      order: 'desc',
    }),
  )
  expect(() => readTools.normalizeReadToolArgs('http', {})).toThrow()
})
