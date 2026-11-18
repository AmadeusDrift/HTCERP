import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { ReplenishmentQueue } from '../../packages/inventory-sync/queue'
import { receiveFile } from '../../packages/inventory-sync/receive-file'
import { type InventoryObservation, scopeKey } from '../../packages/inventory-sync/rules'

const start = Date.parse('2026-11-16T12:00:00Z')
const sample = (patch: Partial<InventoryObservation> = {}): InventoryObservation => ({
  sellerAccountId: 'seller',
  marketplaceId: 'ATVPDKIKX0DER',
  warehouseCode: 'A1C5',
  binCode: 'Default',
  inventoryType: 'GOOD',
  sku: 'ONE-JIT',
  sellable: 3,
  listingStatus: 'active',
  hasOrdered: true,
  createdAt: start - 30 * 86_400_000,
  observedAt: start,
  ...patch,
})
const scope = scopeKey(sample())
function fixture(path = ':memory:', migrate = true) {
  const sqlite = new DatabaseSync(path)
  sqlite.exec('PRAGMA foreign_keys=ON')
  if (migrate) sqlite.exec(readFileSync('migrations/0041_inventory_replenishment.sql', 'utf8'))
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
    batch: (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN')
      try {
        const result = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  return { sqlite, DB, queue: new ReplenishmentQueue(DB) }
}
async function init() {
  const f = fixture()
  await f.queue.configure('admin', { enabledAt: start, intervalMinutes: 60 })
  return f
}
async function filePacket(job: Awaited<ReturnType<ReplenishmentQueue['job']>>) {
  const rows = job.rows
    .filter((r) => r.outcome === 'PENDING')
    .map((r) => ({
      rowId: r.rowId,
      sku: r.sku,
      binCode: r.binCode,
      quantity: r.quantity,
      disposition: 'GOOD' as const,
    }))
  const file = await receiveFile(rows)
  return { preflightId: job.preflight_id ?? 'unprepared', sha256: file.sha256, rows }
}
async function submit(queue: ReplenishmentQueue, time: number, rows: InventoryObservation[]) {
  await queue.scan('scan-' + time, rows, { complete: true, source: 'mock-seller-flex' }, time)
  const job = (await queue.claim(scope, time))!
  expect(job).not.toBeNull()
  await queue.preflight(
    job.id,
    job.leaseId,
    rows.map((r) => ({ ...r, observedAt: time + 1 })),
    time + 1,
  )
  const ready = await queue.registerSubmission(
    job.id,
    job.leaseId,
    await filePacket(await queue.job(job.id)),
    time + 2,
  )
  await queue.dispatched(job.id, job.leaseId)
  return ready
}

it('recovers persisted work after the database is closed and reopened', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inventory-replenishment-'))
  const path = join(directory, 'queue.sqlite')
  let connection: ReturnType<typeof fixture> | undefined
  try {
    connection = fixture(path)
    await connection.queue.configure('admin', { enabledAt: start, intervalMinutes: 60 })
    await connection.queue.scan('before-restart', [sample()], { complete: true, source: 'mock' }, start)
    connection.sqlite.close()
    connection = undefined
    connection = fixture(path, false)
    const job = (await connection.queue.claim(scope, start + 1000))!
    expect(job.rows.map((r) => [r.sku, r.quantity])).toEqual([['ONE-JIT', 2]])
  } finally {
    connection?.sqlite.close()
    unlinkSync(path)
    rmdirSync(directory)
  }
})

it('persists hourly scans while offline and sends only the latest recomputed gap', async () => {
  const { queue, sqlite, DB } = await init()
  for (let hour = 0; hour < 3; hour++) {
    await queue.scan(
      'hour-' + hour,
      [sample({ sellable: 3 - hour, observedAt: start + hour * 3_600_000 })],
      { complete: true, source: 'mock' },
      start + hour * 3_600_000,
    )
  }
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_demands').get()!.n).toBe(1)
  const resumed = new ReplenishmentQueue(DB)
  const job = (await resumed.claim(scope, start + 3 * 3_600_000))!
  expect(job.rows.map((r) => r.quantity)).toEqual([4])
  await resumed.preflight(
    job.id,
    job.leaseId,
    [sample({ sellable: 4, observedAt: start + 3 * 3_600_000 + 1 })],
    start + 3 * 3_600_000 + 1,
  )
  const ready = await resumed.registerSubmission(
    job.id,
    job.leaseId,
    await filePacket(await resumed.job(job.id)),
    start + 3 * 3_600_000 + 2,
  )
  expect(ready.rows.map((r) => [r.quantity, r.fileRow])).toEqual([[1, 2]])
})

it('allows only administrators to configure the interval and preserves the original new-listing cutoff', async () => {
  const { queue } = await init()
  await expect(queue.configure('operator', { enabledAt: start, intervalMinutes: 30 })).rejects.toThrow()
  await queue.configure('admin', { enabledAt: start + 86_400_000, intervalMinutes: 30 })
  expect(await queue.settings()).toMatchObject({ enabledAt: start, intervalMinutes: 30 })
  expect(await queue.due(start)).toBe(true)
  await queue.scan('first', [], { complete: true, source: 'mock' }, start)
  expect(await queue.due(start + 29 * 60_000)).toBe(false)
  expect(await queue.due(start + 30 * 60_000)).toBe(true)
})

it('rejects incomplete, conflicting and older snapshots without creating false zero-stock demand', async () => {
  const { queue } = await init()
  await queue.scan(
    'new',
    [sample({ sellable: 4, observedAt: start + 100 })],
    { complete: true, source: 'mock' },
    start + 100,
  )
  await queue.scan('old', [sample({ sellable: 1 })], { complete: true, source: 'mock' }, start + 101)
  await queue.scan('missing', [], { complete: false, source: 'mock' }, start + 102)
  await expect(
    queue.scan('new', [sample()], { complete: true, source: 'mock' }, start + 103),
  ).rejects.toThrow()
  await expect(
    queue.scan('duplicate', [sample(), sample()], { complete: true, source: 'mock' }, start + 103),
  ).rejects.toThrow()
  expect((await queue.claim(scope, start + 104))!.rows[0].quantity).toBe(1)
})

it('does not let two devices claim the same scope or use the wrong lease', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const jobs = await Promise.all([queue.claim(scope, start), queue.claim(scope, start)])
  expect(jobs.filter(Boolean)).toHaveLength(1)
  const job = jobs.find(Boolean)!
  await expect(queue.preflight(job.id, 'wrong', [sample()], start)).rejects.toThrow()
  expect(await queue.claim('other-account', start)).toBeNull()
  await expect(
    queue.registerSubmission(job.id, job.leaseId, await filePacket(job), start),
  ).rejects.toThrow()
})

it('requires preflight and blocks a newly banned SKU before a file is registered', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const job = (await queue.claim(scope, start))!
  await queue.preflight(job.id, job.leaseId, [sample({ observedAt: start + 1 })], start + 1)
  await queue.scan(
    'ban',
    [sample({ listingStatus: 'banned', observedAt: start + 2 })],
    { complete: true, source: 'mock' },
    start + 2,
  )
  await expect(
    queue.registerSubmission(job.id, job.leaseId, await filePacket(await queue.job(job.id)), start + 3),
  ).rejects.toThrow()
})

it('reclaims only unsubmitted expired leases and holds uncertain submissions for reconciliation', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const first = (await queue.claim(scope, start))!
  await queue.recover(start + 120_001)
  const second = (await queue.claim(scope, start + 120_001))!
  expect(second.id).not.toBe(first.id)
  await queue.preflight(
    second.id,
    second.leaseId,
    [sample({ observedAt: start + 120_002 })],
    start + 120_002,
  )
  await queue.registerSubmission(
    second.id,
    second.leaseId,
    await filePacket(await queue.job(second.id)),
    start + 120_003,
  )
  await queue.recover(start + 240_002)
  expect(await queue.claim(scope, start + 240_003)).toBeNull()
  expect((await queue.job(second.id)).state).toBe('UNKNOWN')
  await queue.results(
    second.id,
    second.leaseId,
    'late-success',
    [{ rowId: second.rows[0].rowId, outcome: 'SUCCEEDED' }],
    start + 240_004,
  )
  expect((await queue.job(second.id)).state).toBe('SUCCEEDED')
})

it('retries a confirmed failed SKU three times at two-minute intervals, then pauses only that SKU', async () => {
  const { queue, sqlite } = await init()
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = start + attempt * 120_010
    const job = await submit(queue, now, [sample({ observedAt: now })])
    const result = [
      { rowId: job.rows[0].rowId, outcome: 'FAILED' as const, error: 'confirmed rejection' },
    ]
    await queue.results(job.id, job.leaseId, 'failure-' + attempt, result, now + 3)
    await queue.results(job.id, job.leaseId, 'failure-' + attempt, result, now + 4)
    expect(await queue.claim(scope, now + 120_002)).toBeNull()
  }
  const demand = sqlite
    .prepare('SELECT failure_count,paused FROM inventory_replenishment_demands')
    .get()!
  expect(demand).toMatchObject({ failure_count: 4, paused: 1 })
  expect(await queue.claim(scope, start + 1_000_000)).toBeNull()
  await queue.scan(
    'healthy',
    [sample({ sku: 'HEALTHY-JIT', observedAt: start + 1_000_001 })],
    { complete: true, source: 'mock' },
    start + 1_000_001,
  )
  expect((await queue.claim(scope, start + 1_000_001))!.rows.map((r) => r.sku)).toEqual(['HEALTHY-JIT'])
})

it('holds successful rows until verified stock reaches target and never resends an entire partial file', async () => {
  const { queue } = await init()
  const job = await submit(queue, start, [sample(), sample({ sku: 'TWO-JIT' })])
  const results = job.rows.map((r, i) => ({
    rowId: r.rowId,
    outcome: i === 0 ? ('SUCCEEDED' as const) : ('FAILED' as const),
  }))
  await queue.results(job.id, job.leaseId, 'partial', results, start + 3)
  expect((await queue.job(job.id)).state).toBe('PARTIAL')
  await expect(queue.results(job.id, job.leaseId, 'partial', [], start + 4)).rejects.toThrow()
  await queue.scan(
    'stale-after-success',
    [sample({ observedAt: start + 10 })],
    { complete: true, source: 'mock' },
    start + 10,
  )
  const retry = (await queue.claim(scope, start + 120_004))!
  expect(retry.rows.map((r) => r.sku)).toEqual([job.rows[1].sku])
  expect(
    await queue.reconcile(
      job.rows[0].rowId,
      sample({ sku: job.rows[0].sku, sellable: 3, observedAt: start + 120_005 }),
      start + 120_005,
    ),
  ).toBe(false)
  expect(
    await queue.reconcile(
      job.rows[0].rowId,
      sample({ sku: job.rows[0].sku, sellable: 5, observedAt: start + 120_006 }),
      start + 120_006,
    ),
  ).toBe(true)
})

it('reconciles a new-only submission at two even after its first order, then raises its target to five', async () => {
  const { queue } = await init()
  const original = sample({ sellable: 0, hasOrdered: false, createdAt: start - 86_400_000 })
  const job = await submit(queue, start, [original])
  expect(job.rows[0].quantity).toBe(2)
  await queue.results(
    job.id,
    job.leaseId,
    'new-receipt',
    [{ rowId: job.rows[0].rowId, outcome: 'UNKNOWN' }],
    start + 3,
  )
  expect(
    await queue.reconcile(
      job.rows[0].rowId,
      { ...original, sellable: 1, observedAt: start + 4 },
      start + 4,
    ),
  ).toBe(false)
  expect(await queue.claim(scope, start + 4)).toBeNull()
  expect(
    await queue.reconcile(
      job.rows[0].rowId,
      { ...original, sellable: 2, hasOrdered: true, observedAt: start + 5 },
      start + 5,
    ),
  ).toBe(true)
  const next = await queue.claim(scope, start + 6)
  expect(next!.rows[0].quantity).toBe(3)
})

it('resets consecutive failures after a successful retry', async () => {
  const { queue, sqlite } = await init()
  const failed = await submit(queue, start, [sample()])
  await queue.results(
    failed.id,
    failed.leaseId,
    'failed',
    [{ rowId: failed.rows[0].rowId, outcome: 'FAILED' }],
    start + 3,
  )
  const succeeded = await submit(queue, start + 120_010, [sample({ observedAt: start + 120_010 })])
  await queue.results(
    succeeded.id,
    succeeded.leaseId,
    'succeeded',
    [{ rowId: succeeded.rows[0].rowId, outcome: 'SUCCEEDED' }],
    start + 120_013,
  )
  expect(
    sqlite.prepare('SELECT failure_count,retry_at FROM inventory_replenishment_demands').get(),
  ).toMatchObject({ failure_count: 0, retry_at: 0 })
})

it('does not overwrite a conclusive success with a conflicting later event', async () => {
  const { queue } = await init()
  const job = await submit(queue, start, [sample()])
  await queue.results(
    job.id,
    job.leaseId,
    'success',
    [{ rowId: job.rows[0].rowId, outcome: 'SUCCEEDED' }],
    start + 3,
  )
  await expect(
    queue.results(
      job.id,
      job.leaseId,
      'contradiction',
      [{ rowId: job.rows[0].rowId, outcome: 'FAILED' }],
      start + 4,
    ),
  ).rejects.toThrow()
})

it('rejects a conflicting preflight at the same observation timestamp', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const job = (await queue.claim(scope, start))!
  await expect(queue.preflight(job.id, job.leaseId, [sample({ sellable: 4 })], start)).rejects.toThrow()
})

it('renews an active lease without releasing it to another device', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const job = (await queue.claim(scope, start))!
  await queue.heartbeat(job.id, job.leaseId, start + 110_000)
  await queue.recover(start + 121_000)
  expect(await queue.claim(scope, start + 121_000)).toBeNull()
  expect((await queue.job(job.id)).state).toBe('CLAIMED')
})

it('retains ordered and new-listing qualification when a later source omits history fields', async () => {
  for (const evidence of [{ hasOrdered: true }, { hasOrdered: false, createdAt: start - 86_400_000 }]) {
    const { queue } = await init()
    await queue.scan(
      'qualified',
      [sample({ sellable: 0, ...evidence })],
      { complete: true, source: 'mock' },
      start,
    )
    await queue.scan(
      'history-omitted',
      [sample({ sellable: 0, hasOrdered: null, createdAt: null, observedAt: start + 1 })],
      { complete: true, source: 'mock' },
      start + 1,
    )
    const job = await queue.claim(scope, start + 2)
    expect(job?.rows[0].quantity).toBe(evidence.hasOrdered ? 5 : 2)
    const ready = await queue.preflight(
      job!.id,
      job!.leaseId,
      [sample({ sellable: 0, hasOrdered: null, createdAt: null, observedAt: start + 3 })],
      start + 3,
    )
    expect(ready.rows[0].quantity).toBe(evidence.hasOrdered ? 5 : 2)
    expect(ready.rows[0].outcome).toBe('PENDING')
  }
})

it('rejects file content generated before a newer preflight changed the gap', async () => {
  const { queue } = await init()
  await queue.scan('scan', [sample()], { complete: true, source: 'mock' }, start)
  const job = (await queue.claim(scope, start))!
  const a = await queue.preflight(job.id, job.leaseId, [sample({ observedAt: start + 1 })], start + 1)
  const oldFile = await filePacket(a)
  await queue.preflight(job.id, job.leaseId, [sample({ sellable: 4, observedAt: start + 2 })], start + 2)
  await expect(queue.registerSubmission(job.id, job.leaseId, oldFile, start + 3)).rejects.toThrow()
})

it('validates exact file quantities and records the actual CSV order', async () => {
  const { queue } = await init()
  const readings = [sample(), sample({ sku: 'TWO-JIT', sellable: 4 })]
  await queue.scan('scan', readings, { complete: true, source: 'mock' }, start)
  const job = (await queue.claim(scope, start))!
  const prepared = await queue.preflight(
    job.id,
    job.leaseId,
    readings.map((r) => ({ ...r, observedAt: start + 1 })),
    start + 1,
  )
  const packet = await filePacket(prepared)
  const changed = packet.rows.map((r, i) => ({ ...r, quantity: r.quantity + (i === 0 ? 1 : 0) }))
  await expect(
    queue.registerSubmission(
      job.id,
      job.leaseId,
      { ...packet, rows: changed, sha256: (await receiveFile(changed)).sha256 },
      start + 2,
    ),
  ).rejects.toThrow()
  await expect(
    queue.registerSubmission(job.id, job.leaseId, { ...packet, sha256: '0'.repeat(64) }, start + 2),
  ).rejects.toThrow()
  packet.rows.reverse()
  packet.sha256 = (await receiveFile(packet.rows)).sha256
  const registered = await queue.registerSubmission(job.id, job.leaseId, packet, start + 2)
  expect(registered.rows.map((r) => [r.sku, r.fileRow])).toEqual([
    ['ONE-JIT', 3],
    ['TWO-JIT', 2],
  ])
})
