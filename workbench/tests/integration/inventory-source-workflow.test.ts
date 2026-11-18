import type { WorkflowStep } from 'cloudflare:workers'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import {
  configureInventorySource,
  inventorySourceCandidates,
  inventorySourceSettings,
  SourceStore,
} from '../../packages/inventory-sync/source'
import {
  inventoryPatrolWorkflow,
  launchInventoryPatrol,
  type SourceDependencies,
} from '../../packages/inventory-sync/source-jobs'
import type { OpsBindings } from '../../packages/operations/model'

const now = Date.parse('2026-11-16T10:00:00Z')
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of [
    '0008_accounts.sql',
    '0027_weekly_feedback.sql',
    '0028_feedback_assignments.sql',
    '0031_group_notifications.sql',
    '0034_weekly_feedback_owner_rules.sql',
    '0037_daily_store_sales.sql',
    '0041_inventory_replenishment.sql',
    '0042_inventory_source.sql',
    '0043_inventory_devices.sql',
    '0044_inventory_live.sql',
    '0045_inventory_device_handoff.sql',
    '0046_inventory_automatic.sql',
    '0047_inventory_order_history.sql',
    '0058_inventory_new_listing_pause.sql',
  ])
    sqlite.exec(readFileSync('migrations/' + file, 'utf8'))
  sqlite.exec(
    "CREATE TABLE title_audit_store(singleton INTEGER,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER');",
  )
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = sqlite.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: () => s.get(...values) ?? null,
      all: () => ({ results: s.all(...values) }),
      run: () => ({ meta: s.run(...values) }),
    }
  }
  const DB = {
    prepare,
    batch: (ss: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN')
      try {
        const r = ss.map((s) => s.run())
        sqlite.exec('COMMIT')
        return r
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  const objects = new Map<string, string>(),
    cache = new Map<string, unknown>()
  const ARCHIVE = {
    put: async (key: string, value: string) => {
      objects.set(key, value)
    },
    get: async (key: string) =>
      objects.has(key)
        ? { body: new Response(objects.get(key)).body, json: async () => JSON.parse(objects.get(key)!) }
        : null,
  } as unknown as R2Bucket
  const create = vi.fn(async () => ({ id: 'x' })),
    RUNNER = {
      create,
      get: async () => {
        throw new Error('missing')
      },
    }
  const env = { DB, ARCHIVE, RUNNER } as unknown as OpsBindings
  const step = {
    do: async (name: string, ...args: unknown[]) => {
      if (cache.has(name)) return cache.get(name)
      const r = await (args.at(-1) as () => Promise<unknown>)()
      cache.set(name, r)
      return r
    },
    sleep: vi.fn(async () => {}),
  } as unknown as WorkflowStep
  const client: SourceDependencies['client'] = {
    create: vi.fn(async (kind) => kind),
    poll: vi.fn(async (id) => ({ status: 'DONE', documentId: id, sourceAt: '2026-11-16T09:59:00Z' })),
    download: vi.fn(async (id, _bucket, key) => {
      objects.set(
        key,
        id === 'inventory'
          ? 'sku\tafn-fulfillable-quantity\tstore\nA-J1T\t3\tLow-Cost Store\nB-JIT\t0\tLow-Cost Store\n'
          : 'seller-sku\tstatus\topen-date\nA-J1T\tActive\t2026-11-15T10:00:00Z\nB-JIT\tInactive\t\n',
      )
    }),
  }
  const orders = vi.fn(async () => ({
    orders: [
      { id: 'o', createdTime: '2026-11-16T09:00:00Z', items: [{ id: 'i', sku: 'B-JIT', units: 1 }] },
    ],
    nextToken: null as string | null,
  }))
  return { sqlite, DB, env, step, client, orders, cache, objects, create, store: new SourceStore(DB) }
}

it('defaults disabled and preserves first activation when interval or enablement changes', async () => {
  const f = fixture()
  expect(await inventorySourceSettings(f.DB)).toEqual({
    enabled: false,
    mode: 'READ_ONLY',
    intervalMinutes: 60,
    activatedAt: null,
  })
  expect(await launchInventoryPatrol(f.env, now)).toBeNull()
  await expect(configureInventorySource(f.DB, 'operator', { enabled: true })).rejects.toThrow()
  await expect(
    configureInventorySource(f.DB, 'admin', { enabled: true, mode: 'LIVE' }),
  ).rejects.toThrow()
  await configureInventorySource(f.DB, 'admin', { enabled: true }, now)
  await configureInventorySource(f.DB, 'admin', { enabled: false, intervalMinutes: 15 }, now + 1000)
  await configureInventorySource(f.DB, 'admin', { enabled: true, intervalMinutes: 30 }, now + 2000)
  expect((await inventorySourceSettings(f.DB)).activatedAt).toBe(now)
  expect(await launchInventoryPatrol(f.env, now + 3000)).toMatch(/^inventory-patrol-/)
  f.sqlite.close()
})

it('ingests both reports and orders; replay reuses checkpoints without re-fetching or changing current generation', async () => {
  const f = fixture()
  await f.store.begin('r', 'SELLER', now, now, now - 180000)
  await inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders })
  const result = await inventorySourceCandidates(f.DB, { limit: 1 })
  expect(result.rows[0]).toMatchObject({
    sku: 'A-J1T',
    sellable: 3,
    createdAt: now - 86400000,
    candidateQuantity: 0,
    executionEligible: false,
    inventoryReport: 'inventory',
    hold: 'TARGET_MET',
    candidateEligible: false,
    stockAuthority: 'AMAZON_SP_API',
  })
  const second = await inventorySourceCandidates(f.DB, { after: result.next!, limit: 1 })
  expect(second.rows[0]).toMatchObject({
    sku: 'B-JIT',
    status: 'unknown',
    ordered: true,
    hold: 'LISTING_STATUS_UNKNOWN',
  })
  await inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders })
  expect(f.client.create).toHaveBeenCalledTimes(2)
  expect(f.orders).toHaveBeenCalledTimes(1)
  expect(f.sqlite.prepare("SELECT state FROM inventory_source_runs WHERE id='r'").get()).toMatchObject({
    state: 'COMPLETE',
  })
  f.sqlite.close()
})

it('previews completed historical orders at target five, ahead of new-only target two', async () => {
  const f = fixture()
  await f.store.begin('r', 'SELLER', now, now, now - 180000)
  await inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders })
  f.sqlite
    .prepare(
      "INSERT INTO inventory_order_history_runs(id,seller,window_from,window_through,state,created_at) VALUES('history','SELLER',?,?,'RUNNING',?)",
    )
    .run(now - 86400000, now, now)
  f.sqlite
    .prepare("INSERT INTO inventory_order_history_qualifications VALUES('SELLER','A-J1T','history',?)")
    .run(now)
  expect((await inventorySourceCandidates(f.DB, { limit: 1 })).rows[0].candidateQuantity).toBe(0)
  f.sqlite.prepare("UPDATE inventory_order_history_runs SET state='COMPLETE'").run()
  expect((await inventorySourceCandidates(f.DB, { limit: 1 })).rows[0]).toMatchObject({
    ordered: true,
    candidateQuantity: 2,
  })
  f.sqlite.close()
})

it.each(['FATAL', 'CANCELLED'])('never publishes %s reports', async (status) => {
  const f = fixture()
  await f.store.begin('r', 'SELLER', now, now, now - 180000)
  f.client.poll = vi.fn(async () => ({ status, documentId: null, sourceAt: null }))
  await expect(
    inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders }),
  ).rejects.toThrow(/SOURCE_/)
  expect(f.sqlite.prepare('SELECT * FROM inventory_source_current').all()).toHaveLength(0)
  expect(
    f.sqlite.prepare("SELECT state,error FROM inventory_source_runs WHERE id='r'").get(),
  ).toMatchObject({ state: 'FAILED', error: 'SOURCE_REPORT_TERMINAL_FAILURE' })
  f.sqlite.close()
})

it('rejects repeated order pagination and never promotes staged positive evidence', async () => {
  const f = fixture()
  await f.store.begin('r', 'SELLER', now, now, now - 180000)
  f.orders.mockImplementation(async () => ({ orders: [], nextToken: 'same-token' }))
  await expect(
    inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders }),
  ).rejects.toThrow(/SOURCE_/)
  expect(f.orders).toHaveBeenCalledTimes(2)
  expect(f.sqlite.prepare('SELECT * FROM inventory_source_current').all()).toHaveLength(0)
  expect(f.sqlite.prepare('SELECT * FROM inventory_source_qualifications').all()).toHaveLength(0)
  f.sqlite.close()
})

it('a malformed second report leaves the last published snapshot visible', async () => {
  const f = fixture()
  await f.store.begin('good', 'SELLER', now, now, now - 180000)
  await inventoryPatrolWorkflow(f.env, 'good', f.step, { client: f.client, orders: f.orders })
  f.cache.clear()
  await f.store.begin('bad', 'SELLER', now + 3600000, now, now + 3400000)
  const download = f.client.download
  f.client.download = vi.fn(async (id, bucket, key) => {
    await download(id, bucket, key)
    if (id === 'listings') f.objects.set(key, 'seller-sku\tstatus\topen-date\nA-J1T\tActive\t\nB-JIT')
  })
  await expect(
    inventoryPatrolWorkflow(f.env, 'bad', f.step, { client: f.client, orders: f.orders }),
  ).rejects.toThrow(/SOURCE_/)
  expect((await inventorySourceCandidates(f.DB)).generation).toBe('good')
  expect(f.sqlite.prepare("SELECT state FROM inventory_source_runs WHERE id='bad'").get()).toMatchObject(
    { state: 'FAILED' },
  )
  f.sqlite.close()
})

it('bounded polling fails closed after the report never finishes', async () => {
  const f = fixture()
  await f.store.begin('r', 'SELLER', now, now, now - 180000)
  f.client.poll = vi.fn(async () => ({ status: 'IN_PROGRESS', documentId: null, sourceAt: null }))
  await expect(
    inventoryPatrolWorkflow(f.env, 'r', f.step, { client: f.client, orders: f.orders }),
  ).rejects.toThrow(/SOURCE_/)
  expect(f.client.poll).toHaveBeenCalledTimes(120)
  expect(f.sqlite.prepare('SELECT * FROM inventory_source_current').all()).toHaveLength(0)
  f.sqlite.close()
})
