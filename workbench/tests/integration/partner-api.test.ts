import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import app from '../../apps/api/src/index'
import { AmazonUS } from '../../packages/amazon/adapter'
import { sourceConnection } from '../../packages/inventory-sync/source'
import { PartnerStore } from '../../packages/partner-api/store'
import { investigationFixture } from './assistant-run-fixture'

it.each([12.34, '12.34'])('normalizes documented and live Haul sales amounts (%s)', async (amount) => {
  const amazon = new AmazonUS(
    {
      SP_CLIENT_ID: 'app',
      SP_CLIENT_SECRET: 'secret',
      SP_REFRESH_TOKEN: 'refresh',
    },
    vi.fn(async (url) =>
      new URL(String(url)).hostname === 'api.amazon.com'
        ? Response.json({ access_token: 'server-only' })
        : Response.json({
            payload: [
              {
                unitCount: 2,
                orderItemCount: 2,
                interval: 'a--b',
                totalSales: { amount, currencyCode: 'USD' },
              },
            ],
          }),
    ),
  )
  expect(await amazon.partnerSales('2026-11-15T08:00:00Z', '2026-11-16T08:00:00Z')).toMatchObject({
    totalSales: { amount: '12.34', currencyCode: 'USD' },
    unitCount: 2,
  })
})

it('grants only reads by default and authorizes writes by client and operation', async () => {
  const { db, env } = investigationFixture()
  const bindings = {
    ...env,
    SP_CLIENT_ID: 'app',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string) =>
      new URL(url).hostname === 'api.amazon.com'
        ? Response.json({ access_token: 'server-access' })
        : Response.json({ numberOfResults: 0, items: [] }),
    ),
  )
  try {
    db.exec("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'SELLERTEST')")
    const cookie = 'a'.repeat(64)
    db.exec("UPDATE accounts SET role='admin' WHERE id='bob'")
    db.prepare(
      'INSERT INTO account_sessions (token_hash,account_id,auth_version,expires_at) VALUES(?,?,1,?)',
    ).run(createHash('sha256').update(cookie).digest('hex'), 'bob', Math.floor(Date.now() / 1000) + 3600)
    const admin = (path: string, body?: object) =>
      app.request(
        'https://htcerp.app/api/partner-admin' + path,
        {
          headers: {
            cookie: '__Host-workbench_session=' + cookie,
            'content-type': 'application/json',
            origin: 'https://htcerp.app',
          },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        },
        bindings,
      )
    const created = await admin('/clients', { name: 'ERP test', days: 7 })
    expect(created.status).toBe(201)
    const { id, token, permissions } = (await created.json()) as {
      id: string
      token: string
      permissions: string[]
    }
    expect(permissions).toContain('sales.read')
    expect(permissions).not.toContain('inventory.request')
    expect(JSON.stringify(await (await admin('')).json())).not.toContain(token)
    const partner = (path: string, body?: object, key = 'request-one') =>
      app.request(
        'https://htcerp.app/api/partner/v1' + path,
        {
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        },
        bindings,
      )
    const stock = { sku: 'TEST-SKU', quantity: 4 }
    expect((await partner('/inventory/requests', stock)).status).toBe(403)
    expect(
      (
        await admin('/clients/' + id + '/permissions', {
          permission: 'inventory.request',
          enabled: true,
        })
      ).status,
    ).toBe(200)
    expect((await partner('/inventory/requests', stock)).status).toBe(403)
    expect((await admin('/writes', { enabled: true })).status).toBe(200)
    const first = await partner('/inventory/requests', stock)
    expect(first.status).toBe(202)
    const firstBody = (await first.json()) as { id: string }
    expect(await (await partner('/inventory/requests', stock)).json()).toEqual(firstBody)
    expect((await partner('/inventory/requests', { ...stock, quantity: 5 })).status).toBe(409)
    expect((await partner('/inventory/quantity', stock)).status).toBe(403)
    expect((await partner('/prices', { sku: stock.sku, cents: 499 })).status).toBe(403)
    const listed = await admin('')
    expect(await listed.json()).toMatchObject({
      audit: expect.arrayContaining([
        expect.objectContaining({ client_id: id, operation: 'inventory.request', status: 202 }),
      ]),
    })
    expect((await admin('/clients/' + id + '/active', { enabled: false })).status).toBe(200)
    expect((await partner('/connection')).status).toBe(401)
    expect((await admin('/clients/' + id + '/active', { enabled: true })).status).toBe(200)
    expect((await partner('/connection')).status).toBe(200)
    expect((await admin('/requests/' + firstBody.id + '/approve', {})).status).toBe(409)
    const next = await partner('/inventory/requests', stock, 'request-two')
    expect(next.status).toBe(202)
    const { id: nextId } = (await next.json()) as { id: string }
    expect(
      (await admin('/clients/' + id + '/permissions', { permission: 'catalog.read', enabled: true }))
        .status,
    ).toBe(200)
    expect(await (await admin('/requests/' + nextId + '/approve', {})).json()).toMatchObject({
      status: 'APPROVED',
    })
    bindings.SP_REFRESH_TOKEN = 'different-seller-credentials'
    const blocked = await partner('/connection')
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: 'CONNECTION_CHANGED' })
  } finally {
    vi.unstubAllGlobals()
    db.close()
  }
})

it('uses an explicit price audience, runs validation first, and never repeats an approved mutation', async () => {
  const { db, env } = investigationFixture()
  const bindings = {
    ...env,
    SP_CLIENT_ID: 'fixture-app',
    SP_CLIENT_SECRET: 'fixture-secret',
    SP_REFRESH_TOKEN: 'fixture-refresh',
  }
  const market = 'ATVPDKIKX0DER'
  const attributes = {
    purchasable_offer: ['ALL', 'BZR'].map((audience) => ({
      marketplace_id: market,
      audience,
      currency: 'USD',
      our_price: [{ schedule: [{ value_with_tax: 4.5 }] }],
    })),
  }
  const patched: {
    preview: boolean
    body: { patches: { value: typeof attributes.purchasable_offer }[] }
  }[] = []
  const send = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const parsed = new URL(url)
    if (parsed.hostname === 'api.amazon.com') return Response.json({ access_token: 'server-only' })
    if (init?.method === 'PATCH') {
      const preview = parsed.searchParams.get('mode') === 'VALIDATION_PREVIEW'
      patched.push({ preview, body: JSON.parse(String(init.body)) })
      return Response.json({ sku: 'S', status: preview ? 'VALID' : 'ACCEPTED', submissionId: 'abc' })
    }
    return Response.json({
      sku: 'S',
      summaries: [{ marketplaceId: market, productType: 'PRODUCT' }],
      attributes,
    })
  })
  vi.stubGlobal('fetch', send)
  try {
    db.exec("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'SELLERTEST')")
    db.exec("UPDATE accounts SET role='admin' WHERE id='bob'")
    const cookie = 'c'.repeat(64)
    db.prepare('INSERT INTO account_sessions VALUES(?,?,1,?)').run(
      createHash('sha256').update(cookie).digest('hex'),
      'bob',
      Math.floor(Date.now() / 1000) + 3600,
    )
    const store = new PartnerStore(env.DB)
    const { identity } = await sourceConnection(bindings)
    const client = await store.create('Price review', 7, identity)
    await store.setPermission(client.id, 'price.write', true)
    await store.setWrites(true)
    const submitted = await app.request(
      'https://htcerp.app/api/partner/v1/prices',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + client.token,
          'content-type': 'application/json',
          'idempotency-key': 'price-test-001',
        },
        body: JSON.stringify({ sku: 'S', audience: 'BZR', cents: 499, expectedCents: 450 }),
      },
      bindings,
    )
    expect(submitted.status).toBe(202)
    expect(send).not.toHaveBeenCalled()
    const request = (await submitted.json()) as { id: string }
    const approve = () =>
      app.request(
        'https://htcerp.app/api/partner-admin/requests/' + request.id + '/approve',
        {
          method: 'POST',
          headers: { cookie: '__Host-workbench_session=' + cookie, 'content-type': 'application/json' },
          body: '{}',
        },
        bindings,
      )
    expect(await (await approve()).json()).toMatchObject({ status: 'ACCEPTED', reference: 'abc' })
    expect(patched.map((x) => x.preview)).toEqual([true, false])
    expect(patched[1].body.patches[0]).toEqual({
      op: 'merge',
      path: '/attributes/purchasable_offer',
      value: [
        {
          marketplace_id: market,
          currency: 'USD',
          audience: 'BZR',
          our_price: [{ schedule: [{ value_with_tax: 4.99 }] }],
        },
      ],
    })
    expect((await approve()).status).toBe(409)
    expect(patched).toHaveLength(2)
    const rotated = await store.rotate(client.id, 7, identity)
    const connection = (token: string) =>
      app.request(
        'https://htcerp.app/api/partner/v1/connection',
        { headers: { authorization: 'Bearer ' + token } },
        bindings,
      )
    expect((await connection(client.token)).status).toBe(401)
    expect((await connection(rotated.token)).status).toBe(200)
  } finally {
    vi.unstubAllGlobals()
    db.close()
  }
})
