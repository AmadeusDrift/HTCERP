import { afterEach, expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import {
  feedbackWeek,
  listingProduct,
  mergeTopics,
  reasonFor,
} from '../../packages/weekly-feedback/model'

afterEach(() => vi.restoreAllMocks())

it('uses the Monday of the Beijing week across UTC and year boundaries', () => {
  expect(feedbackWeek(Date.parse('2026-11-01T16:00:00Z'))).toBe('2026-11-02')
  expect(feedbackWeek(Date.parse('2026-11-01T15:59:59Z'))).toBe('2026-10-26')
  expect(feedbackWeek(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-12-28')
})

it('merges two rankings without double-counting mentions and preserves evidence', () => {
  const topic = { name: 'Print Quality', mentions: 12, snippets: ['Blurry print'] }
  const result = mergeTopics([topic], [{ ...topic, snippets: ['Blurry print', 'Faded ink'] }])
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({
    name: 'Print Quality',
    mentions: 12,
    snippets: ['Blurry print', 'Faded ink'],
  })
  expect(reasonFor('Print Quality').label).toBe('印刷质量')
  expect(reasonFor('Unfamiliar Topic').label).toBe('待人工归类')
})

it('does not attribute parent or unknown relationships to a sellable child', () => {
  const base = {
    sku: 'S',
    summaries: [{ marketplaceId: 'ATVPDKIKX0DER', asin: 'B000000001', itemName: 'Mug' }],
  }
  expect(listingProduct(base).role).toBe('unknown')
  expect(
    listingProduct({ ...base, relationships: [{ marketplaceId: 'ATVPDKIKX0DER', relationships: [] }] })
      .role,
  ).toBe('standalone')
  expect(
    listingProduct({
      ...base,
      relationships: [
        { marketplaceId: 'ATVPDKIKX0DER', relationships: [{ type: 'VARIATION', childSkus: ['C'] }] },
      ],
    }).role,
  ).toBe('parent')
  expect(
    listingProduct({
      ...base,
      relationships: [
        { marketplaceId: 'ATVPDKIKX0DER', relationships: [{ type: 'VARIATION', parentSkus: ['P'] }] },
      ],
    }).role,
  ).toBe('child')
})

it('requests rating-impact ranking and keeps the statistical period', async () => {
  const send = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('auth/o2/token')
      ? Response.json({ access_token: 'test' })
      : Response.json({
          asin: 'B000000001',
          marketplaceId: 'ATVPDKIKX0DER',
          dateRange: { startDate: '2026-05-01', endDate: '2026-11-01' },
          topics: {
            negativeTopics: [
              {
                topic: 'Print Quality',
                asinMetrics: { numberOfMentions: 12, occurrencePercentage: 8, starRatingImpact: -0.2 },
                reviewSnippets: ['Blurry print'],
              },
            ],
          },
        }),
  )
  const api = new AmazonUS(
    { SP_CLIENT_ID: 'id', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' },
    send,
  )
  const data = await api.reviewTopics('B000000001', 'STAR_RATING_IMPACT')
  expect(new URL(String(send.mock.calls[1][0])).searchParams.get('sortBy')).toBe('STAR_RATING_IMPACT')
  expect(data).toMatchObject({
    period: { startDate: '2026-05-01', endDate: '2026-11-01' },
    topics: [{ mentions: 12, occurrence: 8, impact: -0.2 }],
  })
})
