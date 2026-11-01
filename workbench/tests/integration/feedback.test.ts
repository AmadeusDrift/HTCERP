import { expect, it } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import { requiredRole } from '../../apps/api/src/access'
const asin = 'B000ABC123'
function client(response: Response) {
  return new AmazonUS(
    { SP_CLIENT_ID: 'id', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' },
    async (url) =>
      String(url).includes('/auth/o2/') ? Response.json({ access_token: 'token' }) : response,
  )
}
it('keeps unavailable feedback distinct from denied access', async () => {
  expect((await client(new Response(null, { status: 204 })).reviewTopics(asin)).topics).toEqual([])
  await expect(client(new Response(null, { status: 403 })).reviewTopics(asin)).rejects.toMatchObject({
    code: 'FEEDBACK_FORBIDDEN',
  })
})
it('extracts only the requested ASIN metrics and supporting snippets', async () => {
  const data = {
    asin,
    marketplaceId: 'ATVPDKIKX0DER',
    dateRange: { startDate: '2026-01-01', endDate: '2026-06-01' },
    topics: {
      negativeTopics: [
        {
          topic: 'Size',
          asinMetrics: { numberOfMentions: 3 },
          parentAsinMetrics: { numberOfMentions: 77 },
          reviewSnippets: ['Too small'],
        },
      ],
    },
  }
  expect((await client(Response.json(data)).reviewTopics(asin)).topics).toEqual([
    { name: 'Size', mentions: 3, snippets: ['Too small'] },
  ])
})
it('lets members read saved reviews while reserving refresh for administrators', () => {
  expect(requiredRole('POST', '/api/reviews/temu/123')).toBe('admin')
  expect(requiredRole('GET', '/api/reviews/temu/123')).toBe('viewer')
})
