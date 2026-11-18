import { afterEach, expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import { acquirePartnerOrders } from '../../packages/amazon/request-pacing'
import { investigationFixture } from './assistant-run-fixture'

afterEach(() => vi.restoreAllMocks())
it('admits Haul pages through the shared quota and blocks other order readers after an upstream 429', async () => {
  const { db, env } = investigationFixture()
  const now = Date.parse('2026-11-17T12:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  db.prepare('INSERT INTO partner_orders_budget VALUES(1,8,0.0556,?,0)').run(now)
  const credentials = { SP_CLIENT_ID: 'test', SP_CLIENT_SECRET: 'test', SP_REFRESH_TOKEN: 'test' }
  const send = vi.fn().mockImplementation(async (url: URL | string) => new URL(url).pathname === '/auth/o2/token'
    ? Response.json({ access_token: 'test-token' })
    : Response.json({}, { status: 429, headers: { 'Retry-After': '90', 'x-amzn-RateLimit-Limit': '0.0556' } }))
  const start = '2026-11-17T08:00:00Z', end = '2026-11-17T11:30:00Z'
  try {
    await expect(new AmazonUS(credentials, send, env.DB).haulSalesPage(start, end))
      .rejects.toMatchObject({ code: 'SOURCE_THROTTLED', retryAfterSeconds: 90 })
    const budget = db.prepare('SELECT tokens, blocked_until FROM partner_orders_budget').get()
    expect(budget).toMatchObject({ tokens: 0, blocked_until: now + 90000 })
    await expect(new AmazonUS(credentials, send, env.DB).partnerOrders(start, end))
      .rejects.toMatchObject({ code: 'SOURCE_THROTTLED', retryAfterSeconds: 90 })
    expect(send.mock.calls.filter(([url]) => new URL(url).pathname === '/orders/2026-01-01/orders')).toHaveLength(1)
  } finally {
    db.close()
  }
})

it('protects one shared token for a starved performance run without increasing the upstream budget', async () => {
  const { db, env } = investigationFixture()
  const now = Date.parse('2026-11-17T12:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  db.prepare('INSERT INTO partner_orders_budget VALUES(1,1.25,0.0556,?,0)').run(now)
  db.exec(`INSERT INTO performance_sync_runs(id,seller,connection_revision,basis,from_at,through_at,status,started_at,updated_at)
    VALUES('waiting','store','rev','updated','2026-11-17T08:00:00Z','2026-11-17T11:57:00Z','running','2026-11-17T11:58:00Z','2026-11-17T11:58:00Z')`)
  try {
    await expect(acquirePartnerOrders(env.DB)).rejects.toMatchObject({
      code: 'SOURCE_THROTTLED',
      retryAfterSeconds: 14,
    })
    expect(db.prepare('SELECT tokens FROM partner_orders_budget').get()?.tokens).toBe(1.25)
    await acquirePartnerOrders(env.DB, true)
    expect(db.prepare('SELECT tokens FROM partner_orders_budget').get()?.tokens).toBe(0.25)
    await expect(acquirePartnerOrders(env.DB, true)).rejects.toMatchObject({ code: 'SOURCE_THROTTLED' })
  } finally {
    db.close()
  }
})

it('releases the protected token after progress and still respects an Amazon cooldown', async () => {
  const { db, env } = investigationFixture()
  const now = Date.parse('2026-11-17T12:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  db.prepare('INSERT INTO partner_orders_budget VALUES(1,1.25,0.0556,?,0)').run(now)
  db.exec(`INSERT INTO performance_sync_runs(id,seller,connection_revision,basis,from_at,through_at,status,started_at,updated_at)
    VALUES('progress','store','rev','updated','2026-11-17T08:00:00Z','2026-11-17T11:57:00Z','running','2026-11-17T11:58:00Z','2026-11-17T12:00:00.000Z')`)
  try {
    await acquirePartnerOrders(env.DB)
    db.prepare('UPDATE partner_orders_budget SET tokens=10,blocked_until=?').run(now + 120000)
    await expect(acquirePartnerOrders(env.DB, true)).rejects.toMatchObject({ retryAfterSeconds: 120 })
    expect(db.prepare('SELECT tokens FROM partner_orders_budget').get()?.tokens).toBe(10)
  } finally {
    db.close()
  }
})
