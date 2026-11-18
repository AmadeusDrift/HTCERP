import { expect, it, vi } from 'vitest'
import app from '../../apps/api/src/index'
import { AmazonUS } from '../../packages/amazon/adapter'
import { parseReport, SourceStore, sourceConnection } from '../../packages/inventory-sync/source'
import { inventory, syncPage } from '../../packages/partner-api/reads'
import { PartnerStore } from '../../packages/partner-api/store'
import { livePriceCents } from '../../packages/partner-api/writes'
import { investigationFixture } from './assistant-run-fixture'

const market = 'ATVPDKIKX0DER'
const seller = 'SELLERTEST'
const identity = { seller, revision: 'test-revision' }
const since = '2026-11-15T00:00:00.000Z'
const until = '2026-11-15T00:30:00.000Z'
const midpoint = '2026-11-15T00:15:00.000Z'

it('splits a crowded listing window and resumes each half without skipping or crossing its boundary', async () => {
  const { db, env } = investigationFixture()
  try {
    const store = new PartnerStore(env.DB)
    const grant = await store.create('test', 7, identity)
    const client = await store.requireClient(grant.id)
    const item = (sku: string, stamp: string) => ({
      sku,
      attributes: { is_value_stores_item: [{ value: true }] },
      summaries: [{ marketplaceId: market, createdDate: since, lastUpdatedDate: stamp }],
      relationships: [{ marketplaceId: market, relationships: [] }],
    })
    const history: string[][] = []
    const amazon = new AmazonUS(
      { SP_CLIENT_ID: 'id', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' },
      vi.fn(async (endpoint) => {
        const u = new URL(String(endpoint))
        if (u.hostname === 'api.amazon.com') return Response.json({ access_token: 'token' })
        const from = u.searchParams.get('lastUpdatedAfter')!
        const to = u.searchParams.get('lastUpdatedBefore')!
        const page = u.searchParams.get('pageToken')
        history.push([from, to, page ?? ''])
        if (from === since && to === until) return Response.json({ numberOfResults: 1000, items: [] })
        if (from === since && page === null)
          return Response.json({
            numberOfResults: 2,
            items: [item('A', since)],
            pagination: { nextToken: 'page-two' },
          })
        if (from === since)
          return Response.json({
            numberOfResults: 2,
            items: [item('B', since), item('BOUNDARY', midpoint)],
          })
        return Response.json({ numberOfResults: 1, items: [item('BOUNDARY', midpoint)] })
      }),
    )
    let cursor: string | undefined
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const result = await syncPage(store, client, amazon, 'listings.read', { since, until, cursor })
      seen.push(...result.items.map((row) => row.sku))
      cursor = result.next_cursor ?? undefined
    }
    expect(seen).toEqual(['A', 'B', 'BOUNDARY'])
    expect(cursor).toBeUndefined()
    expect(history).toEqual([
      [since, until, ''],
      [since, midpoint, ''],
      [since, midpoint, 'page-two'],
      [midpoint, until, ''],
    ])
  } finally {
    db.close()
  }
})

it('returns FNSKUs from the exact Haul report generation and never uses entries from MAIN', async () => {
  const { db, env } = investigationFixture()
  try {
    const store = new SourceStore(env.DB)
    await store.begin('test-gen', seller, 55, 50, 52)
    const input = new Response(
      'sku\tfnsku\tafn-fulfillable-quantity\tstore\nA-J1T\tX000000001\t3\tLow-Cost Store\nA-J1T\tX000000002\t3\tLow-Cost Store\nA-J1T\tX000000099\t99\tMAIN\n',
    )
    const rows = []
    for await (const row of parseReport(input.body!, 'inventory')) rows.push(row)
    await store.stage('test-gen', 'inventory', rows, 0)
    db.exec(
      "UPDATE inventory_source_runs SET state='COMPLETE', connection_revision='test-revision' WHERE id='test-gen'; INSERT INTO inventory_source_current VALUES('SELLERTEST','test-gen',60)",
    )
    expect(
      await inventory(env.DB, { seller, amazon_revision: identity.revision }, 'A-J1T'),
    ).toMatchObject({
      item: { sku: 'A-J1T', sellable: 3, fnsku: null, fnskus: ['X000000001', 'X000000002'] },
    })
    await expect(
      inventory(env.DB, { seller, amazon_revision: 'new-credentials' }, 'A-J1T'),
    ).rejects.toMatchObject({ status: 503 })
  } finally {
    db.close()
  }
})

it('confirms price only for a unique live offer with the exact audience and currency', () => {
  const input = { sku: 'S', audience: 'BZR' as const, cents: 499, expectedCents: 450 }
  const submitted = {
    sku: 'S',
    attributes: { purchasable_offer: [{ audience: 'BZR', our_price: 499 }] },
  }
  expect(livePriceCents(submitted, input)).toBeNull()
  const regular = {
    marketplaceId: market,
    audience: { value: 'ALL' },
    price: { amount: '4.99', currency: 'USD' },
  }
  const haul = { ...regular, audience: { value: 'BZR' }, price: { amount: '4.50', currency: 'USD' } }
  expect(livePriceCents({ ...submitted, offers: [regular, haul] }, input)).toBe(450)
  expect(livePriceCents({ ...submitted, offers: [regular, haul, haul] }, input)).toBeNull()
})

it('forwards upstream Retry-After and blocks further Amazon calls until that window has elapsed', async () => {
  const { db, env } = investigationFixture()
  const bindings = {
    ...env,
    SP_CLIENT_ID: 'id',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
  }
  const upstream = vi.fn(async (url: URL | string) =>
    new URL(String(url)).hostname === 'api.amazon.com'
      ? Response.json({ access_token: 'token' })
      : new Response('{}', { status: 429, headers: { 'Retry-After': '37' } }),
  )
  vi.stubGlobal('fetch', upstream)
  try {
    db.exec("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'SELLERTEST')")
    const store = new PartnerStore(env.DB)
    const grant = await store.create('test', 7, (await sourceConnection(bindings)).identity)
    await store.setPermission(grant.id, 'orders.read', true)
    const url = 'https://htcerp.app/api/partner/v1/orders?' + new URLSearchParams({ since, until })
    const request = () =>
      app.request(url, { headers: { authorization: 'Bearer ' + grant.token } }, bindings)
    const first = await request()
    expect(first.status).toBe(429)
    expect(first.headers.get('Retry-After')).toBe('37')
    const second = await request()
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThanOrEqual(30)
    expect(
      upstream.mock.calls.filter(([p]) => new URL(String(p)).hostname !== 'api.amazon.com'),
    ).toHaveLength(1)
  } finally {
    vi.unstubAllGlobals()
    db.close()
  }
})
