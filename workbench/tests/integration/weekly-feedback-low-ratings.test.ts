import type { WorkflowStep } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import type { OpsBindings } from '../../packages/operations/model'
import { readLowRatings } from '../../packages/weekly-feedback/low-ratings'
import { stageLowRatingListings } from '../../packages/weekly-feedback/low-ratings'
import { investigationFixture } from './assistant-run-fixture'

it('retains dated positive low-rating counts and separates unknown from zero', async () => {
  const date = '2026-11-06'
  const row = JSON.stringify({
    startDate: date,
    endDate: date,
    totals: { reviews: { lowRatingReviewCount: { value: 2 }, totalReviewCount: { value: 5 } } },
    metrics: [
      {
        groupByKey: { asin: 'B000000001' },
        metrics: { reviews: { lowRatingReviewCount: { value: 2 }, totalReviewCount: { value: 3 } } },
      },
      {
        groupByKey: { asin: 'B000000002' },
        metrics: { reviews: { lowRatingReviewCount: { value: 0 }, totalReviewCount: { value: 2 } } },
      },
      {
        groupByKey: { asin: 'B000000003' },
        metrics: { reviews: { lowRatingReviewCount: { value: null } } },
      },
    ],
  })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(row.slice(0, 20)))
      controller.enqueue(encoder.encode(row.slice(20)))
      controller.close()
    },
  })
  expect(await readLowRatings(body)).toEqual({
    days: [{ date, low: 2, total: 5 }],
    hits: [{ date, asin: 'B000000001', low: 2, total: 3 }],
  })
})

it('assigns confirmed Haul SKUs, gives Peter precedence, and preserves manual owners and conflicts', async () => {
  const { db, env } = investigationFixture()
  const market = 'ATVPDKIKX0DER'
  const run = 'weekly-feedback-rules'
  db.exec(`
    INSERT INTO accounts(id,username,role,salt,password_hash) VALUES ('peter','peter','operator','',''),('vita','vita','operator','','');
    INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES ('${run}','SELLER','${market}','2026-11-16','2026-11-18','running');
    INSERT INTO weekly_feedback_owner_rules VALUES
      ('SELLER','${market}','prefix','HUC',0,'peter','bob'),
      ('SELLER','${market}','contains_suffix','.JA-',1,'bob','bob'),
      ('SELLER','${market}','prefix','HUVT',1,'vita','bob');
    INSERT INTO weekly_feedback_owners VALUES ('SELLER','${market}','HUC-MANUAL','bob','manual','bob','2026-11-12');
  `)
  const items = [
    { sku: 'HUC.JA-001', offers: [{ marketplaceId: market, audience: { value: 'BZR' } }] },
    {
      sku: 'HUC-MANUAL',
      attributes: { is_value_stores_item: [{ marketplace_id: market, value: true }] },
    },
    { sku: 'HUVT.JA-003', attributes: { purchasable_offer: [{ audience: 'BZR' }] } },
    { sku: 'HUVT-004', offers: [{ marketplaceId: market, audience: { value: 'ALL' } }] },
    { sku: 'HUVT-005', attributes: { purchasable_offer: [{ audience: 'BZR' }] } },
  ].map((item, i) => ({
    ...item,
    summaries: [{ marketplaceId: market, asin: 'B00000000' + (i + 1) }],
    relationships: [],
  }))
  const mock = vi
    .spyOn(AmazonUS.prototype, 'feedbackListingsByAsin')
    .mockResolvedValue({ numberOfResults: items.length, items })
  const step = {
    do: async (_key: string, callback: () => Promise<unknown>) => callback(),
  } as unknown as WorkflowStep
  try {
    await stageLowRatingListings(
      env as unknown as OpsBindings,
      step,
      run,
      'SELLER',
      null,
      items.map((i) => [i.summaries[0].asin, 1]),
    )
    expect(
      db.prepare('SELECT sku,account_id,source FROM weekly_feedback_owners ORDER BY sku').all(),
    ).toEqual([
      { sku: 'HUC-MANUAL', account_id: 'bob', source: 'manual' },
      { sku: 'HUC.JA-001', account_id: 'peter', source: 'haul-owner-rule' },
      { sku: 'HUVT-005', account_id: 'vita', source: 'haul-owner-rule' },
    ])
  } finally {
    mock.mockRestore()
    db.close()
  }
})
