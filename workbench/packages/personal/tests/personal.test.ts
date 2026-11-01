import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AppEnv } from '../../../apps/api/src/bindings'
import { PublicError } from '../../contracts/errors'
import { personalRoutes } from '../routes'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('migrations/0011_personal_preferences.sql', 'utf8'))
  function prepare(sql: string, args: SQLInputValue[] = []) {
    const statement = sqlite.prepare(sql)
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: () => statement.get(...args) ?? null,
      all: () => ({ results: statement.all(...args) }),
      run: () => ({ meta: statement.run(...args) }),
    }
  }
  db = { prepare } as unknown as D1Database
})
afterEach(() => sqlite.close())

function call(owner: string, path: string, data?: unknown) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('actor', {
      id: owner,
      username: owner,
      email: owner,
      role: 'viewer',
      position: null,
      local: owner === 'local',
    })
    await next()
  })
  app.route('/me', personalRoutes)
  app.onError((error, c) =>
    c.json({}, error instanceof PublicError ? (error.status as ContentfulStatusCode) : 500),
  )
  return app.request(
    'https://example.test/me/' + path,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
    { DB: db },
  )
}

it('keeps defaults and presets private and restores structured filter values', async () => {
  expect(await (await call('a', 'preferences')).json()).toEqual({
    view: 'table',
    pageSize: 50,
    presets: [],
  })
  expect((await call('a', 'preferences', { view: 'grid', pageSize: 20 })).ok).toBe(true)
  const filters = {
    platform: 'temu',
    category: 'home',
    minPrice: '0.50',
    maxPrice: '4',
    tier: '10k',
    sort: 'min_price',
    order: 'asc',
    updatedFrom: '2026-01-01',
  }
  const created = await call('a', 'presets', { name: '  家居  ', filters })
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as { id: string }
  expect(await (await call('a', 'preferences')).json()).toEqual({
    view: 'grid',
    pageSize: 20,
    presets: [{ id, name: '家居', filters }],
  })
  for (const owner of ['b', 'local']) {
    expect(await (await call(owner, 'preferences')).json()).toEqual({
      view: 'table',
      pageSize: 50,
      presets: [],
    })
    expect((await call(owner, 'presets/' + id + '/rename', { name: '别人的预设' })).status).toBe(404)
    expect((await call(owner, 'presets/' + id + '/delete', {})).status).toBe(404)
    expect((await call(owner, 'presets', { name: '家居', filters: {} })).status).toBe(201)
  }
  expect((await call('a', 'presets/' + id + '/rename', { name: '低价家居' })).ok).toBe(true)
  expect((await call('a', 'presets/' + id + '/delete', {})).ok).toBe(true)
  expect(await (await call('a', 'preferences')).json()).toMatchObject({ presets: [] })
})

it('rejects unknown ownership, URLs, pagination, malformed ranges and unsupported values', async () => {
  expect((await call('a', 'preferences', { view: 'grid', pageSize: 20, actorId: 'b' })).status).toBe(400)
  expect((await call('a', 'preferences', { view: 'grid', pageSize: 99 })).status).toBe(400)
  for (const filters of [
    { page: '1' },
    { pageSize: '100' },
    { view: 'table' },
    { return: 'https://invalid/' },
    { platform: 'unknown' },
    { category: '/other' },
    { minPrice: '9', maxPrice: '2' },
    { minSold: '0.2' },
    { updatedFrom: '2026-11-10', updatedTo: '2026-10-31' },
    { order: 'raw' },
    { minPrice: 'Infinity' },
  ]) {
    expect((await call('a', 'presets', { name: '测试', filters })).status).toBe(400)
  }
})

it('limits saved presets without cross-account conflicts or lost documents', async () => {
  for (let i = 0; i < 20; i++)
    expect((await call('a', 'presets', { name: '筛选 ' + i, filters: {} })).status).toBe(201)
  expect((await call('a', 'presets', { name: '额外', filters: {} })).status).toBe(409)
  expect((await call('a', 'presets', { name: '筛选 1', filters: {} })).status).toBe(409)
  expect((await call('b', 'presets', { name: '筛选 1', filters: {} })).status).toBe(201)
})
