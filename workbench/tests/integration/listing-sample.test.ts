import { describe, expect, it, vi } from 'vitest'
import { requiredRole } from '../../apps/api/src/access'
import { AmazonUS } from '../../packages/amazon/adapter'

const us = 'ATVPDKIKX0DER'
const ca = 'A2EUQ1WTGCTBG2'
const binding = {
  SP_CLIENT_ID: 'fixture-client',
  SP_CLIENT_SECRET: 'fixture-secret',
  SP_REFRESH_TOKEN: 'fixture-refresh',
}
function stub(items: unknown[]) {
  const send = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ access_token: 'fixture-access' }))
    .mockResolvedValueOnce(
      Response.json({ numberOfResults: 500, pagination: { nextToken: 'private-cursor' }, items }),
    )
  return { send, client: new AmazonUS(binding, send) }
}
const group = (relationships: unknown[], marketplaceId = us) => [{ marketplaceId, relationships }]
describe('US listing sample', () => {
  it('reads one page only and reports aggregate coverage, distinct variation roles and US dates', async () => {
    const { client, send } = stub([
      {
        sku: 'PRIVATE-PARENT',
        summaries: [{ marketplaceId: us, createdDate: '2026-05-11T00:00:00Z' }],
        relationships: group([{ type: 'VARIATION', childSkus: ['PRIVATE-CHILD'] }]),
      },
      {
        sku: 'PRIVATE-CHILD',
        summaries: [
          { marketplaceId: ca, createdDate: '2026-05-08T10:00:00Z' },
          { marketplaceId: us, createdDate: 'invalid' },
        ],
        relationships: group([{ type: 'VARIATION', parentSkus: ['PRIVATE-PARENT'] }]),
      },
      { sku: 'PRIVATE-SINGLE', relationships: group([]) },
      { sku: ' ', relationships: group([], ca) },
      { sku: 'PRIVATE-MISSING' },
    ])
    expect(await client.searchListingsItems('AB123456789')).toEqual({
      sampled: 5,
      withSku: 4,
      withCreatedDate: 1,
      parent: 1,
      child: 1,
      standalone: 1,
      unknown: 2,
    })
    expect(send).toHaveBeenCalledTimes(2)
    const [url, init] = send.mock.calls[1]
    expect(new URL(url).pathname).toBe('/listings/2021-08-01/items/AB123456789')
    expect(init.method ?? 'GET').toBe('GET')
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      marketplaceIds: us,
      includedData: 'summaries,relationships',
      sortBy: 'createdDate',
      sortOrder: 'DESC',
      pageSize: '5',
    })
  })
  it('separates missing, package, conflicting and incomplete relationships from explicit standalone', async () => {
    const { client } = stub([
      { relationships: [] },
      { relationships: [{ marketplaceId: us }] },
      { relationships: group([{ type: 'PACKAGE_HIERARCHY', childSkus: ['a'] }]) },
      { relationships: group([{ type: 'VARIATION', childSkus: ['a'], parentSkus: ['b'] }]) },
      { relationships: group([{ type: 'VARIATION' }]) },
    ])
    expect(await client.searchListingsItems('AB123456789')).toMatchObject({
      sampled: 5,
      unknown: 5,
      standalone: 0,
    })
  })
  it('accepts an empty page, rejects oversize pages and refuses malformed seller IDs before network I/O', async () => {
    const empty = stub([])
    await expect(empty.client.searchListingsItems('AB123456789')).resolves.toMatchObject({ sampled: 0 })
    await expect(
      stub(Array(6).fill({})).client.searchListingsItems('AB123456789'),
    ).rejects.toMatchObject({ code: 'DATA_INCOMPLETE' })
    const bad = stub([])
    await expect(bad.client.searchListingsItems('AB/invalid')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(bad.send).not.toHaveBeenCalled()
    expect(requiredRole('POST', '/api/connections/amazon/listing-fields')).toBe('admin')
  })
})
