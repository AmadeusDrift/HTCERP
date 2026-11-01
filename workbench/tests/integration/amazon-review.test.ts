import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppEnv } from '../../apps/api/src/bindings'
import { comparisons } from '../../packages/amazon/routes'

afterEach(() => vi.unstubAllGlobals())
it('keeps every catalog search and review, and queries pricing only for a selected match', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const file of readdirSync('migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort())
      db.exec(readFileSync('migrations/' + file, 'utf8'))
    db.exec(
      "INSERT INTO products(id,external_id,platform,market,title) VALUES ('temu:US:9','9','temu','US','Fixture lamp')",
    )
    function prepare(sql: string, values: SQLInputValue[] = []) {
      const statement = db.prepare(sql)
      return {
        bind: (...params: SQLInputValue[]) => prepare(sql, params),
        run: () => statement.run(...values),
        first: () => statement.get(...values),
        all: () => ({ results: statement.all(...values) }),
      }
    }
    const DB = {
      prepare,
      batch: (stmts: ReturnType<typeof prepare>[]) => {
        db.exec('BEGIN')
        try {
          const result = stmts.map((s) => s.all())
          db.exec('COMMIT')
          return result
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
    } as unknown as D1Database
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('actor', {
          id: 'review',
          username: 'review',
          email: 'review@test.invalid',
          role: 'operator',
          local: false,
          position: null,
        })
        await next()
      })
      .route('/api', comparisons)
    const req = (suffix: string, body?: unknown) =>
      app.request(
        '/api/products/temu:US:9/amazon' + suffix,
        body
          ? {
              method: 'POST',
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }
          : undefined,
        { DB, SP_CLIENT_ID: 'fixture', SP_CLIENT_SECRET: 'fixture', SP_REFRESH_TOKEN: 'fixture' },
      )
    let populated = true,
      size = 'small'
    const send = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('auth/o2/token')) return Response.json({ access_token: 'fixture' })
      if (url.includes('/catalog/'))
        return Response.json({
          items: populated
            ? [
                {
                  asin: 'B000000001',
                  summaries: [{ marketplaceId: 'ATVPDKIKX0DER', itemName: 'Fixture', size }],
                },
              ]
            : [],
          pagination: populated ? { nextToken: 'next' } : {},
        })
      return Response.json({
        payload: { Offers: [{ ListingPrice: { Amount: 9, CurrencyCode: 'USD' } }] },
      })
    })
    vi.stubGlobal('fetch', send)
    expect((await req('')).status).toBe(200)
    const first = (await (await req('/search', { query: 'lamp' })).json()) as {
      matches: { searchId: string }[]
    }
    expect(first).toMatchObject({
      matches: [{ asin: 'B000000001', status: 'pending', price: null }],
      searches: [{ returned: 1, hasMore: true }],
    })
    const searchId = first.matches[0].searchId
    expect(
      await (
        await req('/matches/B000000001', { searchId, status: 'confirmed', note: '规格与包装相符' })
      ).json(),
    ).toMatchObject({
      matches: [{ price: 9, priceStatus: 'available', reviewer: 'review@test.invalid' }],
    })
    populated = false
    expect(await (await req('/search', { query: 'lamp', after: searchId })).json()).toMatchObject({
      matches: [{ status: 'confirmed', price: 9 }],
      searches: [{ returned: 0 }, { returned: 1, hasMore: false }],
    })
    populated = true
    size = 'large'
    expect(await (await req('/search', { query: 'large lamp' })).json()).toMatchObject({
      matches: [{ status: 'pending', note: '', specs: 'large' }],
    })
    expect(db.prepare('SELECT count(*) n FROM amazon_reviews').get()).toMatchObject({ n: 1 })
    expect(send.mock.calls.filter(([input]) => String(input).includes('/pricing/'))).toHaveLength(1)
  } finally {
    db.close()
  }
})
