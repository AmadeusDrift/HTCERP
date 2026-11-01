import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PublicError } from '../../contracts/errors'
import { type CatalogEnv, catalog } from '../index'
import { ingestGeekbi } from '../ingest'

// A real SQLite transaction behind the small subset of D1 used by these routes.
function binding(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const stmt = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => stmt.get(...values) ?? null,
      all: () => ({ results: stmt.all(...values) }),
      run: () => ({ meta: stmt.run(...values) }),
      execute: () => ({ results: stmt.all(...values) }),
    }
  }
  return {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN')
      try {
        const rows = statements.map((s) => s.execute())
        sqlite.exec('COMMIT')
        return rows
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}
const app = new Hono<CatalogEnv>()
  .use('*', async (c, next) => {
    c.set('actor', {
      email: 'reviewer@example.test',
      role: c.req.header('x-viewer') ? 'viewer' : 'operator',
    })
    await next()
  })
  .route('/api', catalog)
  .onError((error, c) => {
    if (!(error instanceof PublicError)) throw error
    return c.json({ code: error.code }, error.status as 400)
  })
let sqlite: DatabaseSync
let db: D1Database
const api = (path: string, init?: RequestInit) => app.request('/api' + path, init, { DB: db })
const times = {
  platform: 'temu' as const,
  market: 'US' as const,
  fetchedAt: '2026-11-01T08:00:00Z',
  evidenceRef: 'r2/search/1',
}
const raw = (id: number, sold?: number) => ({
  goodsId: String(id),
  goodsName: 'Fixture ' + id,
  sold,
  minPrice: 4,
  daySold: 0,
  monthSold: 123,
  weekSold: 40,
  updateTime: '2026-10-31T23:30:00+08:00',
  catItems: [{ catId: 9711, parentCatId: 0, catName: '家居' }],
})
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../../migrations/0001_catalog.sql', import.meta.url), 'utf8'))
  db = binding(sqlite)
  await ingestGeekbi(db, {
    ...times,
    rows: [raw(1, 50000), raw(2, 30000), raw(3, 10000), raw(4, 0), raw(5)],
  })
})
afterEach(() => sqlite.close())

it('returns platform product links and business history without supplier attribution or evidence paths', async () => {
  const vendor = 'https://www.geekbi.com/goods/1'
  await ingestGeekbi(db, {
    ...times,
    detail: true,
    fetchedAt: '2026-11-02T08:00:00Z',
    evidenceRef: 'probe-output/geekbi/trace.json',
    rows: [{ ...raw(1, 50000), linkUrl: vendor, thumbnail: vendor + '.png' }],
    history: [{ createTime: '2026-11-02T08:00:00Z', sold: 123 }],
  })
  await ingestGeekbi(db, {
    ...times,
    fetchedAt: '2026-11-02T08:00:00Z',
    evidenceRef: 'probe-output/temu',
    rows: [
      { ...raw(2, 30000), linkUrl: 'https://www.temu.com/goods.html?goods_id=2&utm_source=geekbi' },
    ],
  })
  sqlite
    .prepare(
      'INSERT INTO feedback(product_id, stage, lines_json, note, author, created_at) VALUES(?,?,?,?,?,?)',
    )
    .run('temu:US:1', 'watch', '[]', '人工备注 geekbi 品牌', 'reviewer', times.fetchedAt)
  const detail = (await (await api('/products/temu:US:1')).json()) as {
    product: Record<string, unknown>
    history: Record<string, unknown>[]
    snapshots: Record<string, unknown>[]
  }
  expect(detail.product).toMatchObject({
    source_url: null,
    thumbnail: null,
    note: '人工备注 geekbi 品牌',
  })
  expect(detail.history).toHaveLength(1)
  for (const row of [detail.product, ...detail.history, ...detail.snapshots]) {
    expect(row).not.toHaveProperty('source')
    expect(row).not.toHaveProperty('evidence_ref')
  }
  const page = await (await api('/products?q=Fixture%202')).json()
  expect(page).toMatchObject({ items: [{ source_url: 'https://www.temu.com/goods.html?goods_id=2' }] })
  expect(sqlite.prepare("SELECT source_url,source FROM products WHERE id='temu:US:1'").get()).toEqual({
    source_url: vendor,
    source: 'geekbi',
  })
})

it('filters nonoverlapping tiers and combines category, price, date, completeness and range limits', async () => {
  for (const [tier, sold] of [
    ['50k', 50000],
    ['30k', 30000],
    ['10k', 10000],
    ['below', 0],
    ['missing', null],
  ]) {
    const data = await (
      await api('/products?tier=' + tier + '&category=home&maxPrice=4&updatedFrom=2026-10-31')
    ).json()
    expect(data).toMatchObject({ total: 1, items: [{ total_sold: sold }] })
  }
  const data = await (await api('/products?minSold=10000&maxSold=50000&page=2&pageSize=1')).json()
  expect(data).toMatchObject({ total: 3, page: 2, pageSize: 1, items: [{ total_sold: 30000 }] })
  expect(await (await api('/products?maxDaySold=0&completeness=partial')).json()).toMatchObject({
    total: 1,
  })
  expect(await (await api('/products?updatedFrom=2026-11-01')).json()).toMatchObject({ total: 0 })
  expect(await (await api('/products?q=%25')).json()).toMatchObject({ total: 0 })
  for (const path of [
    '/products?maxPrice=-1',
    '/products?minSold=4&maxSold=3',
    '/products?pageSize=1000',
    '/products?category=invalid',
    '/products?updatedTo=2026-02-30',
    '/products?sort=unknown',
  ]) {
    expect((await api(path)).status).toBe(400)
  }
  expect(await (await api('/catalog/meta')).json()).toMatchObject({
    total: 5,
    historyProducts: 0,
    candidates: 0,
  })
})

it('atomically stores both opportunity lines with review history and enforces write permissions', async () => {
  const path = '/products/temu:US:1/candidate'
  const post = (stage: string, viewer = false) =>
    api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(viewer ? { 'x-viewer': '1' } : {}) },
      body: JSON.stringify({ stage, lines: ['pod', 'standard'], note: '核对尺寸' }),
    })
  expect((await post('watch', true)).status).toBe(403)
  expect((await post('bogus')).status).toBe(400)
  expect((await post('watch')).status).toBe(200)
  expect((await post('watch')).status).toBe(200)
  expect((await post('follow')).status).toBe(200)
  const candidates = await (await api('/candidates?line=pod&stage=follow')).json()
  expect(candidates).toMatchObject({ total: 1, items: [{ lines: ['standard', 'pod'] }] })
  const detail = await (await api('/products/temu:US:1')).json()
  expect(detail).toMatchObject({
    feedback: [
      { stage: 'follow', author: 'reviewer@example.test', note: '核对尺寸' },
      { stage: 'watch' },
    ],
  })
  expect((await api('/products/temu:US:999')).status).toBe(404)
})

it('replays evidence once, retains older evidence, and exposes real dated history separately', async () => {
  const detail = {
    ...times,
    evidenceRef: 'r2/detail/1',
    detail: true,
    rows: [{ ...raw(1, 98), updateTime: '2026-10-01T00:00:00Z' }],
    history: [{ createTime: '2026-10-03T19:00:00+08:00', sold: 42, daySold: 0 }, { sold: 999 }],
  }
  await ingestGeekbi(db, detail)
  await ingestGeekbi(db, detail)
  const d = await (await api('/products/temu:US:1')).json()
  expect(d).toMatchObject({
    product: { total_sold: 50000 },
    snapshots: [{ total_sold: 50000 }, { total_sold: 98 }],
    history: [
      { observed_at: '2026-10-03T11:00:00.000Z', total_sold: 42, day_sold: 0, month_sold: null },
    ],
  })
})
