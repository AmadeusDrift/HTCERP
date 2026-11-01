import { describe, expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'

const binding = { SP_CLIENT_ID: 'fixture', SP_CLIENT_SECRET: 'fixture', SP_REFRESH_TOKEN: 'fixture' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
describe('Amazon US catalog and evidence', () => {
  it('checks only US Haul order lines and returns aggregate field coverage', async () => {
    const channel = { marketplaceId: 'ATVPDKIKX0DER' }
    const line = {
      quantityOrdered: 1,
      product: { sellerSku: 'sample-jIt' },
      proceeds: {
        breakdowns: [{ type: 'ITEM', subtotal: { amount: '0.00', currencyCode: 'USD' } }],
      },
    }
    const send = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'sample-token' }))
      .mockResolvedValueOnce(
        json({
          orders: [
            {
              salesChannel: channel,
              programs: ['AMAZON_HAUL'],
              orderItems: [line, { product: { sellerSku: 'standard' } }, {}],
            },
            { salesChannel: channel, programs: [], orderItems: [line] },
          ],
        }),
      )
    const sample = await new AmazonUS(binding, send).checkHaulOrderFields()
    expect(sample).toMatchObject({
      orders: 2,
      haulOrders: 1,
      haulRows: 3,
      jit: 1,
      standard: 1,
      missingSku: 1,
      withQuantity: 1,
      withItemAmount: 1,
    })
    expect(JSON.stringify(sample)).not.toContain('sample-jIt')
    const url = new URL(send.mock.calls[1][0])
    expect(url.searchParams.get('includedData')).toBe('PROCEEDS')
    expect(url.searchParams.get('maxResultsPerPage')).toBe('5')
  })
  it('prevents calls without configured secrets', async () => {
    const send = vi.fn()
    await expect(new AmazonUS({}, send).search('lamp')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(send).not.toHaveBeenCalled()
  })
  it('stores returned rank context, limits coverage, and keeps missing price empty', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'test' }))
      .mockResolvedValueOnce(
        json({
          pagination: { nextToken: 'next' },
          items: [
            {
              asin: 'B000000001',
              summaries: [
                {
                  marketplaceId: 'ATVPDKIKX0DER',
                  itemName: 'Desk lamp',
                  size: 'Small',
                  packageQuantity: 1,
                },
              ],
              salesRanks: [
                {
                  marketplaceId: 'ATVPDKIKX0DER',
                  displayGroupRanks: [{ rank: 120, title: 'Lighting' }],
                },
              ],
            },
          ],
        }),
      )
    const result = await new AmazonUS(binding, send).search('desk lamp')
    expect(result.hasMore).toBe(true)
    expect(result.items[0]).toMatchObject({
      asin: 'B000000001',
      rank: 120,
      rankCategory: 'Lighting',
      specs: 'Small',
      packageQuantity: 1,
      price: null,
    })
    expect(String(send.mock.calls[1][0])).toContain('marketplaceIds=ATVPDKIKX0DER')
  })
  it('distinguishes zero search hits, malformed responses and rate limits', async () => {
    const run = (reply: Response) =>
      new AmazonUS(
        binding,
        vi
          .fn()
          .mockResolvedValueOnce(json({ access_token: 'x' }))
          .mockResolvedValueOnce(reply),
      ).search('shoe')
    expect((await run(json({ items: [] }))).items).toEqual([])
    await expect(run(json({}))).rejects.toMatchObject({ code: 'DATA_INCOMPLETE' })
    await expect(run(json({ errors: [{ message: 'sensitive fixture' }] }, 429))).rejects.toMatchObject({
      code: 'SOURCE_RATE_LIMIT',
    })
  })
  it('separates listing price from shipping and unavailable offer data', async () => {
    const run = (value: unknown) =>
      new AmazonUS(
        binding,
        vi
          .fn()
          .mockResolvedValueOnce(json({ access_token: 'x' }))
          .mockResolvedValueOnce(json(value)),
      ).offer('B000000001')
    expect(
      await run({
        payload: {
          Offers: [
            {
              ListingPrice: { Amount: 9.25, CurrencyCode: 'USD' },
              Shipping: { Amount: 3, CurrencyCode: 'USD' },
            },
          ],
        },
      }),
    ).toMatchObject({ price: 9.25, currency: 'USD', shipping: 3 })
    expect(await run({ payload: { Offers: [] } })).toMatchObject({ price: null, currency: null })
  })
  it('removes echoed credentials and the exchanged access token from successful catalog evidence', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'fixture-access-token' }))
      .mockResolvedValueOnce(
        json({
          items: [
            {
              asin: 'B000000001',
              summaries: [
                {
                  marketplaceId: 'ATVPDKIKX0DER',
                  itemName: 'fixture-secret in title',
                  brand: 'fixture-access-token',
                },
              ],
            },
          ],
        }),
      )
    const result = await new AmazonUS(
      {
        SP_CLIENT_ID: 'fixture-id',
        SP_CLIENT_SECRET: 'fixture-secret',
        SP_REFRESH_TOKEN: 'fixture-refresh',
      },
      send,
    ).search('lamp')
    expect(result.items[0]).toMatchObject({ title: '[redacted] in title', specs: '[redacted]' })
  })
})
