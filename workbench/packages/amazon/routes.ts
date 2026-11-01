import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv, Bindings } from '../../apps/api/src/bindings'
import { connectionStatus, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { AmazonUS } from './adapter'
import { productAutomation } from './research-links'

export const comparisons = new Hono<AppEnv>()
const base = '/products/:id/amazon'
async function parse<T>(value: Promise<unknown>, schema: z.ZodType<T>) {
  const result = schema.safeParse(await value.catch(() => null))
  if (!result.success) throw new PublicError('INVALID_INPUT', '请检查输入字段及长度。', 400)
  return result.data
}
async function panel(env: Bindings, id: string) {
  const [matches, searches] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT m.asin,m.latest_search AS searchId,m.status,m.note,m.reviewed_at AS reviewedAt,m.reviewer,e.snapshot,
      s.fetched_at AS fetchedAt,s.query, p.price,p.currency,p.shipping,p.status AS priceStatus,p.fetched_at AS priceFetchedAt
      FROM amazon_matches m JOIN amazon_catalog_evidence e ON e.search_id=m.latest_search AND e.asin=m.asin
      JOIN amazon_searches s ON s.id=e.search_id LEFT JOIN amazon_prices p ON p.id=(
      SELECT MAX(ap.id) FROM amazon_prices ap WHERE ap.product_id=m.product_id AND ap.asin=m.asin)
      WHERE m.product_id=? ORDER BY s.fetched_at DESC,m.asin LIMIT 100`).bind(id),
    env.DB.prepare(`SELECT s.id,s.query,s.fetched_at AS fetchedAt,s.returned,
        EXISTS(SELECT 1 FROM amazon_pages p WHERE p.search_id=s.id AND p.next_token IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM amazon_pages child WHERE child.parent_id=p.search_id)) AS hasMore,'succeeded' AS status
        FROM amazon_searches s WHERE s.product_id=? UNION ALL
        SELECT id,query,fetched_at,NULL,0,status FROM amazon_search_failures WHERE product_id=?
        ORDER BY fetchedAt DESC LIMIT 20`).bind(id, id),
  ])
  return {
    matches: matches.results.map(({ snapshot, ...row }) => ({
      ...JSON.parse(String(snapshot)),
      ...row,
    })),
    searches: searches.results.map((row) => ({ ...row, hasMore: Boolean(row.hasMore) })),
    configured: (await connectionStatus(env)).amazon,
    automation: await productAutomation(env.DB, id),
    market: 'Amazon US',
    haul: false,
  }
}
comparisons.use('/products/:id/amazon', requireProduct)
comparisons.use('/products/:id/amazon/*', requireProduct)
async function requireProduct(c: import('hono').Context<AppEnv>, next: import('hono').Next) {
  if (!(await c.env.DB.prepare('SELECT id FROM products WHERE id=?').bind(c.req.param('id')).first()))
    throw new PublicError('NOT_FOUND', '未找到该来源商品。', 404)
  await next()
}
comparisons.get(base, async (c) => c.json(await panel(c.env, c.req.param('id'))))
comparisons.post('/products/:id/amazon/search', async (c) => {
  const { query, after } = await parse(
    c.req.json(),
    z.object({ query: z.string().trim().min(2).max(180), after: z.uuid().optional() }),
  )
  const id = c.req.param('id'),
    searchId = crypto.randomUUID(),
    now = new Date().toISOString(),
    db = c.env.DB
  let cursor: string | undefined
  if (after) {
    const parent = await db
      .prepare(`SELECT p.next_token FROM amazon_pages p JOIN amazon_searches s ON s.id=p.search_id
      WHERE s.product_id=? AND s.query=? AND s.id=?`)
      .bind(id, query, after)
      .first<{ next_token: string | null }>()
    if (!parent?.next_token) throw new PublicError('INVALID_INPUT', '没有可继续的上一页检索。', 400)
    if (await db.prepare('SELECT 1 FROM amazon_pages WHERE parent_id=?').bind(after).first())
      return c.json(await panel(c.env, id))
    cursor = parent.next_token
  }
  let result: Awaited<ReturnType<AmazonUS['search']>>
  try {
    const { credentials } = await providerCredentials(c.env, 'amazon')
    result = await new AmazonUS(credentials, undefined, c.env.DB,{owner:c.var.actor.email}).search(query, 6, cursor)
  } catch (e) {
    if (e instanceof PublicError && e.code !== 'NOT_CONFIGURED')
      await db
        .prepare('INSERT INTO amazon_search_failures VALUES(?,?,?,?,?,?)')
        .bind(searchId, id, query, now, e.code, c.var.actor.email)
        .run()
    throw e
  }
  await db.batch([
    db
      .prepare('INSERT INTO amazon_searches VALUES (?,?,?,?,?,?,?)')
      .bind(searchId, id, query, now, result.items.length, +result.hasMore, c.var.actor.email),
    db.prepare('INSERT INTO amazon_pages VALUES(?,?,?)').bind(searchId, result.nextToken, after ?? null),
    ...result.items.flatMap((item) => [
      db
        .prepare('INSERT INTO amazon_catalog_evidence VALUES (?,?,?)')
        .bind(searchId, item.asin, JSON.stringify(item)),
      db
        .prepare(`INSERT INTO amazon_matches(product_id,asin,latest_search) VALUES (?,?,?)
        ON CONFLICT(product_id,asin) DO UPDATE SET latest_search=excluded.latest_search`)
        .bind(id, item.asin, searchId),
    ]),
  ])
  return c.json(await panel(c.env, id))
})
comparisons.post('/products/:id/amazon/matches/:asin', async (c) => {
  const review = await parse(
    c.req.json(),
    z.object({
      searchId: z.uuid(),
      status: z.enum(['confirmed', 'pending', 'rejected']),
      note: z.string().trim().min(1).max(1000),
    }),
  )
  const { id, asin } = c.req.param(),
    db = c.env.DB,
    now = new Date().toISOString(),
    actor = c.var.actor.email
  const match = await db
    .prepare(
      'SELECT latest_search,status,note,reviewer FROM amazon_matches WHERE product_id=? AND asin=?',
    )
    .bind(id, asin)
    .first<{ latest_search: string; status: string; note: string; reviewer: string | null }>()
  if (!match) throw new PublicError('NOT_FOUND', '请先检索并选择返回的候选 ASIN。', 404)
  const stale = () => new PublicError('STALE_EVIDENCE', '目录证据已更新，请刷新并核对最新规格。', 409)
  if (match.latest_search !== review.searchId) throw stale()
  if (match.status !== review.status || match.note !== review.note || match.reviewer !== actor) {
    try {
      await db.batch([
        db
          .prepare(
            'INSERT INTO amazon_reviews(product_id,asin,search_id,status,note,actor,at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(id, asin, review.searchId, review.status, review.note, actor, now),
        db
          .prepare(
            'UPDATE amazon_matches SET status=?,note=?,reviewed_at=?,reviewer=? WHERE product_id=? AND asin=?',
          )
          .bind(review.status, review.note, now, actor, id, asin),
      ])
    } catch (e) {
      if (String(e).includes('stale_amazon_review')) throw stale()
      throw e
    }
  }
  const prior = await db
    .prepare('SELECT status FROM amazon_prices WHERE product_id=? AND asin=? ORDER BY id DESC LIMIT 1')
    .bind(id, asin)
    .first<{ status: string }>()
  if (review.status === 'confirmed' && (match.status !== 'confirmed' || prior?.status !== 'available')) {
    let offer: { price: number | null; currency: string | null; shipping: number | null } = {
      price: null,
      currency: null,
      shipping: null,
    }
    let state: string
    try {
      const { credentials } = await providerCredentials(c.env, 'amazon')
      offer = await new AmazonUS(credentials, undefined, c.env.DB,{owner:c.var.actor.email}).offer(asin)
      state = offer.price === null ? 'unavailable' : 'available'
    } catch (e) {
      state = e instanceof PublicError ? e.code : 'SOURCE_UNAVAILABLE'
    }
    await db
      .prepare(
        'INSERT INTO amazon_prices(product_id,asin,price,currency,shipping,status,fetched_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(id, asin, offer.price, offer.currency, offer.shipping, state, new Date().toISOString())
      .run()
  }
  return c.json(await panel(c.env, id))
})
