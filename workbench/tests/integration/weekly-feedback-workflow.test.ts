import type { WorkflowStep } from 'cloudflare:workers'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppEnv } from '../../apps/api/src/bindings'
import { AmazonUS } from '../../packages/amazon/adapter'
import { PublicError } from '../../packages/contracts/errors'
import type { OpsBindings } from '../../packages/operations/model'
import {
  launchWeeklyFeedback,
  scheduleWeeklyFeedback,
  weeklyFeedbackWorkflow,
} from '../../packages/weekly-feedback/jobs'
import { weeklyFeedbackRoutes } from '../../packages/weekly-feedback/routes'
import { investigationFixture } from './assistant-run-fixture'

afterEach(() => vi.restoreAllMocks())
const step = {
  do: async (_key: string, ...args: unknown[]) => {
    const config = args.length > 1 ? (args[0] as { retries?: { limit: number } }) : undefined
    const callback = args.at(-1) as (ctx: { attempt: number }) => Promise<unknown>
    for (let attempt = 1; ; attempt++) {
      try {
        return await callback({ attempt })
      } catch (error) {
        if (attempt > (config?.retries?.limit ?? 0)) throw error
      }
    }
  },
} as unknown as WorkflowStep
const summary = (asin: string) => [{ marketplaceId: 'ATVPDKIKX0DER', asin, itemName: 'Mug' }]
const relationship = [{ marketplaceId: 'ATVPDKIKX0DER', relationships: [] }]

it('publishes only the ASINs with new low ratings, including those without themes', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-filter','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-11','running')",
    )
    const submit = vi.spyOn(AmazonUS.prototype, 'submitDataKioskQuery').mockResolvedValue('query')
    vi.spyOn(AmazonUS.prototype, 'dataKioskQueryStatus').mockResolvedValue({
      processingStatus: 'DONE',
      dataDocumentId: 'document',
    })
    const reviews = (low: number, total: number) => ({
      reviews: { lowRatingReviewCount: { value: low }, totalReviewCount: { value: total } },
    })
    const lines = Array.from({ length: 7 }, (_, i) => {
      const date = `2026-11-0${i + 2}`
      return JSON.stringify({
        startDate: date,
        endDate: date,
        totals: reviews(1, 2),
        metrics: [
          { groupByKey: { asin: 'B000000001' }, metrics: reviews(1, 1) },
          { groupByKey: { asin: 'B000000002' }, metrics: reviews(0, 1) },
        ],
      })
    }).join('\n')
    vi.spyOn(AmazonUS.prototype, 'dataKioskDocument').mockResolvedValue(new Response(lines).body!)
    const full = vi.spyOn(AmazonUS.prototype, 'feedbackListings')
    const listings = vi
      .spyOn(AmazonUS.prototype, 'feedbackListingsByAsin')
      .mockResolvedValue({
        numberOfResults: 1,
        items: [{ sku: 'A', summaries: summary('B000000001'), relationships: relationship }],
      })
    const topics = vi
      .spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockResolvedValue({ asin: 'B000000001', period: null, topics: [] })
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(
      env as unknown as OpsBindings,
      'weekly-feedback-filter',
      step,
      false,
      false,
      true,
    )
    expect(submit.mock.calls[0][0]).toContain('startDate: "2026-11-02", endDate: "2026-11-08"')
    expect(full).not.toHaveBeenCalled()
    expect(listings).toHaveBeenCalledWith('SELLERA', ['B000000001'], undefined)
    expect(topics.mock.calls.map(([asin]) => asin)).toEqual(['B000000001'])
    expect(db.prepare('SELECT status FROM weekly_feedback_runs').get()?.status).toBe('done')
    expect(
      db
        .prepare("SELECT status,json_extract(data,'$.lowRatingCount') low FROM weekly_feedback_items")
        .all(),
    ).toEqual([{ status: 'no_data', low: 7 }])
  } finally {
    db.close()
  }
})

it('reuses last week’s roles and only looks up new or changed SKU relationships', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`
      INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES
        ('old','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-09','partial'),
        ('new','SELLERA','ATVPDKIKX0DER','2026-11-16','2026-11-16','running');
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES
        ('old','A','B000000001','Mug','child'),
        ('old','B','B000000002','Mug','parent'),
        ('old','D','B000000004','Mug','unknown');
    `)
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({
      numberOfResults: 4,
      items: [
        { sku: 'A', summaries: summary('B000000001') },
        { sku: 'B', summaries: summary('B000000005') },
        { sku: 'C', summaries: summary('B000000003') },
        { sku: 'D', summaries: summary('B000000004') },
      ],
    })
    const batch = vi.spyOn(AmazonUS.prototype, 'feedbackListingsBySku').mockResolvedValue({
      items: [
        { sku: 'B', summaries: summary('B000000005'), relationships: relationship },
        { sku: 'C', summaries: summary('B000000003'), relationships: relationship },
      ],
    })
    const topics = vi
      .spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockImplementation(async (asin) => ({ asin, period: null, topics: [] }))
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'new', step)
    expect(batch.mock.calls).toEqual([['SELLERA', ['B', 'C']]])
    expect(
      db
        .prepare("SELECT role FROM weekly_feedback_listings WHERE run='new' ORDER BY sku")
        .all()
        .map((x) => x.role),
    ).toEqual(['child', 'standalone', 'standalone', 'unknown'])
    expect(topics.mock.calls.map(([asin]) => asin)).toEqual(['B000000001', 'B000000003', 'B000000005'])
  } finally {
    db.close()
  }
})

it('backfills only verified historical listing roles and checks newly eligible ASINs once', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`
      INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status,reported)
      VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-09','partial',5);
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES
        ('weekly-feedback-r','A','B000000001','Mug','unknown'),
        ('weekly-feedback-r','B','B000000002','Mug','unknown'),
        ('weekly-feedback-r','C','B000000003','Mug','unknown'),
        ('weekly-feedback-r','D','B000000004','Mug','unknown'),
        ('weekly-feedback-r','E','B000000001','Mug','unknown');
    `)
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({ numberOfResults: 0, items: [] })
    const batch = vi.spyOn(AmazonUS.prototype, 'feedbackListingsBySku').mockResolvedValue({
      items: [
        { sku: 'A', summaries: summary('B000000001'), relationships: [] },
        {
          sku: 'B',
          summaries: summary('B000000002'),
          attributes: { parentage_level: [{ marketplace_id: 'ATVPDKIKX0DER', value: 'parent' }] },
        },
        {
          sku: 'C',
          summaries: summary('B000000003'),
          attributes: { parentage_level: [{ marketplace_id: 'ATVPDKIKX0DER', value: 'child' }] },
        },
        { sku: 'D', summaries: summary('B000000004') },
        { sku: 'E', summaries: summary('B000000001'), relationships: [] },
      ],
    })
    const topics = vi
      .spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockImplementation(async (asin) => ({ asin, period: null, topics: [] }))
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step, true, true)
    expect(batch).toHaveBeenCalledWith('SELLERA', ['A', 'B', 'C', 'D', 'E'])
    expect(
      db
        .prepare('SELECT role FROM weekly_feedback_listings ORDER BY sku')
        .all()
        .map((x) => x.role),
    ).toEqual(['standalone', 'parent', 'child', 'unknown', 'standalone'])
    expect(topics.mock.calls.map(([asin]) => asin)).toEqual(['B000000001', 'B000000003'])
  } finally {
    db.close()
  }
})

it('keeps the primary negative topics when the secondary ranking has a different period', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-09','running')",
    )
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({
      numberOfResults: 1,
      items: [{ sku: 'A', summaries: summary('B000000001'), relationships: relationship }],
    })
    vi.spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockResolvedValueOnce({
        asin: 'B000000001',
        period: { startDate: '2026-05-01', endDate: '2026-11-01' },
        topics: [{ name: 'Size', mentions: 2, snippets: ['Too small'] }],
      })
      .mockResolvedValueOnce({ asin: 'B000000001', period: null, topics: [] })
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step)
    const item = db.prepare('SELECT status,data FROM weekly_feedback_items').get()
    expect(item?.status).toBe('available')
    expect(JSON.parse(String(item?.data))).toMatchObject({ topics: [{ name: 'Size', mentions: 2 }] })
  } finally {
    db.close()
  }
})

it('publishes when a workflow recovery completes after the report was marked failed', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-09','running')",
    )
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({ numberOfResults: 0, items: [] })
    const replay = {
      do: async (key: string, ...args: unknown[]) => {
        if (key === 'weekly-feedback-publish') {
          db.exec(
            "UPDATE weekly_feedback_runs SET status='failed',error='差评主题读取失败，请重试或检查连接。'",
          )
        }
        const callback = args.at(-1) as () => Promise<unknown>
        return callback()
      },
    } as unknown as WorkflowStep
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', replay)
    expect(db.prepare('SELECT status,error FROM weekly_feedback_runs').get()).toMatchObject({
      status: 'done',
      error: null,
    })
  } finally {
    db.close()
  }
})

it('retries transient upstream failures without turning them into terminal failed snapshots', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-02','2026-11-04','running')",
    )
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({
      numberOfResults: 1,
      items: [{ sku: 'A', summaries: summary('B000000001'), relationships: relationship }],
    })
    const topics = vi
      .spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockRejectedValueOnce(new PublicError('SOURCE_RATE_LIMIT', '限流', 429, 'amazon', true))
      .mockResolvedValue({ asin: 'B000000001', period: null, topics: [] })
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step)
    expect(topics).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT status FROM weekly_feedback_items').get()?.status).toBe('no_data')
    expect(db.prepare('SELECT status FROM weekly_feedback_runs').get()?.status).toBe('done')
  } finally {
    db.close()
  }
})

it('republishes an already scanned historical week by querying only the failed ASINs', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`
      INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status,reported,incomplete,error)
      VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-09','2026-11-09','failed',3,1,'差评主题读取失败，请重试或检查连接。');
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES
        ('weekly-feedback-r','A','B000000001','Mug','standalone'),
        ('weekly-feedback-r','B','B000000002','Mug','standalone');
      INSERT INTO weekly_feedback_items(run,asin,status,error) VALUES
        ('weekly-feedback-r','B000000001','failed','Amazon 两次主题查询的统计区间不同，请重新生成周报。'),
        ('weekly-feedback-r','B000000002','no_data',NULL);
    `)
    const listings = vi.spyOn(AmazonUS.prototype, 'feedbackListings')
    const topics = vi
      .spyOn(AmazonUS.prototype, 'reviewTopics')
      .mockResolvedValueOnce({
        asin: 'B000000001',
        period: { startDate: '2026-05-01', endDate: '2026-11-01' },
        topics: [{ name: 'Size', mentions: 2, snippets: [] }],
      })
      .mockResolvedValueOnce({ asin: 'B000000001', period: null, topics: [] })
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step, true)
    expect(listings).not.toHaveBeenCalled()
    expect(topics.mock.calls.map(([asin]) => asin)).toEqual(['B000000001', 'B000000001'])
    expect(
      db.prepare("SELECT status,error FROM weekly_feedback_items WHERE asin='B000000001'").get(),
    ).toMatchObject({ status: 'available', error: null })
    expect(db.prepare('SELECT week,status,incomplete FROM weekly_feedback_runs').get()).toMatchObject({
      week: '2026-11-09',
      status: 'partial',
      incomplete: 1,
    })
  } finally {
    db.close()
  }
})

it('collects an ASIN once for multiple SKUs and isolates missing feedback from failures', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO title_audit_store VALUES(1,'SELLERA',0); INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-02','2026-11-04','running')",
    )
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({
      numberOfResults: 5,
      items: [
        { sku: 'A', summaries: summary('B000000001'), relationships: relationship },
        { sku: 'B', summaries: summary('B000000001'), relationships: relationship },
        { sku: 'C', summaries: summary('B000000002'), relationships: relationship },
        { sku: 'D', summaries: summary('B000000003'), relationships: relationship },
        {
          sku: 'P',
          summaries: summary('B000000004'),
          relationships: [
            { marketplaceId: 'ATVPDKIKX0DER', relationships: [{ type: 'VARIATION', childSkus: ['A'] }] },
          ],
        },
      ],
    })
    const topics = vi.spyOn(AmazonUS.prototype, 'reviewTopics').mockImplementation(async (asin) => {
      if (asin === 'B000000003') throw new Error('upstream secret must not leak')
      return {
        asin,
        period: { startDate: '2026-05-01', endDate: '2026-11-01' },
        topics:
          asin === 'B000000002'
            ? []
            : [
                {
                  name: 'Print Quality',
                  mentions: 12,
                  snippets: ['Blurry print'],
                  occurrence: 8,
                  impact: -0.2,
                },
              ],
      }
    })
    vi.spyOn(AmazonUS.prototype, 'mainImages').mockResolvedValue([
      { asin: 'B000000001', url: 'https://m.media-amazon.com/images/I/test.jpg' },
    ])
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step)
    expect(db.prepare('SELECT status FROM weekly_feedback_runs').get()?.status).toBe('partial')
    expect(
      db.prepare("SELECT status FROM weekly_feedback_items WHERE asin='B000000002'").get()?.status,
    ).toBe('no_data')
    expect(
      db.prepare("SELECT status,error FROM weekly_feedback_items WHERE asin='B000000003'").get(),
    ).toMatchObject({ status: 'failed', error: '差评主题读取失败，请重试或检查连接。' })
    expect(topics.mock.calls.filter(([asin]) => asin === 'B000000001')).toHaveLength(2)
    expect(topics.mock.calls.some(([asin]) => asin === 'B000000004')).toBe(false)
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('actor', {
          id: 'bob',
          email: 'bob@test',
          username: 'bob',
          role: 'operator',
          local: false,
          position: null,
        })
        await next()
      })
      .route('/api/weekly-feedback', weeklyFeedbackRoutes)
    const read = await app.request('/api/weekly-feedback?q=A', {}, env)
    expect(await read.json()).toMatchObject({
      rows: [
        { asin: 'B000000001', skus: ['A', 'B'], topics: [{ name: 'Print Quality', label: '印刷质量' }] },
      ],
    })
    const action = {
      run: 'weekly-feedback-r',
      asin: 'B000000001',
      topic: 'Print Quality',
      state: 'working',
      note: '核查印刷',
    }
    expect(
      (
        await app.request(
          '/api/weekly-feedback/action',
          { method: 'POST', body: JSON.stringify(action) },
          env,
        )
      ).status,
    ).toBe(200)
    const draft = await app.request('/api/weekly-feedback/notification?run=weekly-feedback-r', {}, env)
    expect(await draft.json()).toMatchObject({
      sent: false,
      ready: false,
      unassigned: 1,
      text: expect.stringContaining('SKU：A / B'),
    })
    expect(db.prepare('SELECT count(*) n FROM weekly_feedback_action_history').get()?.n).toBe(1)
  } finally {
    db.close()
  }
})

it('launches the filtered weekly report once at Wednesday Beijing 09:00', async () => {
  const { db, env } = investigationFixture()
  const create = vi.fn(async () => ({ id: 'test' }))
  const bindings = { ...env, RUNNER: { create } } as unknown as OpsBindings
  try {
    db.exec("INSERT INTO title_audit_store VALUES(1,'SELLERA',0)")
    const monday = Date.parse('2026-11-09T01:00:00Z')
    const wednesday = monday + 2 * 86400000
    await scheduleWeeklyFeedback(bindings, wednesday)
    expect(create).not.toHaveBeenCalled()
    db.exec('UPDATE weekly_feedback_settings SET enabled=1')
    await scheduleWeeklyFeedback(bindings, monday)
    await scheduleWeeklyFeedback(bindings, wednesday + 30 * 60000)
    expect(create).not.toHaveBeenCalled()
    await scheduleWeeklyFeedback(bindings, wednesday)
    await scheduleWeeklyFeedback(bindings, wednesday)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      id: 'weekly-feedback-SELLERA-2026-11-09',
      params: { runId: 'weekly-feedback-SELLERA-2026-11-09', filterLowRatings: true },
    })
    expect((await launchWeeklyFeedback(bindings, 'SELLERA')).id).toBeTruthy()
    expect(create).toHaveBeenCalledTimes(1)
  } finally {
    db.close()
  }
})

it('marks incomplete listing scans honestly instead of publishing complete coverage', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(
      "INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('weekly-feedback-r','SELLERA','ATVPDKIKX0DER','2026-11-02','2026-11-04','running')",
    )
    vi.spyOn(AmazonUS.prototype, 'feedbackListings').mockResolvedValue({ numberOfResults: 2, items: [] })
    await weeklyFeedbackWorkflow(env as unknown as OpsBindings, 'weekly-feedback-r', step)
    expect(db.prepare('SELECT status,incomplete FROM weekly_feedback_runs').get()).toMatchObject({
      status: 'partial',
      incomplete: 2,
    })
  } finally {
    db.close()
  }
})
