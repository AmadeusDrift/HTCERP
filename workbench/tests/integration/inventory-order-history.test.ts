import type { WorkflowStep } from 'cloudflare:workers'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import {
  InventoryOrderHistory,
  inventoryOrderHistoryWorkflow,
  launchInventoryOrderHistory,
} from '../../packages/inventory-sync/order-history'
import type { OpsBindings } from '../../packages/operations/model'

const now = Date.parse('2026-11-16T12:00:00Z')
function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0042_inventory_source.sql', 'utf8'))
  sql.exec(readFileSync('migrations/0047_inventory_order_history.sql', 'utf8'))
  sql.exec(
    `CREATE TABLE title_audit_store(singleton INTEGER,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER'); UPDATE inventory_source_settings SET activated_at=${now},enabled=1`,
  )
  function prepare(query: string, args: SQLInputValue[] = []) {
    const stmt = sql.prepare(query)
    return {
      bind: (...values: SQLInputValue[]) => prepare(query, values),
      first: () => stmt.get(...args) ?? null,
      all: () => ({ results: stmt.all(...args) }),
      run: () => ({ meta: stmt.run(...args) }),
    }
  }
  const DB = {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) => {
      sql.exec('BEGIN')
      try {
        const values = statements.map((s) => s.run())
        sql.exec('COMMIT')
        return values
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  const archives = new Map<string, string>()
  const create = vi.fn(async () => ({ id: 'fixture' }))
  const env = {
    DB,
    ARCHIVE: {
      put: async (key: string, data: string) => {
        archives.set(key, data)
      },
    },
    RUNNER: {
      create,
      get: async () => {
        throw Error('missing')
      },
    },
  } as unknown as OpsBindings
  const cache = new Map<string, unknown>()
  const step = {
    do: async (name: string, ...args: unknown[]) => {
      if (cache.has(name)) return cache.get(name)
      const result = await (args.at(-1) as () => Promise<unknown>)()
      cache.set(name, result)
      return result
    },
  } as unknown as WorkflowStep
  return { sql, DB, env, create, archives, step, store: new InventoryOrderHistory(DB) }
}

it('does not launch while disabled and walks older windows without resetting source activation', async () => {
  const f = fixture()
  try {
    expect(await launchInventoryOrderHistory(f.env, false, now)).toBeNull()
    const id = await launchInventoryOrderHistory(f.env, true, now)
    expect(id).toMatch(/^inventory-history-/)
    const run = await f.store.run(id!)
    expect(run.window_through).toBe(now - 7 * 86400000)
    expect(run.window_through - run.window_from).toBe(30 * 86400000)
    await f.store.publish(id!, 0, now)
    const next = await launchInventoryOrderHistory(f.env, true, now + 1000)
    expect((await f.store.run(next!)).window_through).toBe(run.window_from)
    expect(f.sql.prepare('SELECT activated_at FROM inventory_source_settings').get()?.activated_at).toBe(
      now,
    )
  } finally {
    f.sql.close()
  }
})

it('publishes only positive scoped SKU evidence after every page and resumes without duplicates', async () => {
  const f = fixture()
  try {
    const id = (await launchInventoryOrderHistory(f.env, true, now))!
    const orders = vi.fn(async (_from: string, _through: string, token?: string) => ({
      orders: [
        {
          id: 'fixture',
          createdTime: '2026-10-20T00:00:00Z',
          items: token
            ? [{ id: 'b', sku: 'OLD-J1T', units: 2 }]
            : [
                { id: 'a', sku: 'OLD-JIT', units: 1 },
                { id: 'z', sku: 'ZERO-JIT', units: 0 },
                { id: 'x', sku: 'OTHER', units: 1 },
              ],
        },
      ],
      nextToken: token ? null : 'next',
    }))
    await inventoryOrderHistoryWorkflow(f.env, id, f.step, { orders })
    expect((await f.store.run(id)).state).toBe('COMPLETE')
    expect(
      f.sql.prepare('SELECT sku FROM inventory_order_history_qualifications ORDER BY sku').all(),
    ).toEqual([{ sku: 'OLD-J1T' }, { sku: 'OLD-JIT' }])
    await inventoryOrderHistoryWorkflow(f.env, id, f.step, { orders })
    expect(orders).toHaveBeenCalledTimes(2)
    expect(f.archives.size).toBe(2)
    expect([...f.archives.values()].join('')).not.toContain('next')
  } finally {
    f.sql.close()
  }
})

it('failed/repeated pagination cannot publish partial qualifications', async () => {
  const f = fixture()
  try {
    const id = (await launchInventoryOrderHistory(f.env, true, now))!
    const orders = async () => ({
      orders: [
        {
          id: 'o',
          createdTime: '2026-10-20T00:00:00Z',
          items: [{ id: 'i', sku: 'PARTIAL-JIT', units: 1 }],
        },
      ],
      nextToken: 'repeat',
    })
    await expect(inventoryOrderHistoryWorkflow(f.env, id, f.step, { orders })).rejects.toThrow()
    expect((await f.store.run(id)).state).toBe('FAILED')
    expect(f.sql.prepare('SELECT count(*) n FROM inventory_order_history_qualifications').get()?.n).toBe(
      0,
    )
  } finally {
    f.sql.close()
  }
})

it('recovers a failed workflow creation without creating a second window', async () => {
  const f = fixture()
  try {
    f.create.mockRejectedValueOnce(new Error('temporary workflow failure'))
    await expect(launchInventoryOrderHistory(f.env, true, now)).rejects.toThrow(
      'temporary workflow failure',
    )
    const first = f.sql.prepare('SELECT id FROM inventory_order_history_runs').get()!.id
    expect(await launchInventoryOrderHistory(f.env, true, now + 1000)).toBe(first)
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.sql.prepare('SELECT count(*) n FROM inventory_order_history_runs').get()!.n).toBe(1)
  } finally {
    f.sql.close()
  }
})

it('replaying publication preserves one positive ledger after a lost response', async () => {
  const f = fixture()
  try {
    const id = (await launchInventoryOrderHistory(f.env, true, now))!
    await f.store.stage(id, ['OLDER-J1T', 'OLDER-J1T'])
    await f.store.publish(id, 1, now + 1)
    await f.store.stage(id, ['SHOULD-NOT-PUBLISH-JIT'])
    await f.store.publish(id, 1, now + 2)
    expect(f.sql.prepare('SELECT sku FROM inventory_order_history_qualifications').all()).toEqual([
      { sku: 'OLDER-J1T' },
    ])
    expect(
      f.sql.prepare('SELECT finished_at FROM inventory_order_history_runs').get()!.finished_at,
    ).toBe(now + 1)
  } finally {
    f.sql.close()
  }
})
