import { createHash, createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from '../../../apps/api/src/index'
import { ResearchWorkflow } from '../../../apps/jobs/src/index'
import * as amazon from '../../amazon/auto-compare'
import { replaceCredentials } from '../../connections/credentials'
import { runAmazonComparison } from '../amazon-comparison'
import {
  activeContext,
  discoverPage,
  finish,
  instanceId,
  refreshFocus,
  researchStep,
  reserve,
  stepOnce,
  storedResult,
} from '../execution'
import { geekbiSlotHealth, geekbiSlotUsage } from '../geekbi'
import { readGeekbiReviews, testGeekbiSlot } from '../geekbi-direct'
import { createJob, jobAction, jobView, listJobs, runSchedule } from '../jobs'
import { currentStrategy, getRun, inputsSchema, type OpsBindings, type Settings, usage } from '../model'
import { potentialProducts } from '../potential'
import { aiRequest, geekRequest, parseDecision, parseTerra } from '../providers'
import { advanceQueue, researchQueue } from '../queue'

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }))

let sql: DatabaseSync, env: OpsBindings
const folder = new URL('../../../migrations/', import.meta.url)
const dispatch = vi.fn()
const store = new Map<string, string>()
function statement(query: string, args: SQLInputValue[] = []) {
  const s = sql.prepare(query)
  return {
    bind: (...v: SQLInputValue[]) => statement(query, v),
    first: () => s.get(...args) ?? null,
    all: () => ({ results: s.all(...args) }),
    run: () => ({ meta: s.run(...args) }),
    batch: () => ({ results: s.all(...args) }),
  }
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:')
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(file, folder), 'utf8'))
  store.clear()
  dispatch.mockClear()
  env = {
    DB: {
      prepare: statement,
      batch: (statements: ReturnType<typeof statement>[]) => {
        sql.exec('BEGIN')
        try {
          const r = statements.map((s) => s.batch())
          sql.exec('COMMIT')
          return r
        } catch (e) {
          sql.exec('ROLLBACK')
          throw e
        }
      },
    } as unknown as D1Database,
    ARCHIVE: {
      get: async (k: string) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)!) } : null),
      put: async (k: string, v: string) => {
        if (store.has(k)) return null
        store.set(k, v)
        return { key: k }
      },
      head: async (k: string) => (store.has(k) ? { key: k } : null),
    } as unknown as R2Bucket,
    RUNNER: {
      create: async (a: unknown) => {
        dispatch(a)
      },
    } as unknown as Workflow<{ runId: string }>,
    GB_APP_KEY: 'fixture-key',
    GB_APP_SECRET: 'fixture-secret',
    OPENROUTER_API_KEY: 'fixture-router',
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sql.close()
})
const actor = 'test@example.invalid'
async function settings(patch: Partial<Settings> = {}) {
  const s = await currentStrategy(env.DB)
  sql
    .prepare('INSERT INTO strategy_versions VALUES(?,?,?,?)')
    .run(s.version + 1, JSON.stringify({ ...s.settings, ...patch }), actor, new Date().toISOString())
}
async function active(id: string) {
  const job = await getRun(env.DB, id)
  const c = await activeContext(env, id, instanceId(job))
  if (!c) throw new Error('fixture job is not active')
  return c
}
const goods = (id: string, sold: number | null) => ({
  goodsId: id,
  goodsName: 'fixture-key organizer',
  sold,
  minPrice: 4,
  catItems: [{ catId: 9711, parentCatId: 0, catLevel: 1, catName: '家居' }],
})
function page(rows: unknown[], status = 200, points: string | null = '10') {
  return Response.json(
    { code: 0, data: { list: rows, total: rows.length } },
    { status, headers: points === null ? {} : { 'x-gb-price-points': points } },
  )
}
async function createDiscovery(requestId = 'demo', ai?: number) {
  const created = await createJob(
    env,
    { kind: 'discovery', inputs: { mode: 'live', maxAiMicros: ai }, requestId },
    actor,
  )
  return active(created.id)
}
describe('operations fixture', () => {
  it('discovers Amazon ASINs across pages and checks shortlisted ASINs at the official price', async () => {
    await settings({ platform: 'amazon', categoryId: '', keyword: '', tiers: [0], maxPrice: 4, dataDailyPoints: 50 })
    const ctx = await createDiscovery('amazon-broad')
    const asin = 'B0H8YRXHGJ'
    const { AmazonUS } = await import('../../amazon/adapter')
    const quotes = vi.spyOn(AmazonUS.prototype,'batchOffers').mockResolvedValue(new Map([[asin,{price:3.99,currency:'USD',shipping:0}]]))
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      const url = new URL(req.url)
      expect(url.pathname).toBe('/api/v2/data/amazon/goods/search')
      expect(url.searchParams.get('priceMax')).toBe('4')
      expect(url.searchParams.get('siteId')).toBe('1')
      return page([{ goodsId: asin, goodsName: 'Peeler', minPrice: 3.5, monthSold: 100 },
        { goodsId: 'B0ZZZZZZZZ', goodsName: 'Over budget', minPrice: 6 }])
    }))
    const result = await discoverPage(ctx,1,[])
    expect(result.result.quotes).toMatchObject([{ asin, price:3.99, tier:'大概率属于低价商城，优先考虑' }])
    await discoverPage(ctx,2,[])
    expect(quotes).toHaveBeenCalledWith([asin])
    expect(await researchQueue(env.DB,ctx.job.id,1,10)).toMatchObject({total:1,items:[{productId:'amazon:US:'+asin,totalSold:null}]})
  })
  it('advances to the next product across daily runs and charges only the original parent for reused reports', async () => {
    await settings({ dataDailyPoints: 100, aiDailyMicros: 100_000, researchLimit: 1 })
    const runDay = async (name: string, supplierTime: string, sold = 50000) => {
      const c = await createDiscovery(name, 33000)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          page([
            {
              ...goods('1', sold),
              updateTime: supplierTime,
              sku: [{ skuId: '31415', specs: [{ specKey: '色', specValue: '蓝' }] }],
            },
            { ...goods('2', 30000), updateTime: supplierTime },
          ]),
        ),
      )
      await discoverPage(c, 1, ['9711'])
      expect(await advanceQueue(env, c.job, c.settings, c.input, '')).toMatchObject({ submitted: 1 })
      return { c, queue: await researchQueue(env.DB, c.job.id, 1, 20) }
    }
    const first = await runDay('oct-31', '2026-10-31T00:00:00Z')
    const firstChild = first.queue.items[0].childId!
    expect(first.queue.items[1].childId).toBeNull()
    const childContext = await active(firstChild)
    await reserve(childContext, 'decision', 'micros', 3000)
    await finish(env, firstChild, 0, true, 'fixture')
    const second = await runDay('nov-01', '2026-11-01T00:00:00Z')
    expect(second.queue.items[0].childId).toBe(firstChild)
    expect(second.queue.items[1].childId).toBeTruthy()
    expect(await jobView(env.DB, firstChild)).toMatchObject({
      steps: [{ result: { variants: [{ skuId: '31415', specs: [{ key: '色', value: '蓝' }] }] } }],
    })
    expect(await jobView(env.DB, first.c.job.id)).toMatchObject({
      usage: { aiMicros: 3000 },
      ownUsage: { aiMicros: 0 },
      childrenUsage: { aiMicros: 3000 },
      steps: expect.arrayContaining([
        expect.objectContaining({
          key: 'plan',
          result: expect.objectContaining({ plannedMaxAiMicros: 33000 }),
        }),
      ]),
    })
    expect(await jobView(env.DB, second.c.job.id)).toMatchObject({
      usage: { aiMicros: 0 },
      steps: expect.arrayContaining([
        expect.objectContaining({
          key: 'research-queue',
          result: expect.objectContaining({ reused: 1, legacyComparisonsPending: 1 }),
        }),
      ]),
    })
    expect(
      (await listJobs(env.DB, 'discovery', '', 1, 20)).items.find((r) => r.id === first.c.job.id)?.usage
        .aiMicros,
    ).toBe(3000)
    expect((await usage(env.DB)).aiMicros).toBe(3000)
    const changed = await runDay('nov-02', '2026-11-02T00:00:00Z', 51000)
    expect(changed.queue.items[0].childId).not.toBe(firstChild)
    expect(changed.queue.items[1].childId).toBe(second.queue.items[1].childId)
  })
  it('pins versions, returns an actionable cache plan at zero budget and leases one cron per Shanghai day', async () => {
    const base = await currentStrategy(env.DB)
    expect(base.settings).toMatchObject({ scheduleEnabled: false, aiDailyMicros: 0, dataDailyPoints: 0 })
    const cache = await createJob(
      env,
      { kind: 'research', inputs: { mode: 'cache', goal: '核对衣柜收纳' }, requestId: 'one' },
      actor,
    )
    expect(await jobView(env.DB, cache.id)).toMatchObject({
      status: 'succeeded',
      steps: [{ key: 'plan', result: { actions: expect.any(Array) } }],
    })
    const live = await createJob(env, { kind: 'discovery', inputs: { mode: 'live' } }, actor)
    expect(await jobView(env.DB, live.id)).toMatchObject({
      status: 'partial',
      summary: expect.stringContaining('预算不足'),
    })
    const time = Date.parse('2026-11-02T00:00:00+08:00')
    await runSchedule(env, time)
    expect(dispatch).not.toHaveBeenCalled()
    await settings({ scheduleEnabled: true, scheduleTime: '08:45', dataDailyPoints: 10 })
    await runSchedule(env, time + 8 * 3600_000)
    expect(dispatch).not.toHaveBeenCalled()
    await runSchedule(env, time + 9 * 3600_000)
    await runSchedule(env, time + 10 * 3600_000)
    expect(sql.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE actor='scheduler'").get()?.n).toBe(1)
    const cronId = String(sql.prepare("SELECT id FROM job_runs WHERE actor='scheduler'").get()?.id)
    expect((await jobView(env.DB, cronId)).scheduled).toBe(true)
    await expect(jobAction(env, cronId, 'cancel', false)).rejects.toMatchObject({ status: 403 })
    expect(sql.prepare('SELECT version FROM strategy_versions ORDER BY version').all()).toHaveLength(2)
    await expect(
      createJob(
        env,
        { kind: 'research', inputs: { mode: 'cache', goal: '不同的输入' }, requestId: 'one' },
        actor,
      ),
    ).rejects.toThrow('提交编号')
  })
  it('atomically shares one daily budget, enforces the current cap and never reserves after pause', async () => {
    await settings({ dataDailyPoints: 20 })
    const c1 = await createDiscovery('first'),
      c2 = await createDiscovery('second')
    const results = await Promise.allSettled([
      reserve(c1, 'a', 'points', 10),
      reserve(c2, 'b', 'points', 10),
      reserve(c1, 'c', 'points', 10),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(sql.prepare('SELECT SUM(reserved) AS n FROM usage_reservations').get()?.n).toBe(20)
    await jobAction(env, c1.job.id, 'pause')
    await expect(reserve(c1, 'paused', 'points', 1)).rejects.toThrow('暂停')
    await finish(env, c1.job.id, c1.attempt, true, '完成')
    expect((await getRun(env.DB, c1.job.id)).status).toBe('paused')
    await jobAction(env, c1.job.id, 'resume')
    const resumed = await active(c1.job.id)
    expect(resumed.attempt).toBe(1)
    await settings({ dataDailyPoints: 0 })
    await expect(reserve(resumed, 'new', 'points', 1)).rejects.toThrow('预算不足')
    await jobAction(env, c1.job.id, 'cancel')
    await finish(env, c1.job.id, 1, true, '完成')
    expect((await getRun(env.DB, c1.job.id)).status).toBe('cancelled')
  })
  it('replays successful evidence, redacts echoed keys and ranks only this run’s observed products before bounded child jobs', async () => {
    await settings({ dataDailyPoints: 40, aiDailyMicros: 100_000, researchLimit: 3 })
    const c = await createDiscovery('rank', 66_000)
    const fetched = vi.fn(async () =>
      page([
        goods('3', 10000),
        goods('5', null),
        goods('2', 30000),
        goods('1', 50000),
        goods('2', 30000),
      ]),
    )
    vi.stubGlobal('fetch', fetched)
    const runPage = () => discoverPage(c, 1, ['9711'])
    const first = await stepOnce(c, 'search-1', 'page', runPage)
    expect(first).toMatchObject({ rows: 5, unique: 4, duplicates: 1, matched: 3, missingSold: 1 })
    sql.prepare("DELETE FROM job_steps WHERE step_key='search-1'").run()
    await stepOnce(c, 'search-1', 'page', runPage)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(sql.prepare('SELECT title FROM products LIMIT 1').get()?.title).toBe('[redacted] organizer')
    expect(await advanceQueue(env, c.job, c.settings, c.input, '')).toEqual({
      submitted: 2,
      total: 3,
      legacyComparisonsPending: 0,
    })
    await advanceQueue(env, c.job, c.settings, c.input, '')
    const q = await researchQueue(env.DB, c.job.id, 1, 10)
    expect(q.items.map((i) => [i.totalSold, !!i.childId])).toEqual([
      [50000, true],
      [30000, true],
      [10000, false],
    ])
    expect(await jobView(env.DB, q.items[0].childId!)).toMatchObject({
      steps: [{ key: 'plan', result: { target: { id: 'temu:US:1', total_sold: 50000 } } }],
    })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM job_runs WHERE parent_id IS NOT NULL').get()?.n).toBe(
      2,
    )
  })
  it('rotates through sparse slots after proven free balance refusals, replays, and keeps one daily cap', async () => {
    await settings({ dataDailyPoints: 20 })
    env.GB_APP_KEY_5 = 'fixture-fifth'
    env.GB_APP_SECRET_5 = 'fixture-secret-fifth'
    const c = await createDiscovery()
    const fetched = vi.fn(async (req: Request) =>
      req.headers.get('X-GB-App-Key') === 'fixture-key'
        ? Response.json(
            { code: 402, msg: '积分余额不足' },
            { status: 402, headers: { 'x-gb-price-points': '0' } },
          )
        : page([]),
    )
    vi.stubGlobal('fetch', fetched)
    await discoverPage(c, 1, ['9711'])
    await discoverPage(c, 1, ['9711'])
    const next = await createDiscovery('next')
    await discoverPage(next, 1, ['9711'])
    expect(fetched.mock.calls.map(([r]) => r.headers.get('X-GB-App-Key'))).toEqual([
      'fixture-key',
      'fixture-fifth',
      'fixture-fifth',
    ])
    expect(
      sql.prepare('SELECT credential_slot,actual FROM usage_reservations ORDER BY rowid').all(),
    ).toEqual([
      { credential_slot: 1, actual: 0 },
      { credential_slot: 5, actual: 10 },
      { credential_slot: 5, actual: 10 },
    ])
    const capped = await createDiscovery('capped')
    await expect(discoverPage(capped, 1, ['9711'])).rejects.toThrow('预算不足')
    expect(fetched).toHaveBeenCalledTimes(3)
  })
  it.each([10, 20])(
    'retains a missing receipt against both budgets before switching with cap %s',
    async (cap) => {
      await settings({ dataDailyPoints: cap })
      env.GB_APP_KEY_2 = 'fallback'
      env.GB_APP_SECRET_2 = 'fallback-secret'
      const c = await createDiscovery()
      const fetched = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ code: 1, msg: '余额不足' }, { status: 402 }))
        .mockResolvedValueOnce(page([]))
      vi.stubGlobal('fetch', fetched)
      const action = discoverPage(c, 1, ['9711'])
      if (cap === 10) await expect(action).rejects.toThrow('预算不足')
      else await action
      expect(fetched).toHaveBeenCalledTimes(cap / 10)
      expect(
        sql
          .prepare('SELECT actual,state,reserved FROM usage_reservations WHERE credential_slot=1')
          .get(),
      ).toEqual({ actual: null, state: 'uncertain', reserved: 10 })
    },
  )
  it.each([
    [429, '积分不足', '0'],
    [401, '积分不足', '0'],
    [402, '权限不足', '0'],
    [402, '积分不足', 'invalid'],
    [402, '积分不足', '10'],
  ] as const)('does not fail over on unconfirmed refusal %s %s %s', async (status, msg, points) => {
    await settings({ dataDailyPoints: 20 })
    env.GB_APP_KEY_2 = 'fixture-second'
    env.GB_APP_SECRET_2 = 'fixture-secret-second'
    const c = await createDiscovery()
    const fetched = vi.fn(async () =>
      Response.json(
        { code: 1, msg },
        { status, headers: points === null ? {} : { 'x-gb-price-points': points } },
      ),
    )
    vi.stubGlobal('fetch', fetched)
    await expect(discoverPage(c, 1, ['9711'])).rejects.toThrow()
    expect(fetched).toHaveBeenCalledTimes(1)
  })
  it('charges reviews, discovery and details to the same slots and restores a rotated Worker secret', async () => {
    await settings({ dataDailyPoints: 40 })
    env.GB_APP_KEY_5 = 'fixture-fifth'
    env.GB_APP_SECRET_5 = 'fixture-fifth-secret'
    const refused = () => Response.json({ message: '积分余额不足，请充值' }, { status: 402 })
    const fetched = vi
      .fn()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        Response.json(
          { code: 0, data: { goods: goods('1', 50000) } },
          { headers: { 'x-gb-price-points': '10' } },
        ),
      )
    vi.stubGlobal('fetch', fetched)
    await readGeekbiReviews(env, '123', 0)
    await readGeekbiReviews(env, '123', 0)
    const context = await createDiscovery()
    await discoverPage(context, 1, ['9711'])
    expect(await geekbiSlotHealth(env, 1)).toMatchObject({ balanceRefused: true })
    env.GB_APP_SECRET = 'rotated-secret-only'
    expect(await geekbiSlotHealth(env, 1)).toMatchObject({ balanceRefused: false })
    await refreshFocus(context, 'temu:US:1')
    expect(fetched.mock.calls.map(([r]) => r.headers.get('X-GB-App-Key'))).toEqual([
      'fixture-key',
      'fixture-fifth',
      'fixture-fifth',
      'fixture-key',
    ])
    expect(await geekbiSlotUsage(env.DB)).toEqual([
      { slot: 1, confirmedPoints: 10, pendingPoints: 10 },
      ...[2, 3, 4].map((slot) => ({ slot, confirmedPoints: 0, pendingPoints: 0 })),
      { slot: 5, confirmedPoints: 20, pendingPoints: 0 },
    ])
    expect(await usage(env.DB)).toMatchObject({ dataPoints: 40, unconfirmedDataPoints: 10 })
    await expect(readGeekbiReviews(env, '123', 1)).rejects.toThrow('预算不足')
    expect(fetched).toHaveBeenCalledTimes(4)
  })
  it('prevents concurrent review clicks and other jobs from exceeding the last ten points', async () => {
    await settings({ dataDailyPoints: 10 })
    const context = await createDiscovery()
    const fetched = vi.fn(async () => page([]))
    vi.stubGlobal('fetch', fetched)
    await Promise.allSettled([
      readGeekbiReviews(env, '123', 0),
      readGeekbiReviews(env, '123', 0),
      discoverPage(context, 1, ['9711']),
    ])
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(await usage(env.DB)).toMatchObject({ dataPoints: 10, unconfirmedDataPoints: 0 })
  })
  it.each([
    ['generic 402', () => Response.json({ message: '请求失败' }, { status: 402 })],
    ['auth', () => Response.json({ message: '积分余额不足' }, { status: 401 })],
    ['throttled', () => Response.json({ message: '积分余额不足' }, { status: 429 })],
    ['missing receipt', () => page([], 200, null)],
    [
      'malformed receipt',
      () =>
        Response.json(
          { message: '积分余额不足' },
          { status: 402, headers: { 'x-gb-price-points': 'invalid' } },
        ),
    ],
    [
      'network',
      () => {
        throw new Error('fixture disconnected')
      },
    ],
  ] as const)(
    'does not repeat a review query on %s, even after a second click',
    async (_reason, reply) => {
      await settings({ dataDailyPoints: 100 })
      env.GB_APP_KEY_2 = 'second-key'
      env.GB_APP_SECRET_2 = 'second-secret'
      const fetched = vi.fn(reply)
      vi.stubGlobal('fetch', fetched)
      for (let i = 0; i < 2; i++) await expect(readGeekbiReviews(env, '123', 0)).rejects.toThrow()
      expect(fetched).toHaveBeenCalledTimes(1)
      expect(await geekbiSlotHealth(env, 1)).toMatchObject({ balanceRefused: false })
      expect((await geekbiSlotUsage(env.DB))[0]).toEqual({
        slot: 1,
        confirmedPoints: 0,
        pendingPoints: 10,
      })
    },
  )
  it('checks only the chosen free site directory at zero budget and scopes verification to its credential revision', async () => {
    env.GB_APP_KEY_5 = 'fifth-key'
    env.GB_APP_SECRET_5 = 'fifth-secret'
    const fetched = vi.fn(async (r: Request) => {
      expect(new URL(r.url).pathname).toBe('/api/v2/data/temu/site/list')
      expect(new URL(r.url).search).toBe('')
      expect(r.headers.get('X-GB-App-Key')).toBe('fifth-key')
      expect(r.headers.get('X-GB-Signature')).toBeTruthy()
      return Response.json(
        { code: 0, data: [{ siteId: 48, regionId: 211 }] },
        { headers: { 'x-gb-price-points': '0' } },
      )
    })
    vi.stubGlobal('fetch', fetched)
    await expect(testGeekbiSlot(env, 2)).rejects.toThrow('配置')
    expect(await testGeekbiSlot(env, 5)).toMatchObject({ slot: 5, rows: 1, points: 0 })
    await testGeekbiSlot(env, 5)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(await geekbiSlotHealth(env, 5)).toMatchObject({ testStatus: 'verified' })
    env.GB_APP_SECRET_5 = 'updated-fifth-secret'
    expect(await geekbiSlotHealth(env, 5)).toMatchObject({ testStatus: null })
    fetched.mockResolvedValueOnce(Response.json({ message: '签名错误' }, { status: 401 }))
    await expect(testGeekbiSlot(env, 5)).rejects.toThrow('401')
    expect(await geekbiSlotHealth(env, 5)).toMatchObject({ testStatus: 'failed', balanceRefused: false })
    expect(fetched).toHaveBeenCalledTimes(2)
    expect((await usage(env.DB)).dataPoints).toBe(0)
  })
  it('honors a pre-upgrade Worker binding refusal and allows a later secret-only rotation', async () => {
    await settings({ dataDailyPoints: 10 })
    const ctx = await createDiscovery()
    await reserve(
      ctx,
      'old',
      'points',
      10,
      'old',
      1,
      0,
      createHash('sha256').update(env.GB_APP_KEY!).digest('base64'),
    )
    sql
      .prepare(
        "UPDATE usage_reservations SET balance_refused=1,state='confirmed',actual=0 WHERE step_key='old'",
      )
      .run()
    expect(await geekbiSlotHealth(env, 1)).toMatchObject({ balanceRefused: true })
    env.GB_APP_SECRET = 'rotated'
    expect(await geekbiSlotHealth(env, 1)).toMatchObject({ balanceRefused: false })
  })
  it.each(['rotate', 'new-day'] as const)(
    'permits an explicit review retry after a confirmed zero-point auth failure and %s',
    async (reason) => {
      await settings({ dataDailyPoints: 10 })
      const fetched = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ message: '签名错误' }, { status: 401, headers: { 'x-gb-price-points': '0' } }),
        )
        .mockResolvedValueOnce(page([]))
      vi.stubGlobal('fetch', fetched)
      await expect(readGeekbiReviews(env, '123', 0)).rejects.toThrow('401')
      await expect(readGeekbiReviews(env, '123', 0)).rejects.toThrow('401')
      if (reason === 'rotate') env.GB_APP_SECRET = 'replacement'
      else sql.prepare("UPDATE usage_reservations SET business_date='2025-01-01'").run()
      await readGeekbiReviews(env, '123', 0)
      expect(fetched).toHaveBeenCalledTimes(2)
    },
  )
  it('keeps cached review evidence readable at zero budget and retries a model issue without repurchasing reviews', async () => {
    await settings({ dataDailyPoints: 10 })
    const fetched = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 0, data: { total: 1, list: [{ goodsId: '123', score: 1, comment: 'scratched' }] } },
          { headers: { 'x-gb-price-points': '10' } },
        ),
      )
    vi.stubGlobal('fetch', fetched)
    const gateway = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: 'access denied' } }, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          model: 'fixture-model',
          choices: [{ message: { content: '评论 1 提到刮痕。' } }],
        }),
      )
    const bindings = { ...env, LOCAL_DEVELOPMENT: '1', OPENROUTER_US: { fetch: gateway } }
    const query = (method: string) =>
      api.request(
        'http://127.0.0.1/api/reviews/temu/123',
        {
          method,
          headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        },
        bindings,
      )
    expect(await (await query('POST')).json()).toMatchObject({
      data: { rows: 1, modelIssue: expect.any(String) },
    })
    await settings({ dataDailyPoints: 0 })
    expect(await (await query('POST')).json()).toMatchObject({ data: { summary: '评论 1 提到刮痕。' } })
    expect(await (await query('GET')).json()).toMatchObject({
      report: { data: { rows: 1, withText: 1 } },
    })
    expect((await query('POST')).status).toBe(200)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(gateway).toHaveBeenCalledTimes(2)
  })
  it('explicit retry separately reserves transient confirmed errors but never resends an uncertain transport', async () => {
    await settings({ dataDailyPoints: 60 })
    const c = await createDiscovery()
    const fetched = vi
      .fn()
      .mockResolvedValueOnce(page([], 429, '2'))
      .mockResolvedValueOnce(page([goods('1', 50000)]))
    vi.stubGlobal('fetch', fetched)
    await expect(stepOnce(c, 'search-1', 'page', () => discoverPage(c, 1, ['9711']))).rejects.toThrow(
      '限流',
    )
    await finish(env, c.job.id, 0, false, '限流')
    env.CONNECTIONS_KEY = 'ef'.repeat(32)
    await replaceCredentials(
      env,
      'geekbi',
      { GB_APP_KEY: 'fixture-rotated-app', GB_APP_SECRET: 'fixture-rotated-secret' },
      { id: 'local', local: true },
    )
    await jobAction(env, c.job.id, 'retry')
    const retry = await active(c.job.id)
    await stepOnce(retry, 'search-1', 'page', () => discoverPage(retry, 1, ['9711']))
    expect(fetched.mock.calls.map(([req]) => req.headers.get('X-GB-App-Key'))).toEqual([
      'fixture-key',
      'fixture-rotated-app',
    ])
    expect([...store.keys()]).toHaveLength(2)
    expect((await jobView(env.DB, c.job.id)).usage.dataPoints).toBe(12)
    const unknown = await createDiscovery('uncertain')
    fetched.mockRejectedValueOnce(new Error('fixture lost response'))
    await expect(
      stepOnce(unknown, 'search-1', 'page', () => discoverPage(unknown, 1, ['9711'])),
    ).rejects.toThrow('费用待核对')
    await finish(env, unknown.job.id, 0, false, '待核账')
    await jobAction(env, unknown.job.id, 'retry')
    const resumed = await active(unknown.job.id)
    await expect(
      stepOnce(resumed, 'search-1', 'page', () => discoverPage(resumed, 1, ['9711'])),
    ).rejects.toThrow('费用待人工核对')
    expect(fetched).toHaveBeenCalledTimes(3)
    expect((await jobView(env.DB, unknown.job.id)).usage.unconfirmedDataPoints).toBe(10)
  })
  it('signs the emitted query and validates separate Decisions and Terra contracts, images require a product', async () => {
    const req = await geekRequest(env, 'temu', false, { keyword: 'home & bath', page: '1' })
    const canonical = [
      'GET',
      new URL(req.url).pathname,
      new URL(req.url).search.slice(1),
      req.headers.get('X-GB-Timestamp'),
      req.headers.get('X-GB-Nonce'),
    ].join('\n')
    expect(req.headers.get('X-GB-Signature')).toBe(
      createHmac('sha256', 'fixture-secret').update(canonical).digest('base64'),
    )
    const decision = aiRequest(env, 'decision', { id: 'temu:US:1' })
    expect(new URL(decision.url).pathname).toBe('/api/alpha/decisions')
    expect(await decision.json()).toMatchObject({
      state: expect.any(String),
      questions: { route: { type: 'choice' } },
    })
    expect(() =>
      parseDecision({ answers: { route: { type: 'choice', choice: 'approve', confidence: 1 } } }),
    ).toThrow()
    expect(() => parseTerra({ choices: [{ message: { content: '{"summary":"bad"}' } }] })).toThrow()
    const terra = aiRequest(env, 'terra', { id: 'p' }, 'data:image/jpeg;base64,AAAA')
    const body = (await terra.json()) as { messages: { content: unknown }[] }
    expect(body.messages[1].content).toMatchObject([{ type: 'text' }, { type: 'image_url' }])
    expect(inputsSchema.safeParse({ imageId: crypto.randomUUID() }).success).toBe(false)
  })
  it('runs the Workflow review/observe branches without Terra and preserves manual feedback', async () => {
    await settings({ aiDailyMicros: 100_000, dataDailyPoints: 10 })
    const c = await createDiscovery()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page([goods('1', 50000), goods('2', 30000)])),
    )
    await discoverPage(c, 1, ['9711'])
    sql
      .prepare(
        "INSERT INTO feedback(product_id,stage,lines_json,note,author,created_at) VALUES(?,'follow','[]','人工核对材质',?,?)",
      )
      .run('temu:US:1', actor, new Date().toISOString())
    const worker = Object.assign(Object.create(ResearchWorkflow.prototype) as ResearchWorkflow, { env })
    type Args = Parameters<ResearchWorkflow['run']>
    const step = {
      do: (_: string, ...args: unknown[]) => (args.at(-1) as () => unknown)(),
    } as unknown as Args[1]
    for (const [product, route] of [
      ['1', 'review'],
      ['2', 'observe'],
    ]) {
      const fetcher = vi.fn(async (req: Request) => {
        expect(new URL(req.url).pathname).toBe('/api/alpha/decisions')
        return Response.json({
          answers: {
            route: {
              type: 'choice',
              choice: route,
              confidence: 1,
              probabilities: {
                research: 0,
                observe: Number(route === 'observe'),
                review: Number(route === 'review'),
              },
            },
          },
          usage: { cost: 0.0001 },
        })
      })
      vi.stubGlobal('fetch', fetcher)
      const job = await createJob(
        env,
        { kind: 'research', inputs: { mode: 'live', productId: 'temu:US:' + product } },
        actor,
      )
      const row = await getRun(env.DB, job.id)
      await worker.run({ payload: { runId: job.id }, instanceId: instanceId(row) } as Args[0], step)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await jobView(env.DB, job.id)).toMatchObject({
        status: 'succeeded',
        usage: { aiMicros: 100 },
        steps: expect.arrayContaining([
          expect.objectContaining({
            key: 'amazon-compare',
            result: expect.objectContaining({
              comparisons: [
                expect.objectContaining({ productId: 'temu:US:' + product, status: 'unavailable' }),
              ],
            }),
          }),
          expect.objectContaining({
            key: 'review-task',
            result: expect.objectContaining({ terraRequested: false, watchCreated: product === '2' }),
          }),
        ]),
      })
    }
    expect(
      sql.prepare('SELECT stage,note FROM candidates WHERE product_id=?').get('temu:US:1'),
    ).toMatchObject({ stage: 'follow', note: '人工核对材质' })
    expect(
      sql.prepare('SELECT stage,updated_by FROM candidates WHERE product_id=?').get('temu:US:2'),
    ).toMatchObject({ stage: 'watch', updated_by: 'AI · Decisions' })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM feedback').get()?.n).toBe(1)
  })
  it('looks up only the three products in the pinned batch, replays the comparison and keeps cross-market evidence in the model budget', async () => {
    await settings({ aiDailyMicros: 100_000, dataDailyPoints: 10 })
    const discovery = await createDiscovery()
    const rows = ['1', '2', '3', '4'].map((id) => ({
      ...goods(id, 10000 + Number(id)),
      goodsName: '中文商品 ' + id,
      goodsNameEn: 'Original Spoon ' + id,
      sku: [{ skuId: id, specs: [{ specKey: '容量', specValue: id + ' oz' }] }],
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page(rows)),
    )
    await discoverPage(discovery, 1, ['9711'])
    const job = await createJob(
      env,
      { kind: 'research', inputs: { mode: 'live', goal: '跨平台比较' } },
      actor,
    )
    const c = await active(job.id)
    const plan = (await storedResult(env.DB, job.id, 'plan'))!
    // Mutating today's library must not change the input to research already in flight.
    sql.prepare("UPDATE products SET title='后来修改的标题',min_price=999,variants_json='[]'").run()
    const get = vi.spyOn(env.ARCHIVE, 'get')
    const lookup = vi
      .spyOn(amazon, 'compareAmazonProduct')
      .mockImplementation(async (_env, _run, product) => ({
        productId: String(product.id),
        query: String(product.title_en),
        sourceTitle: String(product.title),
        sourcePrice: Number(product.min_price),
        sourceCurrency: 'USD',
        sourceSold: Number(product.total_sold),
        sourceSpecs: '2 oz',
        checkedAt: '2026-10-31T01:23:45Z',
        status: 'found',
        message: '待人工确认',
        candidates: Array.from({ length: 3 }, (_, i) => ({
          asin: 'B00000000' + i,
          price: 8,
          shipping: null,
          priceStatus: 'available',
          rank: 101,
          rankCategory: 'Kitchen',
          title: '量'.repeat(250),
          specs: '规格'.repeat(100),
          basis: '待核对'.repeat(100),
        })),
      }))
    const ids = ['4', '3', '2'].map((id) => 'temu:US:' + id)
    const decision = { choice: 'research', products: ids }
    const compare = () => runAmazonComparison(env, c.job, plan, decision)
    await stepOnce(c, 'decision', 'fixture', async () => ({ summary: 'fixture', result: decision }))
    const result = await stepOnce(c, 'amazon-compare', 'fixture', compare)
    expect(result.comparisons).toHaveLength(3)
    expect(await stepOnce(c, 'amazon-compare', 'fixture', compare)).toEqual(result)
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenCalledTimes(1)
    for (const [index, id] of ['4', '3', '2'].entries()) {
      expect(lookup.mock.calls[index][2]).toMatchObject({
        id: 'temu:US:' + id,
        min_price: 4,
        title_en: 'Original Spoon ' + id,
      })
      expect(lookup.mock.calls[index][3]).toEqual([
        { skuId: id, specs: [{ key: '容量', value: id + ' oz' }] },
      ])
    }
    const terra = vi.fn(async (req: Request) => {
      const { messages } = (await req.json()) as { messages: { content: string }[] }
      expect(Buffer.byteLength(messages[1].content)).toBeLessThanOrEqual(12_000)
      const input = JSON.parse(messages[1].content)
      expect(input.products.map((p: { id: string }) => p.id)).toEqual(ids)
      expect(input.amazonComparisons.map((p: { productId: string }) => p.productId)).toEqual(ids)
      expect(input.amazonComparisons[0].candidates[0]).toMatchObject({
        price: 8,
        rank: 101,
        rankCategory: 'Kitchen',
      })
      expect(input.products[0]).toMatchObject({ total_sold: 10004, min_price: 4 })
      expect(messages[0].content).toContain('排名不能换算销量')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: '比较待核',
                standardProduct: '',
                differentiation: '',
                missing: ['运费'],
                nextActions: ['核实规格'],
              }),
            },
          },
        ],
        usage: { cost: 0.0001 },
      })
    })
    vi.stubGlobal('fetch', terra)
    await researchStep(c, 'terra', plan)
    expect(terra).toHaveBeenCalledTimes(1)
  })
  it.each([
    [null, 'kitchen bowl'],
    ['{invalid', 'kitchen bowl'],
    [
      JSON.stringify({
        body: { data: { goods: { goodsId: '2', goodsNameEn: 'Unrelated Cheese Grater' } } },
      }),
      'kitchen bowl',
    ],
    [
      JSON.stringify({ body: { data: { goods: { goodsId: '1', goodsNameEn: 'Mixing Bowl' } } } }),
      'mixing bowl',
    ],
  ])(
    'recovers English titles only from the matching detail row and falls back to the pinned title (%#)',
    async (archive, query) => {
      await settings({ aiDailyMicros: 33000, dataDailyPoints: 10 })
      const discovery = await createDiscovery()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => page([{ ...goods('1', 50000), goodsName: 'Kitchen Bowl' }])),
      )
      await discoverPage(discovery, 1, ['9711'])
      const job = await createJob(
        env,
        { kind: 'research', inputs: { mode: 'live', productId: 'temu:US:1' } },
        actor,
      )
      const plan = (await storedResult(env.DB, job.id, 'plan'))!
      const ref = (plan.target as { evidence_ref: string }).evidence_ref
      if (archive === null) store.delete(ref)
      else store.set(ref, archive)
      const step = await runAmazonComparison(env, await getRun(env.DB, job.id), plan, {
        choice: 'observe',
      })
      expect(step.result.comparisons).toMatchObject([
        { productId: 'temu:US:1', query, status: 'unavailable' },
      ])
    },
  )
  it('finds and grades low-volume new arrivals independently of member plans', async () => {
    const asOf = new Date().toISOString()
    const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString()
    expect((await potentialProducts(env.DB, asOf, 1, 20)).total).toBe(0)
    await settings({ dataDailyPoints: 10, scheduleEnabled: true, scheduleTime: '00:00', schedulePreset: 'potential' })
    await runSchedule(env, Date.now())
    const run = sql.prepare("SELECT id FROM job_runs WHERE actor='scheduler'").get()!
    const ctx = await active(String(run.id))
    expect(ctx.input.preset).toBe('potential')
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      expect(new URL(req.url).searchParams.get('sort')).toBe('onSaleTime')
      return page([
        { ...goods('1', 10), onSaleTime: ago(10), updateTime: asOf, daySold: 4, weekSold: 8 },
        { ...goods('2', 30), onSaleTime: ago(31), daySold: 2 },
        { ...goods('3', null), daySold: 2 },
        { ...goods('4', 2), onSaleTime: ago(1), updateTime: asOf, daySold: 1, weekSold: 2 },
      ])
    }))
    await discoverPage(ctx, 1, ['9711'])
    const now = new Date().toISOString()
    const first = await potentialProducts(env.DB, now, 1, 20)
    expect(first.items.map(p=>p.grade)).toEqual(['priority','unknown','undated'])
    const filtered = await potentialProducts(env.DB, now, 5, 1, 'priority', first.items[0].category)
    expect(filtered).toMatchObject({total:1, page:1, items:[{id:'temu:US:1'}]})
  })
  it('refreshes only selected watch products and preserves gaps and zero in historical evidence', async () => {
    await settings({ dataDailyPoints: 30, focusLimit: 1 })
    const before = await createDiscovery('before')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page([goods('1', 50000), goods('2', 30000)])),
    )
    await discoverPage(before, 1, ['9711'])
    sql
      .prepare("INSERT INTO candidates VALUES(?,'watch','[]','关注',?,?)")
      .run('temu:US:1', actor, new Date().toISOString())
    const c = await createDiscovery('daily')
    expect(await jobView(env.DB, c.job.id)).toMatchObject({
      steps: [{ key: 'plan', result: { focus: [{ id: 'temu:US:1' }] } }],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        const url = new URL(req.url)
        expect(url.searchParams.get('regionId')).toBe('211')
        expect(url.searchParams.get('goodsId')).toBe('1')
        return Response.json(
          {
            code: 0,
            data: {
              goods: goods('1', 51000),
              history: [
                { createTime: '2026-10-01T12:00:00+08:00', daySold: 0 },
                { createTime: '2026-10-04T12:00:00+08:00', daySold: 6 },
              ],
            },
          },
          { headers: { 'x-gb-price-points': '10' } },
        )
      }),
    )
    const update = await refreshFocus(c, 'temu:US:1')
    expect(update.result.historyRows).toBe(2)
    const research = await createJob(
      env,
      { kind: 'research', inputs: { mode: 'cache', productId: 'temu:US:1' } },
      actor,
    )
    expect(await jobView(env.DB, research.id)).toMatchObject({
      steps: [
        {
          key: 'plan',
          result: {
            history: [{ day_sold: 6 }, { day_sold: 0 }],
            trend: { observedDates: 2, elapsedDays: 3, daySoldChange: 6 },
          },
        },
      ],
    })
  })
})
