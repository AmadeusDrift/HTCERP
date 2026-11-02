import type { WorkflowStep } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResearchWorkflow } from '../../apps/jobs/src/index'
import {
  collectAssistantJobs,
  confirmAssistantProposal,
  createAssistantProposal,
  type OnlineAction,
  submitAssistantJobs,
} from '../../packages/assistant/online'
import { assistantRunRow, createAssistantRun } from '../../packages/assistant/runs'
import { summarizeComments } from '../../packages/connections/temu-reviews'
import { runAssistantOperation } from '../../packages/operations/assistant-actions'
import { getRun } from '../../packages/operations/model'
import { investigationFixture } from './assistant-run-fixture'

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }))
let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
  f.db.exec(
    "UPDATE accounts SET role='admin' WHERE id='alice'; UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.dataDailyPoints',1000,'$.aiDailyMicros',1000000); INSERT INTO products(id,platform,market,external_id,title,currency,min_price,total_sold,updated_at,fetched_at) VALUES('temu:US:1','temu','US','1','Measuring Spoon Set','USD',3,100,'2026-11-01','2026-11-01'),('amazon:US:B000000001','amazon','US','B000000001','Spoon','USD',4,100,'2026-11-01','2026-11-01')",
  )
  Object.assign(f.env, {
    GB_APP_KEY: 'fixture-key',
    GB_APP_SECRET: 'fixture-secret',
    SP_CLIENT_ID: 'fixture',
    SP_CLIENT_SECRET: 'fixture-secret',
    SP_REFRESH_TOKEN: 'fixture-refresh',
    RUNNER: { create: vi.fn(async () => ({ id: 'child' })) },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  f.db.close()
})
const step = {
  do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)(),
} as unknown as WorkflowStep
async function child(operation: OnlineAction['operation'], overrides: Partial<OnlineAction> = {}) {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线验证', {})
  const action = {
    operation,
    productId: 'temu:US:1',
    platform: 'temu',
    pages: 1,
    calls: 8,
    childResearch: 0,
    maxDataPoints: 10,
    maxAiMicros: 33000,
    writeWatchPool: false,
    ...overrides,
  }
  const p = await createAssistantProposal(f.env, 'alice', run.id, {
    maxDataPoints: 100,
    maxAiMicros: 360000,
    actions: [action],
  })
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))
  const link = f.db.prepare('SELECT * FROM assistant_job_links').get()!
  const job = await getRun(f.env.DB, String(link.job_id))
  return { run, job, link }
}
async function execute(job: Awaited<ReturnType<typeof getRun>>) {
  await ResearchWorkflow.prototype.run.call(
    { env: f.env } as unknown as ResearchWorkflow,
    { payload: { runId: job.id }, instanceId: 'job-' + job.id + '-' + job.attempt } as Parameters<
      ResearchWorkflow['run']
    >[0],
    step,
  )
  return getRun(f.env.DB, job.id)
}
it('a product refresh invokes one archived paid detail request and updates only the approved product', async () => {
  const requests = vi.fn(async () =>
    Response.json(
      {
        code: 0,
        data: {
          goods: {
            goodsId: '1',
            goodsName: 'Refreshed Spoon',
            minPrice: 2,
            goodsNameEn: 'Refreshed Spoon',
            sold: 200,
            updateTime: '2026-11-02T00:00:00Z',
            siteId: 48,
          },
          history: [],
        },
      },
      { headers: { 'x-gb-price-points': '10' } },
    ),
  )
  vi.stubGlobal('fetch', requests)
  const c = await child('product_refresh', { maxAiMicros: 0, calls: 1 })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(requests).toHaveBeenCalledTimes(1)
  expect(f.db.prepare("SELECT title FROM products WHERE id='temu:US:1'").get()?.title).toBe(
    'Refreshed Spoon',
  )
  expect(
    f.db.prepare('SELECT assistant_run_id,assistant_link_id,actual,state FROM usage_reservations').get(),
  ).toMatchObject({
    assistant_run_id: c.run.id,
    assistant_link_id: c.link.id,
    actual: 10,
    state: 'confirmed',
  })
  expect(f.db.prepare('SELECT count(*) n FROM candidates').get()?.n).toBe(0)
})
it('Temu review refresh reserves, queues, archives and settles source points plus model micros, replaying neither request', async () => {
  const requests = vi.fn(async () =>
    Response.json(
      { code: 0, data: { total: 1, list: [{ goodsId: '1', score: 1, comment: 'Handle was loose' }] } },
      { headers: { 'x-gb-price-points': '10' } },
    ),
  )
  vi.stubGlobal('fetch', requests)
  f.fetch.mockResolvedValue(
    Response.json({
      model: 'fixture',
      choices: [{ message: { content: '产品问题：手柄松动，依据评论1。' } }],
      usage: { cost: 0.00001 },
    }),
  )
  const c = await child('reviews_refresh', { calls: 2, maxAiMicros: 30000 })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(requests).toHaveBeenCalledTimes(1)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  const usage = f.db.prepare('SELECT unit,actual,state FROM usage_reservations ORDER BY rowid').all()
  expect(usage).toEqual([
    { unit: 'points', actual: 10, state: 'confirmed' },
    { unit: 'micros', actual: 10, state: 'confirmed' },
  ])
  expect(f.db.prepare('SELECT calls_used FROM assistant_job_links').get()?.calls_used).toBe(2)
  expect(f.db.prepare('SELECT report_json FROM product_review_reports').get()?.report_json).toContain(
    '手柄松动',
  )
  await execute(await getRun(f.env.DB, c.job.id))
  expect(f.fetch).toHaveBeenCalledTimes(1)
})
it('Amazon review refresh uses the official feedback endpoint within its exact approved two-call limit', async () => {
  const requests = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('auth/o2')
      ? Response.json({ access_token: 'fixture' })
      : new Response(null, { status: 204 }),
  )
  vi.stubGlobal('fetch', requests)
  const c = await child('reviews_refresh', {
    productId: 'amazon:US:B000000001',
    platform: 'amazon',
    calls: 2,
    maxDataPoints: 0,
    maxAiMicros: 0,
  })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(requests).toHaveBeenCalledTimes(2)
  expect(f.db.prepare('SELECT calls_used FROM assistant_job_links').get()?.calls_used).toBe(2)
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('Amazon backfill performs only official comparison requests and never silently calls a research model', async () => {
  const requests = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('auth/o2')
      ? Response.json({ access_token: 'fixture' })
      : Response.json({ items: [] }),
  )
  vi.stubGlobal('fetch', requests)
  const c = await child('amazon_backfill', { calls: 5, maxDataPoints: 0, maxAiMicros: 0 })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(requests.mock.calls.some(([input]) => String(input).includes('/catalog/'))).toBe(true)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT count(*) n FROM candidates').get()?.n).toBe(0)
})
it('research defaults to analysis only while normal paid research and comparison evidence are preserved', async () => {
  const requests = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('auth/o2')
      ? Response.json({ access_token: 'fixture' })
      : Response.json({ items: [] }),
  )
  vi.stubGlobal('fetch', requests)
  f.fetch.mockResolvedValueOnce(
    Response.json({
      answers: {
        route: {
          type: 'choice',
          choice: 'observe',
          confidence: 1,
          probabilities: { research: 0, observe: 1, review: 0 },
        },
      },
      usage: { cost: 0.00001 },
    }),
  )
  const c = await child('research', { calls: 8, maxDataPoints: 0, maxAiMicros: 33000 })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT count(*) n FROM candidates').get()?.n).toBe(0)
  expect(
    f.db.prepare("SELECT summary FROM job_steps WHERE step_key='review-task'").get()?.summary,
  ).toContain('仅分析')
})
it('manual comment summaries use the shared daily ledger and replay archived summaries without another charge', async () => {
  f.fetch.mockResolvedValue(
    Response.json({
      model: 'fixture',
      choices: [{ message: { content: '依据评论1，材质有破损。' } }],
      usage: { cost: 0.00001 },
    }),
  )
  const sample = { goodsId: '1', total: 1, rows: 1, withText: 1, comments: ['material broken'] }
  await summarizeComments(f.env, sample)
  await summarizeComments(f.env, sample)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT unit,actual,state FROM usage_reservations').all()).toEqual([
    { unit: 'micros', actual: 10, state: 'confirmed' },
  ])
})

it('discovery creates approved research links by splitting its existing AI and call allocation exactly once', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 0,
          data: {
            hasMore: false,
            list: [
              {
                goodsId: '1',
                goodsName: 'Spoon 1',
                goodsNameEn: 'Measuring Spoon Set',
                minPrice: 3,
                sold: 100,
                siteId: 48,
                catItems: [{ catId: 9711, parentCatId: 0, catName: 'Kitchen' }],
                updateTime: '2026-11-02T00:00:00Z',
              },
              {
                goodsId: '2',
                goodsName: 'Spoon 2',
                goodsNameEn: 'Measuring Spoon Set',
                minPrice: 4,
                sold: 200,
                siteId: 48,
                catItems: [{ catId: 9711, parentCatId: 0, catName: 'Kitchen' }],
                updateTime: '2026-11-02T00:00:00Z',
              },
            ],
          },
        },
        { headers: { 'x-gb-price-points': '10' } },
      ),
    ),
  )
  const c = await child('discovery', {
    productId: undefined,
    keyword: 'spoon',
    categoryId: '9711',
    calls: 17,
    childResearch: 2,
    maxAiMicros: 66000,
  })
  expect((await execute(c.job)).status).toBe('succeeded')
  await collectAssistantJobs(f.env, await assistantRunRow(f.env.DB, c.run.id))
  await collectAssistantJobs(f.env, await assistantRunRow(f.env.DB, c.run.id))
  const links = f.db
    .prepare(
      'SELECT allocated_micros,calls_limit,calls_used,operation FROM assistant_job_links ORDER BY operation',
    )
    .all()
  expect(links).toHaveLength(3)
  expect(links.reduce((n, l) => n + Number(l.allocated_micros), 0)).toBe(66000)
  expect(links.reduce((n, l) => n + Number(l.calls_limit), 0)).toBe(17)
  await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, c.run.id))
  expect(f.db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(3)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('approved watch writes are explicit while analysis-only remains the default', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('auth/o2')
        ? Response.json({ access_token: 'fixture' })
        : Response.json({ items: [] }),
    ),
  )
  f.fetch.mockResolvedValueOnce(
    Response.json({
      answers: {
        route: {
          type: 'choice',
          choice: 'observe',
          confidence: 1,
          probabilities: { research: 0, observe: 1, review: 0 },
        },
      },
      usage: { cost: 0.00001 },
    }),
  )
  const c = await child('research', { maxDataPoints: 0, maxAiMicros: 33000, writeWatchPool: true })
  expect((await execute(c.job)).status).toBe('succeeded')
  expect(f.db.prepare('SELECT count(*) n FROM candidates').get()?.n).toBe(1)
})
it('manual summaries preserve samples at zero budget and unknown model cost is retained without a resend', async () => {
  const sample = { goodsId: '1', total: 1, rows: 1, withText: 1, comments: ['broken'] }
  f.db.exec("UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',0)")
  expect(await summarizeComments(f.env, sample)).toMatchObject({
    summary: null,
    modelIssue: expect.any(String),
  })
  expect(f.fetch).not.toHaveBeenCalled()
  f.db.exec(
    "UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',100000)",
  )
  f.fetch.mockResolvedValueOnce(
    Response.json({ model: 'fixture', choices: [{ message: { content: '破损' } }] }),
  )
  await summarizeComments(f.env, sample)
  await summarizeComments(f.env, sample)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT reserved,actual,state FROM usage_reservations').get()).toEqual({
    reserved: 30000,
    actual: null,
    state: 'uncertain',
  })
})
it('an exhausted declared call limit prevents review AI send and releases the report lease without releasing unknown charges', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { code: 0, data: { total: 1, list: [{ goodsId: '1', score: 1, comment: 'loose' }] } },
        { headers: { 'x-gb-price-points': '10' } },
      ),
    ),
  )
  const c = await child('reviews_refresh', { calls: 1, maxAiMicros: 30000 })
  expect((await execute(c.job)).status).toBe('partial')
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT lease_id FROM product_review_reports').get()?.lease_id).toBeNull()
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(1)
})
it('manual review source and AI calls cannot consume already committed investigation budgets', async () => {
  const { readGeekbiReviews } = await import('../../packages/operations/geekbi-direct')
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '保留预算', {})
  const proposal = await createAssistantProposal(f.env, 'alice', run.id, {
    maxDataPoints: 10,
    maxAiMicros: 33000,
    actions: [
      {
        operation: 'product_refresh',
        productId: 'temu:US:1',
        calls: 1,
        maxDataPoints: 10,
        maxAiMicros: 0,
      },
      { operation: 'research', productId: 'temu:US:1', calls: 8, maxDataPoints: 0, maxAiMicros: 33000 },
    ],
  })
  f.db.exec(
    "UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.dataDailyPoints',10,'$.aiDailyMicros',33000)",
  )
  await confirmAssistantProposal(f.env, 'alice', run.id, proposal.id)
  const sample = { goodsId: '1', total: 1, rows: 1, withText: 1, comments: ['loose'] }
  expect(await summarizeComments(f.env, sample)).toMatchObject({
    summary: null,
    modelIssue: expect.any(String),
  })
  await expect(readGeekbiReviews(f.env, '1', 0)).rejects.toThrow('预算')
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('oversized multibyte comment requests preserve the sample without sending AI or creating a reservation', async () => {
  const sample = {
    goodsId: '1',
    total: 30,
    rows: 30,
    withText: 30,
    comments: Array.from({ length: 30 }, () => '破'.repeat(900)),
  }
  const report = await summarizeComments(f.env, sample)
  expect(report).toMatchObject({
    summary: null,
    modelIssue: expect.stringMatching(/上限|超/),
    rows: 30,
    withText: 30,
  })
  expect(report.comments).toEqual(sample.comments)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE unit='micros'").get()?.n).toBe(0)
})
it('an oversized saved review sample stops the child before AI reservation and keeps the acquired source evidence', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 0,
          data: {
            total: 30,
            list: Array.from({ length: 30 }, () => ({
              goodsId: '1',
              score: 1,
              comment: '破'.repeat(900),
            })),
          },
        },
        { headers: { 'x-gb-price-points': '10' } },
      ),
    ),
  )
  const c = await child('reviews_refresh', { calls: 2, maxAiMicros: 30000 })
  expect((await execute(c.job)).status).toBe('partial')
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE unit='micros'").get()?.n).toBe(0)
  const source = f.db.prepare("SELECT result_json FROM job_steps WHERE step_key='reviews-source'").get()!
  expect(JSON.parse(String(source.result_json)).comments).toHaveLength(30)
  expect(f.db.prepare("SELECT actual,state FROM usage_reservations WHERE unit='points'").get()).toEqual({
    actual: 10,
    state: 'confirmed',
  })
})
