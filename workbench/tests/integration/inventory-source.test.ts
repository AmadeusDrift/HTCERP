import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import {
  parseReport,
  SourceStore,
  sourceDecision,
  sourceReportCoverage,
} from '../../packages/inventory-sync/source'

function sourceFixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('migrations/0042_inventory_source.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => statement.get(...values) ?? null,
      all: () => ({ results: statement.all(...values) }),
      run: () => ({ meta: statement.run(...values) }),
    }
  }
  const DB = {
    prepare,
    batch: (ss: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN')
      try {
        const rows = ss.map((s) => s.run())
        sqlite.exec('COMMIT')
        return rows
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  return { sqlite, DB, store: new SourceStore(DB) }
}

it('rejects truncated or malformed report rows instead of publishing partial inventory', async () => {
  async function rows(text: string) {
    const found = []
    for await (const r of parseReport(new Response(text).body!, 'inventory')) found.push(r)
    return found
  }
  expect(
    await rows(
      '\ufeffsku\tafn-fulfillable-quantity\tstore\r\nA-J1T\t3\tLow-Cost Store\r\nA-J1T\t10\tMAIN\r\n',
    ),
  ).toMatchObject([{ sku: 'A-J1T', sellable: 3 }])
  await expect(
    rows('sku\tafn-fulfillable-quantity\tstore\nA-J1T\t3\tLow-Cost Store\nB-JIT'),
  ).rejects.toThrow()
  await expect(
    rows('sku\tafn-fulfillable-quantity\tstore\nA-J1T\t-1\tLow-Cost Store\n'),
  ).rejects.toThrow()
  await expect(rows('sku\tafn-fulfillable-quantity\nA-J1T\t3\n')).rejects.toThrow(
    'SOURCE_REPORT_HEADER_INVALID',
  )
})

it('uses API sellable as authoritative while preserving simulation mode and J1T priority', () => {
  expect(
    sourceDecision(
      { sku: 'A-J1T-JIT', sellable: 1, status: 'active', ordered: true, createdAt: null },
      0,
    ),
  ).toMatchObject({
    channel: 'J1T',
    candidateQuantity: 4,
    hold: 'SIMULATION_ONLY',
    candidateEligible: true,
    stockAuthority: 'AMAZON_SP_API',
    executionEligible: false,
  })
  expect(
    sourceDecision({ sku: 'B-JIT', sellable: 0, status: 'unknown', ordered: null, createdAt: null }, 0),
  ).toMatchObject({ candidateQuantity: 0, hold: 'LISTING_STATUS_UNKNOWN' })
})

it('uses API zero for qualified SKUs and retains zero-eligibility and Amazon bans', () => {
  const row = { sku: 'B-JIT', sellable: 0, status: 'active', ordered: true, createdAt: null }
  expect(sourceDecision(row, 0)).toMatchObject({
    candidateQuantity: 5,
    candidateEligible: true,
    hold: 'SIMULATION_ONLY',
  })
  expect(sourceDecision({ ...row, ordered: false }, 0)).toMatchObject({
    candidateQuantity: 0,
    candidateEligible: false,
    hold: 'ZERO_ELIGIBILITY_UNKNOWN',
  })
  expect(sourceDecision({ ...row, status: 'banned' }, 0)).toMatchObject({
    candidateQuantity: 0,
    candidateEligible: false,
    hold: 'LISTING_BLOCKED',
  })
})

it('previews ordered and new targets consistently and excludes old unsold positive stock', () => {
  const at = Date.parse('2026-11-16T12:00:00Z')
  for (const sellable of [0, 1, 2, 3, 5]) {
    const row = { sku: 'B-JIT', sellable, status: 'active', ordered: false, createdAt: at - 1000 }
    expect(sourceDecision(row, at, at).candidateQuantity).toBe(Math.max(0, 2 - sellable))
    expect(sourceDecision({ ...row, ordered: true }, at, at).candidateQuantity).toBe(
      Math.max(0, 5 - sellable),
    )
    expect(sourceDecision({ ...row, createdAt: at - 30 * 86400000 }, at, at).candidateQuantity).toBe(0)
  }
})

it('publishes complete replacement only and retains positive qualification evidence', async () => {
  const { store, sqlite } = sourceFixture()
  await store.begin('one', 'seller', 1_000_000, 0, 900_000)
  await store.stage(
    'one',
    'inventory',
    [
      { sku: 'A-J1T', sellable: 2 },
      { sku: 'B-JIT', sellable: 0 },
    ],
    0,
  )
  await store.stage('one', 'listings', [{ sku: 'A-J1T', status: 'active', createdAt: 500_000 }], 0)
  await store.ordered('one', ['A-J1T'], 'order-page-1')
  await expect(store.publish('one')).rejects.toThrow('INCOMPLETE')
  expect(sqlite.prepare('SELECT * FROM inventory_source_current').all()).toEqual([])
  await store.completePart('one', 'inventory', 'fba-1', 2)
  await store.completePart('one', 'listings', 'list-1', 1)
  await store.completePart('one', 'orders', null, 1)
  await store.publish('one')
  await store.begin('two', 'seller', 2_000_000, 0, 1_900_000)
  await store.stage('two', 'inventory', [{ sku: 'A-J1T', sellable: 1 }], 0)
  await store.stage('two', 'listings', [{ sku: 'A-J1T', status: 'active', createdAt: 500_000 }], 0)
  await store.completePart('two', 'inventory', 'fba-2', 1)
  await store.completePart('two', 'listings', 'list-2', 1)
  await store.completePart('two', 'orders', null, 0)
  await store.publish('two')
  expect(sqlite.prepare('SELECT generation FROM inventory_source_current').get()).toMatchObject({
    generation: 'two',
  })
  expect(
    sqlite.prepare("SELECT ordered FROM inventory_source_rows WHERE generation='two'").get(),
  ).toMatchObject({ ordered: 1 })
  expect(
    sqlite.prepare("SELECT count(*) n FROM inventory_source_rows WHERE generation='two'").get(),
  ).toMatchObject({ n: 1 })
  await store.publish('two')
  sqlite.close()
})

it('reconciles unique scoped counts and fails closed on duplicate same-store SKUs', async () => {
  const { store, sqlite } = sourceFixture()
  await store.begin('r', 'seller', 1_000_000, 0, 900_000)
  await store.stage('r', 'inventory', [{ sku: 'A-J1T', sellable: 1 }], 0)
  await store.stage('r', 'inventory', [{ sku: 'A-J1T', sellable: 2 }], 1)
  await expect(store.completePart('r', 'inventory', 'report', 2)).rejects.toThrow(
    'SOURCE_REPORT_COUNT_MISMATCH',
  )
  await expect(store.publish('r')).rejects.toThrow('INCOMPLETE')
  sqlite.close()
})

it('counts excluded unknown-store rows without treating them as Low-Cost inventory', async () => {
  const coverage = sourceReportCoverage(),
    rows = []
  for await (const row of parseReport(
    new Response(
      'sku\tafn-fulfillable-quantity\tstore\nA-J1T\t2\tLow-Cost Store\nA-J1T\t99\t\nB-JIT\t10\tMAIN\nOUTSIDE\t4\tLow-Cost Store\n',
    ).body!,
    'inventory',
    coverage,
  ))
    rows.push(row)
  expect(rows).toEqual([{ sku: 'A-J1T', sellable: 2 }])
  expect(coverage).toEqual({
    rows: 4,
    scopedRows: 1,
    excludedUnknownScope: 1,
    excludedOtherStore: 1,
    excludedSku: 1,
  })
})

it('prunes old and failed row generations in bounded batches after publish, retaining two snapshots and evidence', async () => {
  const { store, sqlite } = sourceFixture()
  for (let n = 1; n <= 3; n++) {
    const id = 'g' + n
    await store.begin(id, 'seller', n * 1000000, 0, n * 900000)
    await store.stage(id, 'inventory', [{ sku: 'A-J1T', sellable: 2 }], 0)
    await store.ordered(id, ['A-J1T'], 'positive-order')
    await store.completePart(id, 'inventory', 'report' + n, 1)
    await store.completePart(id, 'listings', 'listing' + n, 0)
    await store.completePart(id, 'orders', null, 1)
    await store.publish(id)
  }
  await store.begin('failed', 'seller', 2500000, 0, 2400000)
  await store.stage('failed', 'inventory', [{ sku: 'B-JIT', sellable: 2 }], 0)
  await store.fail('failed')
  await store.begin('running', 'seller', 4000000, 0, 3900000)
  await store.stage('running', 'inventory', [{ sku: 'C-JIT', sellable: 2 }], 0)
  expect(await store.prune('running', 1)).toBe(0)
  expect(await store.prune('g3', 1)).toBe(1)
  expect(await store.prune('g3', 1)).toBe(1)
  expect(await store.prune('g3', 1)).toBe(0)
  expect(
    sqlite.prepare('SELECT DISTINCT generation FROM inventory_source_rows ORDER BY generation').all(),
  ).toEqual([{ generation: 'g2' }, { generation: 'g3' }, { generation: 'running' }])
  expect(sqlite.prepare('SELECT count(*) n FROM inventory_source_runs').get()).toMatchObject({ n: 5 })
  expect(
    sqlite
      .prepare("SELECT ordered_generation FROM inventory_source_qualifications WHERE sku='A-J1T'")
      .get(),
  ).toMatchObject({ ordered_generation: 'g1' })
  sqlite.close()
})

it('streams and stages 200000 scoped SKUs in bounded chunks without SKU network requests', async () => {
  const { store, sqlite } = sourceFixture()
  await store.begin('large', 'seller', 1_000_000, 0, 900_000)
  let index = 0,
    chunk = 0,
    rows: { sku: string; sellable?: number | null }[] = []
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === 0)
        controller.enqueue(new TextEncoder().encode('sku\tafn-fulfillable-quantity\tstore\n'))
      if (index === 200000) {
        controller.close()
        return
      }
      const lines = []
      for (let n = 0; n < 500; n++, index++) lines.push(`${index}-J1T\t${index % 6}\tLow-Cost Store\n`)
      controller.enqueue(new TextEncoder().encode(lines.join('')))
    },
  })
  for await (const row of parseReport(stream, 'inventory')) {
    rows.push(row)
    if (rows.length === 500) {
      await store.stage('large', 'inventory', rows, chunk++)
      rows = []
    }
  }
  expect(chunk).toBe(400)
  await store.completePart('large', 'inventory', 'bulk-report', 200000)
  expect(
    sqlite.prepare("SELECT count(*) n FROM inventory_source_rows WHERE generation='large'").get(),
  ).toMatchObject({ n: 200000 })
  expect(sqlite.prepare('SELECT * FROM inventory_source_current').all()).toHaveLength(0)
  sqlite.close()
}, 20000)
