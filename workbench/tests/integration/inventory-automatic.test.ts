import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import * as automatic from '../../packages/inventory-sync/automatic'
import { inventorySourceCandidates, sourceConnection } from '../../packages/inventory-sync/source'
import { launchInventoryPatrol } from '../../packages/inventory-sync/source-jobs'
import { lowCostStockChanges, recordInventoryDelta } from '../../packages/inventory-sync/inventory-delta'

const now = Date.parse('2026-11-16T12:00:00Z')
const scope = JSON.stringify({
  sellerAccountId: 'SELLER',
  marketplaceId: 'ATVPDKIKX0DER',
  warehouseCode: 'A1C5',
})
const device = { id: 'a'.repeat(64), scope_json: scope }
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
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
    '0060_inventory_bulk_receive.sql',
  ])
    sqlite.exec(readFileSync('migrations/' + file, 'utf8'))
  sqlite.exec(
    "CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER'); CREATE TABLE connection_credentials(provider TEXT,version INTEGER,nonce TEXT,ciphertext TEXT)",
  )
  sqlite
    .prepare('INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at) VALUES(?,?,?,?,?)')
    .run(device.id, 'b'.repeat(64), 'Automatic', scope, now)
  let statements = 0
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => {
        statements++
        return s.get(...values) ?? null
      },
      all: () => {
        statements++
        return { results: s.all(...values) }
      },
      run: () => {
        statements++
        return { meta: s.run(...values) }
      },
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
  const archives: string[] = []
  const stocks = new Map<string, number>()
  const broken = new Set<string>()
  const env = {
    DB,
    SP_CLIENT_ID: 'client',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
    ARCHIVE: {
      put: async (key: string) => {
        archives.push(key)
      },
    } as unknown as R2Bucket,
  }
  const reader = async (_identity: unknown, skus: string[], at: number) => {
    if (skus.some((s) => broken.has(s))) throw Error('read failed')
    return {
      observations: skus.map((sku) => ({
        sellerAccountId: 'SELLER',
        marketplaceId: 'ATVPDKIKX0DER',
        warehouseCode: 'A1C5',
        binCode: 'Default',
        inventoryType: 'GOOD',
        sku,
        sellable: stocks.get(sku) ?? 3,
        listingStatus: 'active' as const,
        hasOrdered: null,
        createdAt: now - 30 * 86400000,
        observedAt: at,
      })),
      updatedAt: {},
    }
  }
  const service = new automatic.InventoryAutomatic(env, reader)
  async function seed(count = 12, generation = 'g1', at = now) {
    const { identity } = await sourceConnection(env)
    sqlite
      .prepare(
        "INSERT INTO inventory_source_runs(id,seller,started_at,activated_at,order_from,order_through,state,connection_revision) VALUES(?,'SELLER',?,?,?,?, 'COMPLETE',?)",
      )
      .run(generation, at, now, now - 86400000, now, identity.revision)
    for (let i = 0; i < count; i++)
      sqlite
        .prepare(
          "INSERT INTO inventory_source_rows(generation,sku,channel,sellable,listing_status,ordered) VALUES(?,?,'JIT',3,'unknown',1)",
        )
        .run(generation, `SKU-${String(i).padStart(3, '0')}-JIT`)
    sqlite
      .prepare(
        "INSERT INTO inventory_source_current VALUES('SELLER',?,?) ON CONFLICT(seller) DO UPDATE SET generation=excluded.generation,published_at=excluded.published_at",
      )
      .run(generation, at)
  }
  return { sqlite, DB, env, service, archives, stocks, broken, seed, statementCount: () => statements }
}
it('exports the separate automatic service', () =>
  expect(automatic.InventoryAutomatic).toBeTypeOf('function'))
it('adds newly sold and newly low-stock SKUs to the active queue without a new full snapshot', async () => {
  const f = fixture()
  await f.seed(2)
  f.sqlite.exec("UPDATE inventory_source_rows SET sellable=5,listing_status='active'")
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60, newListingsEnabled: false }, now - 1)
  await f.service.plan(now)
  expect((await f.service.status()).counts?.candidates).toBe(0)
  expect(await recordInventoryDelta(f.env, 'g1', 'SELLER', 'stock', now + 1, [
    { sku: 'SKU-001-JIT', sellable: 2 }, { sku: 'UNSOLD-JIT', sellable: 0 },
  ])).toBe(1)
  expect(await recordInventoryDelta(f.env, 'g1', 'SELLER', 'orders', now + 1, [
    { sku: 'RECENT-JIT', sellable: null },
  ])).toBe(1)
  expect((await f.service.claim(device, now + 2, { bulk: true })).job?.rows.map(r=>r.sku))
    .toEqual(['RECENT-JIT', 'SKU-001-JIT'])
  expect(await recordInventoryDelta(f.env, 'previous-generation', 'SELLER', 'orders', now + 3, [
    { sku: 'IGNORE-JIT', sellable: null },
  ])).toBe(0)
  f.sqlite.close()
})
it('uses only unique and explicitly scoped Low-Cost Store available stock from Amazon deltas', () => {
  const stock = (sellerSku: string, stores = ['Low-Cost Store'], updatedAt = now) => ({
    sellerSku, stores, condition: 'NewItem', lastUpdatedTime: new Date(updatedAt).toISOString(),
    inventoryDetails: { fulfillableQuantity: 0 },
  })
  expect(lowCostStockChanges([
    stock('VALID-JIT'), stock('MAIN-JIT', ['US']), stock('MIXED-JIT', ['Low-Cost Store', 'US']),
    stock('DUP-JIT'), stock('DUP-JIT'), stock('LATER-JIT', ['Low-Cost Store'], now + 1),
  ], now)).toEqual([{ sku: 'VALID-JIT', sellable: 0 }])
})
it('uploads 2,900 ordered SKUs in a single file, records every row and retains the remainder', async () => {
  const f = fixture()
  await f.seed(2_901)
  f.sqlite.exec("UPDATE inventory_source_rows SET sku=replace(sku,'-JIT','-J1T'),channel='J1T' WHERE sku='SKU-000-JIT'")
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60, newListingsEnabled: false }, now - 1)
  while (!(await f.service.plan(now, 500)).complete) { /* Build all candidates. */ }
  const job = (await f.service.claim(device, now + 1, { bulk: true })).job!
  expect(job.rows).toHaveLength(2_900)
  expect(job.rows.some(({ sku }) => sku.endsWith('J1T'))).toBe(true)
  const command = { jobId: job.id, leaseId: job.leaseId }
  let time = now + 2
  let prepared = await f.service.prepare(device, command, time++)
  expect(prepared).toMatchObject({ pending: true })
  for (let page = 0; 'pending' in prepared && page < 160; page++)
    prepared = await f.service.prepare(device, command, time++)
  const { job: permitted } = prepared
  expect(permitted.state).toBe('SUBMITTING')
  expect(permitted.rows).toHaveLength(2_900)
  expect(permitted).toHaveProperty('csv', expect.stringContaining('SKU-000-J1T'))
  expect((await f.service.prepare(device, command, time++)).job).not.toHaveProperty('csv')
  const result = { ...command, eventId: 'bulk-receipt', filename: permitted.filename,
    sha256: permitted.sha256, warehouseCode: 'A1C5', status: 'COMPLETED', errorCount: 0,
    evidence: { rowText: 'Completed None', observedAt: time } }
  expect((await f.service.results(device, result, time++)).job.state).toBe('SUCCEEDED')
  expect((await f.service.results(device, result, time++)).replay).toBe(true)
  expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_replenishment_rows WHERE outcome='SUCCEEDED' AND file_row IS NOT NULL").get()).toMatchObject({ n: 2_900 })
  expect((await f.service.claim(device, time, { bulk: true })).job?.rows).toHaveLength(1)
  f.sqlite.close()
}, 40_000)
it('plans only ordered stock below five and new-only stock below two, preserving ordered priority', async () => {
  const f = fixture()
  await f.seed(8)
  f.sqlite
    .prepare("UPDATE inventory_source_rows SET ordered=NULL,listing_status='active',created_at=?")
    .run(now - 30 * 86400000)
  const cases = [
    [0, 1, 0, 3], // ordered: +2
    [1, 1, 1, 1], // overlap: +4
    [2, null, 1, 0], // new only: +2
    [3, null, 1, 1], // new only: +1
    [4, null, 1, 2], // new target met
    [5, null, 0, 1], // old unsold
    [6, null, 0, 0], // old unsold zero
    [7, null, 1, null], // unknown stock: fresh API required
  ] as const
  for (const [i, ordered, isNew, stock] of cases) {
    const sku = `SKU-${String(i).padStart(3, '0')}-JIT`
    f.sqlite
      .prepare('UPDATE inventory_source_rows SET ordered=?,new_listing=?,sellable=? WHERE sku=?')
      .run(ordered, isNew, stock, sku)
    f.stocks.set(sku, stock ?? 1)
  }
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  expect((await f.service.status()).counts!.candidates).toBe(5)
  const job = (await f.service.claim(device, now + 1)).job!
  const prepared = (await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 2))
    .job
  expect(prepared.rows.map((r) => [r.sku, r.quantity])).toEqual([
    ['SKU-000-JIT', 2],
    ['SKU-001-JIT', 4],
    ['SKU-002-JIT', 2],
    ['SKU-003-JIT', 1],
    ['SKU-007-JIT', 1],
  ])
  f.sqlite.close()
})
it('uses ERP groups for new-listing targets at planning and fresh stock at preflight', async () => {
  const f = fixture()
  await f.seed(0)
  f.sqlite.exec(`
    INSERT INTO accounts(id,username,role,salt,password_hash) VALUES
      ('ops-a','ops-a','operator','salt','hash'),('ops-c','ops-c','operator','salt','hash');
    INSERT INTO daily_sales_team_members VALUES ('a','ops-a'),('c','ops-c');
    INSERT INTO weekly_feedback_owner_rules VALUES
      ('SELLER','ATVPDKIKX0DER','prefix','RULE-',1,'ops-a','ops-a');
    INSERT INTO weekly_feedback_owners VALUES
      ('SELLER','ATVPDKIKX0DER','RULE-C-JIT','ops-c','manual','ops-a','2026-11-16');
    INSERT INTO daily_sales_sku_teams VALUES ('DIRECT-B-JIT','b'),('AT-TARGET-C-JIT','c');
    INSERT INTO inventory_source_rows
      (generation,sku,channel,sellable,listing_status,ordered,new_listing) VALUES
      ('g1','RULE-A-JIT','JIT',3,'active',NULL,1),
      ('g1','DIRECT-B-JIT','JIT',2,'active',NULL,1),
      ('g1','RULE-C-JIT','JIT',1,'active',NULL,1),
      ('g1','RULE-JIMEI-J1T','J1T',1,'active',NULL,1),
      ('g1','AT-TARGET-C-JIT','JIT',2,'active',NULL,1),
      ('g1','RULE-AT-TARGET-JIT','JIT',5,'active',NULL,1),
      ('g1','RULE-UNSOLD-OLD-JIT','JIT',0,'active',NULL,0);
  `)
  f.stocks.set('RULE-A-JIT', 2)
  f.stocks.set('DIRECT-B-JIT', 4)
  f.stocks.set('RULE-C-JIT', 1)
  f.stocks.set('RULE-JIMEI-J1T', 0)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  expect(await f.service.plan(now, 1)).toMatchObject({ complete: false, rows: 0 })
  await f.service.plan(now)
  expect((await f.service.status()).counts!.candidates).toBe(4)

  const quantities = new Map<string, number>()
  for (let i = 0; i < 2; i++) {
    const at = now + 10 + i * 10
    const claimed = (await f.service.claim(device, at)).job!
    const keys = { jobId: claimed.id, leaseId: claimed.leaseId }
    const { job } = await f.service.prepare(device, keys, at + 1)
    for (const row of job.rows) quantities.set(row.sku, row.quantity)
    await f.service.results(
      device,
      {
        ...keys,
        eventId: `receipt-${i}`,
        filename: job.filename,
        sha256: job.sha256,
        warehouseCode: 'A1C5',
        status: 'UNKNOWN',
        errorCount: null,
        evidence: { rowText: 'unknown receipt', observedAt: at + 2 },
      },
      at + 2,
    )
  }
  expect(quantities).toEqual(
    new Map([
      ['RULE-A-JIT', 3],
      ['DIRECT-B-JIT', 1],
      ['RULE-C-JIT', 1],
      ['RULE-JIMEI-J1T', 2],
    ]),
  )
  const { rows } = await inventorySourceCandidates(f.DB)
  expect(rows.filter((row) => row.candidateEligible).map((row) => [row.sku, row.candidateQuantity])).toEqual([
    ['RULE-JIMEI-J1T', 1],
    ['DIRECT-B-JIT', 3],
    ['RULE-A-JIT', 2],
    ['RULE-C-JIT', 1],
  ])
  f.sqlite.close()
})
it('rechecks operator groups before issuing a CSV when new SKUs change groups after planning', async () => {
  const f = fixture()
  await f.seed(0)
  f.sqlite.exec(`
    INSERT INTO daily_sales_sku_teams VALUES ('LOWER-JIT','a'),('RAISE-JIT','c');
    INSERT INTO inventory_source_rows
      (generation,sku,channel,sellable,listing_status,new_listing) VALUES
      ('g1','LOWER-JIT','JIT',3,'active',1),
      ('g1','RAISE-JIT','JIT',1,'active',1);
  `)
  f.stocks.set('LOWER-JIT', 3)
  f.stocks.set('RAISE-JIT', 1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const claimed = (await f.service.claim(device, now + 1)).job!
  expect(claimed.rows.map(({ sku }) => sku)).toEqual(['LOWER-JIT', 'RAISE-JIT'])

  f.sqlite.exec(`UPDATE daily_sales_sku_teams SET team=CASE sku WHEN 'LOWER-JIT' THEN 'c' ELSE 'b' END`)
  const { job } = await f.service.prepare(device, { jobId: claimed.id, leaseId: claimed.leaseId }, now + 2)
  expect(job.rows.map(({ sku, quantity }) => [sku, quantity])).toEqual([['RAISE-JIT', 4]])
  expect(job.rowStates).toContainEqual({ sku: 'LOWER-JIT', outcome: 'SKIPPED', active: false })
  f.sqlite.close()
})
it('keeps ordered replenishment active while excluding unsold new listings', async () => {
  const f = fixture()
  await f.seed(2)
  f.sqlite.prepare(`UPDATE inventory_source_rows SET ordered=NULL,new_listing=1,sellable=1
    WHERE sku='SKU-000-JIT'`).run()
  f.stocks.set('SKU-000-JIT', 1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60, newListingsEnabled: false }, now - 1)
  await f.service.plan(now)
  expect(await f.service.status()).toMatchObject({ enabled: true, newListingsEnabled: false, counts: { candidates: 1 } })
  const job = (await f.service.claim(device, now + 1)).job!
  expect(job.rows.map(({ sku }) => sku)).toEqual(['SKU-001-JIT'])
  const prepared = await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 2)
  expect(prepared.job.rows).toMatchObject([{ sku: 'SKU-001-JIT', quantity: 2 }])
  f.sqlite.close()
})
it('rechecks a pause on unsold new listings after a mixed batch was claimed', async () => {
  const f = fixture()
  await f.seed(2)
  f.sqlite.prepare(`UPDATE inventory_source_rows SET ordered=NULL,new_listing=1,sellable=1
    WHERE sku='SKU-000-JIT'`).run()
  f.stocks.set('SKU-000-JIT', 1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!
  expect(job.rows).toHaveLength(2)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60, newListingsEnabled: false }, now + 2)
  expect(() => f.sqlite.prepare("UPDATE inventory_replenishment_jobs SET state='SUBMITTING' WHERE id=?").run(job.id))
    .toThrow('AUTOMATIC_NEW_LISTINGS_PAUSED')
  const prepared = await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 3)
  expect(prepared.job.rows.map(({ sku }) => sku)).toEqual(['SKU-001-JIT'])
  expect(prepared.job.rowStates).toContainEqual({ sku: 'SKU-000-JIT', outcome: 'SKIPPED', active: false })
  f.sqlite.close()
})
it('starts disabled, pages a complete generation before claiming, serializes claims and issues one fresh CSV', async () => {
  const f = fixture()
  await f.seed()
  expect((await f.service.status()).enabled).toBe(false)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now, 5)
  expect((await f.service.claim(device, now + 1)).job).toBeNull()
  await f.service.plan(now, 5)
  await f.service.plan(now, 5)
  const claims = await Promise.all([f.service.claim(device, now + 2), f.service.claim(device, now + 2)])
  const job = claims.find((c) => c.job)!.job!
  expect(job.mode).toBe('AUTO_REPLENISH')
  expect(job.rows).toHaveLength(10)
  expect(new Set(claims.filter((c) => c.job).map((c) => c.job!.id)).size).toBe(1)
  f.stocks.set('SKU-000-JIT', 4)
  const keys = { jobId: job.id, leaseId: job.leaseId }
  const prepared = (await f.service.prepare(device, keys, now + 3)).job
  expect('csv' in prepared).toBe(true)
  expect(prepared.rows[0].quantity).toBe(1)
  expect('csv' in (await f.service.prepare(device, keys, now + 4)).job).toBe(false)
  const receipt = {
    ...keys,
    eventId: 'receipt-1',
    filename: prepared.filename,
    sha256: prepared.sha256,
    warehouseCode: 'A1C5',
    status: 'UNKNOWN',
    errorCount: null,
    evidence: { rowText: 'unknown receipt', observedAt: now + 5 },
  }
  expect((await f.service.results(device, receipt, now + 6)).receipt.state).toBe('RECORDED')
  expect(f.archives.length).toBeGreaterThan(0)
  const next = await f.service.claim(device, now + 7, {
    previousJobId: job.id,
    previousLeaseId: job.leaseId,
  })
  expect(next.previousJob).toMatchObject({ state: 'RECORDED', eventId: 'receipt-1' })
  expect(next.job!.rows).toHaveLength(2)
  f.sqlite.close()
})

it('stages over 100,000 candidates in one generation using bounded bulk writes and resumes before replacing it', async () => {
  const f = fixture()
  await f.seed(0)
  f.sqlite.exec(`
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<100005)
    INSERT INTO inventory_source_rows(generation,sku,channel,sellable,listing_status,ordered)
    SELECT 'g1',printf('LOAD-%06d-JIT',i),'JIT',3,'active',1 FROM seq;
  `)
  const later = now + 3600_000
  const started: string[] = []
  const RUNNER = {
    create: async ({ id }: { id: string }) => {
      started.push(id)
      return { id }
    },
  } as unknown as Workflow
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  const before = f.statementCount()
  await f.service.plan(now, 500)
  expect(f.statementCount() - before).toBeLessThan(100)
  expect(await launchInventoryPatrol({ DB: f.DB, RUNNER }, later)).toBeNull()
  expect((await f.service.claim(device, later)).job).toBeNull()

  let result = { complete: false, rows: 0 }
  for (let page = 1; page <= 200 && !result.complete; page++) result = await f.service.plan(later, 500)
  expect(result).toMatchObject({ complete: true, rows: 5 })
  expect((await f.service.status()).counts!.candidates).toBe(100005)
  expect((await f.service.claim(device, later)).job?.rows).toHaveLength(10)
  expect(await launchInventoryPatrol({ DB: f.DB, RUNNER }, later)).toMatch(/^inventory-patrol-/)
  expect(started).toHaveLength(1)
  f.sqlite.close()
}, 60000)
it('isolates failed API reads and disables a pending permit', async () => {
  const f = fixture()
  await f.seed(2)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!
  f.broken.add('SKU-000-JIT')
  const keys = { jobId: job.id, leaseId: job.leaseId }
  const prepared = (await f.service.prepare(device, keys, now + 2)).job
  expect(prepared.rows.map((r) => r.sku)).toEqual(['SKU-001-JIT'])
  const f2 = fixture()
  await f2.seed(1)
  await f2.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f2.service.plan(now)
  const j = (await f2.service.claim(device, now + 1)).job!
  await f2.service.configure('admin', { enabled: false, intervalMinutes: 60 }, now + 2)
  await expect(
    f2.service.prepare(device, { jobId: j.id, leaseId: j.leaseId }, now + 3),
  ).rejects.toThrow()
  f.sqlite.close()
  f2.sqlite.close()
})
it('hands off automatic leases atomically with exact old-device proof; issued jobs remain watch only', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const original = (await f.service.claim(device, now + 1)).job!
  const { InventoryExecutor } = await import('../../packages/inventory-sync/executor')
  const executor = new InventoryExecutor(f.DB),
    selection = await executor.status(),
    other = { id: 'c'.repeat(64), scope_json: scope }
  f.sqlite
    .prepare('INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at) VALUES(?,?,?,?,?)')
    .run(other.id, 'd'.repeat(64), 'Other', scope, now + 1)
  await executor.select(
    'admin',
    {
      requestId: crypto.randomUUID(),
      deviceId: other.id,
      expectedExecutorId: device.id,
      expectedVersion: selection.version,
      expectedTrialId: null,
    },
    now + 2,
  )
  const moved = (await f.service.claim(other, now + 3)).job!
  expect(moved.id).toBe(original.id)
  expect(moved.leaseId).not.toBe(original.leaseId)
  expect(
    (
      await f.service.claim(device, now + 3, {
        previousJobId: original.id,
        previousLeaseId: original.leaseId,
      })
    ).previousJob,
  ).toMatchObject({ state: 'TRANSFERRED', submitted: false, newDeviceId: other.id })
  await expect(
    f.service.prepare(device, { jobId: original.id, leaseId: original.leaseId }, now + 4),
  ).rejects.toThrow()
  const prepared = (await f.service.prepare(other, { jobId: moved.id, leaseId: moved.leaseId }, now + 4))
    .job
  expect('csv' in prepared).toBe(true)
  const latest = await executor.status()
  await executor.select(
    'admin',
    {
      requestId: crypto.randomUUID(),
      deviceId: device.id,
      expectedExecutorId: other.id,
      expectedVersion: latest.version,
      expectedTrialId: null,
    },
    now + 5,
  )
  const watch = (await f.service.claim(device, now + 6)).job!
  expect(
    'csv' in (await f.service.prepare(device, { jobId: watch.id, leaseId: watch.leaseId }, now + 7)).job,
  ).toBe(false)
  f.sqlite.close()
})
it('reconciles unknown target confirmation without reupload; explicit failures wait 120 seconds and pause independently after four', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  for (let i = 0; i < 4; i++) {
    const at = now + i * 120010 + 1,
      job = (await f.service.claim(device, at)).job!,
      keys = { jobId: job.id, leaseId: job.leaseId },
      prepared = (await f.service.prepare(device, keys, at + 1)).job
    await f.service.results(
      device,
      {
        ...keys,
        eventId: 'failure-' + i,
        filename: prepared.filename,
        sha256: prepared.sha256,
        warehouseCode: 'A1C5',
        status: 'FAILED',
        errorCount: 1,
        evidence: { rowText: 'failed', observedAt: at + 2 },
      },
      at + 3,
    )
    expect((await f.service.claim(device, at + 4)).job).toBeNull()
  }
  expect(
    f.sqlite.prepare('SELECT paused,failure_count FROM inventory_replenishment_demands').get(),
  ).toMatchObject({ paused: 1, failure_count: 4 })
  f.sqlite.close()
})
it('source NULL is never zero and latest source replacement cannot accumulate old increments', async () => {
  const f = fixture()
  await f.seed(1)
  f.sqlite.prepare('UPDATE inventory_source_rows SET sellable=NULL,new_listing=1,created_at=?').run(now)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  expect(
    JSON.parse(
      (
        f.sqlite.prepare('SELECT observation_json FROM inventory_replenishment_demands').get() as {
          observation_json: string
        }
      ).observation_json,
    ).sellable,
  ).toBeNull()
  const job = (await f.service.claim(device, now + 1)).job!
  f.stocks.set('SKU-000-JIT', 4)
  expect(
    (await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 2)).job.rows[0]
      .quantity,
  ).toBe(1)
  await f.seed(1, 'g2', now + 100)
  f.sqlite.prepare("UPDATE inventory_source_rows SET sellable=9 WHERE generation='g2'").run()
  await f.service.plan(now + 100)
  expect((await f.service.status()).counts).toMatchObject({ candidates: 0 })
  f.sqlite.close()
})
it('automatic reader shares auth/inventory across rows and isolates missing inventory', async () => {
  const f = fixture()
  const calls: string[] = []
  f.sqlite.exec(
    'CREATE TABLE amazon_request_pacing(operation TEXT PRIMARY KEY,next_at INTEGER,interval_ms INTEGER,slow_until INTEGER DEFAULT 0)',
  )
  const { amazonAutomaticReader } = await import('../../packages/inventory-sync/automatic-reader')
  const request = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'token' })
    if (url.pathname.includes('/fba/'))
      return Response.json({
        payload: {
          inventorySummaries: [
            {
              sellerSku: 'SKU-000-JIT',
              stores: ['Low-Cost Store'],
              condition: 'NewItem',
              inventoryDetails: { fulfillableQuantity: 4 },
            },
          ],
        },
      })
    return Response.json({
      sku: decodeURIComponent(url.pathname.split('/').at(-1)!),
      attributes: { purchasable_offer: [{ marketplace_id: 'ATVPDKIKX0DER', audience: 'BZR' }] },
      summaries: [{ marketplaceId: 'ATVPDKIKX0DER', status: ['BUYABLE', 'DISCOVERABLE'] }],
    })
  }) as typeof fetch
  const { identity } = await sourceConnection(f.env),
    snapshot = await amazonAutomaticReader(f.env, request)(identity, ['SKU-000-JIT', 'MISSING-JIT'], now)
  expect(snapshot.observations.map((r) => r.sellable)).toEqual([4, null])
  expect(snapshot.observations.map((r) => r.listingStatus)).toEqual(['active', 'unknown'])
  expect(calls.filter((p) => p === '/auth/o2/token')).toHaveLength(1)
  expect(calls.filter((p) => p.includes('/fba/'))).toHaveLength(1)
  f.sqlite.close()
})
it('automatically skips ended and unreadable offers while preparing the out-of-stock SKU without manual approval', async () => {
  const f = fixture()
  f.sqlite.exec(
    'CREATE TABLE amazon_request_pacing(operation TEXT PRIMARY KEY,next_at INTEGER,interval_ms INTEGER,slow_until INTEGER DEFAULT 0)',
  )
  const { amazonAutomaticReader } = await import('../../packages/inventory-sync/automatic-reader')
  const request = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'fixture-token' })
    if (url.pathname.includes('/fba/'))
      return Response.json({
        payload: {
          inventorySummaries: url.searchParams
            .get('sellerSkus')!
            .split(',')
            .map((sku) => ({
              sellerSku: sku,
              stores: ['Low-Cost Store'],
              condition: 'NewItem',
              inventoryDetails: { fulfillableQuantity: sku === 'SKU-000-JIT' ? 2 : 0 },
            })),
        },
      })
    expect(url.searchParams.get('includedData')).toBe('summaries,issues,attributes')
    const sku = decodeURIComponent(url.pathname.split('/').at(-1)!)
    return Response.json({
      sku,
      summaries: [{ marketplaceId: 'ATVPDKIKX0DER', status: ['DISCOVERABLE'] }],
      issues: [],
      attributes:
        sku === 'SKU-002-JIT'
          ? undefined
          : {
              purchasable_offer: [
                {
                  marketplace_id: 'ATVPDKIKX0DER',
                  audience: 'BZR',
                  ...(sku === 'SKU-000-JIT' ? { end_at: { value: '2026-10-28T11:23:57.642Z' } } : {}),
                },
              ],
            },
    })
  }) as typeof fetch
  try {
    await f.seed(3)
    const service = new automatic.InventoryAutomatic(f.env, amazonAutomaticReader(f.env, request))
    await service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
    await service.plan(now)
    const claimed = (await service.claim(device, now + 1)).job!
    const prepared = (
      await service.prepare(device, { jobId: claimed.id, leaseId: claimed.leaseId }, now + 2)
    ).job
    expect(prepared.rows.map((r) => ({ sku: r.sku, quantity: r.quantity }))).toEqual([
      { sku: 'SKU-001-JIT', quantity: 5 },
    ])
    expect('csv' in prepared && prepared.csv).toContain('SKU-001-JIT,5,GOOD')
    expect('csv' in prepared && prepared.csv).not.toContain('SKU-000-JIT')
    expect('csv' in prepared && prepared.csv).not.toContain('SKU-002-JIT')
    expect(prepared.rowStates.filter((r) => r.outcome === 'SKIPPED')).toHaveLength(2)
  } finally {
    f.sqlite.close()
  }
})
it('NEXT_PATROL skips current and already-running generations and preserves activation cutoff on interval edits', async () => {
  const f = fixture()
  await f.seed(1, 'old', now)
  await f.service.configure(
    'admin',
    { enabled: true, intervalMinutes: 60, startFrom: 'NEXT_PATROL' },
    now + 10,
  )
  await f.service.plan(now + 11)
  expect((await f.service.claim(device, now + 12)).job).toBeNull()
  await f.seed(1, 'inflight', now + 5)
  await f.service.plan(now + 15)
  expect((await f.service.claim(device, now + 16)).job).toBeNull()
  await f.seed(1, 'next-patrol', now + 20)
  await f.service.plan(now + 21)
  await f.service.configure(
    'admin',
    { enabled: true, intervalMinutes: 90, startFrom: 'NEXT_PATROL' },
    now + 30,
  )
  expect((await f.service.claim(device, now + 31)).job).not.toBeNull()
  f.sqlite.close()
})
it('disable during an API read fences SQL permit while receipt recording remains available after disable', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!,
    keys = { jobId: job.id, leaseId: job.leaseId }
  const reader = async () => {
    await f.service.configure('admin', { enabled: false, intervalMinutes: 60 }, now + 2)
    return {
      observations: [
        {
          sellerAccountId: 'SELLER',
          marketplaceId: 'ATVPDKIKX0DER',
          warehouseCode: 'A1C5',
          binCode: 'Default',
          inventoryType: 'GOOD',
          sku: 'SKU-000-JIT',
          sellable: 3,
          listingStatus: 'active' as const,
          hasOrdered: null,
          createdAt: null,
          observedAt: now + 3,
        },
      ],
      updatedAt: {},
    }
  }
  const racing = new automatic.InventoryAutomatic(f.env, reader)
  await expect(racing.prepare(device, keys, now + 3)).rejects.toThrow(
    'AUTOMATIC_PERMIT_DISABLED_OR_CHANGED',
  )
  expect(
    f.sqlite.prepare('SELECT submitted_at FROM inventory_replenishment_jobs').get()?.submitted_at,
  ).toBeNull()
  f.sqlite.close()
})
it('lost receipt acknowledgement replays exactly, archive failure cannot unlock next work, UNKNOWN confirms only at target', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!,
    keys = { jobId: job.id, leaseId: job.leaseId },
    prepared = (await f.service.prepare(device, keys, now + 2)).job
  const result = {
    ...keys,
    eventId: 'unknown',
    filename: prepared.filename,
    sha256: prepared.sha256,
    warehouseCode: 'A1C5',
    status: 'UNKNOWN',
    errorCount: null,
    evidence: { rowText: 'unknown', observedAt: now + 3 },
  }
  const archive = f.env.ARCHIVE.put
  f.env.ARCHIVE.put = (async () => {
    throw Error('archive unavailable')
  }) as typeof archive
  await expect(f.service.results(device, result, now + 4)).rejects.toThrow('archive unavailable')
  expect(
    f.sqlite.prepare('SELECT receipt_event_id FROM inventory_automatic_jobs').get()?.receipt_event_id,
  ).toBeNull()
  f.env.ARCHIVE.put = archive
  await f.service.configure('admin', { enabled: false, intervalMinutes: 60 }, now + 5)
  expect((await f.service.results(device, result, now + 6)).accepted).toBe(true)
  expect((await f.service.results(device, result, now + 7)).replay).toBe(true)
  expect((await f.service.reconcile(now + 8)).reconciled).toBe(0)
  f.stocks.set('SKU-000-JIT', 5)
  expect((await f.service.reconcile(now + 120009)).reconciled).toBe(1)
  expect(f.sqlite.prepare('SELECT active FROM inventory_replenishment_rows').get()?.active).toBe(0)
  f.sqlite.close()
})
it('reconciles a complete batch with one shared reader call and excludes simultaneous duplicate reads', async () => {
  const f = fixture()
  await f.seed(2)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!,
    keys = { jobId: job.id, leaseId: job.leaseId },
    prepared = (await f.service.prepare(device, keys, now + 2)).job
  await f.service.results(
    device,
    {
      ...keys,
      eventId: 'complete',
      filename: prepared.filename,
      sha256: prepared.sha256,
      warehouseCode: 'A1C5',
      status: 'COMPLETED',
      errorCount: 0,
      evidence: { rowText: 'complete', observedAt: now + 3 },
    },
    now + 4,
  )
  const calls: string[][] = []
  const reader = async (_identity: unknown, skus: string[], at: number) => {
    calls.push(skus)
    return {
      observations: skus.map((sku) => ({
        sellerAccountId: 'SELLER',
        marketplaceId: 'ATVPDKIKX0DER',
        warehouseCode: 'A1C5',
        binCode: 'Default',
        inventoryType: 'GOOD',
        sku,
        sellable: 5,
        listingStatus: 'active' as const,
        hasOrdered: null,
        createdAt: null,
        observedAt: at,
      })),
      updatedAt: {},
    }
  }
  const service = new automatic.InventoryAutomatic(f.env, reader)
  const results = await Promise.all([service.reconcile(now + 5), service.reconcile(now + 5)])
  expect(calls).toHaveLength(1)
  expect(calls[0]).toHaveLength(2)
  expect(results.reduce((sum, r) => sum + r.reconciled, 0)).toBe(2)
  f.sqlite.close()
})
it('only COMPLETE historical order evidence qualifies zero inventory, while banned sources never enter the candidate set', async () => {
  const f = fixture()
  await f.seed(3)
  f.sqlite.prepare('UPDATE inventory_source_rows SET sellable=0,ordered=NULL').run()
  f.sqlite
    .prepare("UPDATE inventory_source_rows SET listing_status='banned' WHERE sku='SKU-002-JIT'")
    .run()
  f.sqlite
    .prepare(
      "INSERT INTO inventory_order_history_runs(id,seller,window_from,window_through,state,created_at) VALUES('history','SELLER',?,?,'RUNNING',?)",
    )
    .run(now - 1000, now - 1, now)
  for (const sku of ['SKU-000-JIT', 'SKU-001-JIT', 'SKU-002-JIT'])
    f.sqlite
      .prepare("INSERT INTO inventory_order_history_qualifications VALUES('SELLER',?,'history',?)")
      .run(sku, now)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  expect((await f.service.status()).counts).toMatchObject({ candidates: 0 })
  f.sqlite.prepare("UPDATE inventory_order_history_runs SET state='COMPLETE'").run()
  await f.seed(3, 'g2', now + 1)
  f.sqlite
    .prepare("UPDATE inventory_source_rows SET sellable=0,ordered=NULL WHERE generation='g2'")
    .run()
  f.sqlite
    .prepare(
      "UPDATE inventory_source_rows SET listing_status='banned' WHERE generation='g2' AND sku='SKU-002-JIT'",
    )
    .run()
  await f.service.plan(now + 1)
  expect((await f.service.status()).counts).toMatchObject({ candidates: 2 })
  f.stocks.set('SKU-000-JIT', 0)
  f.stocks.set('SKU-001-JIT', 0)
  const job = (await f.service.claim(device, now + 2)).job!
  expect(
    (await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 3)).job.rows.map(
      (r) => r.quantity,
    ),
  ).toEqual([5, 5])
  f.sqlite.close()
})
it('does not seed while disabled and excludes already-seeded old candidates after re-enabling NEXT_PATROL', async () => {
  const f = fixture()
  await f.seed(1)
  expect(await f.service.plan(now)).toMatchObject({ complete: true, rows: 0, disabled: true })
  expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_demands').get()?.n).toBe(0)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  await f.service.configure('admin', { enabled: false, intervalMinutes: 60 }, now + 1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now + 2)
  expect((await f.service.status()).counts).toMatchObject({ candidates: 0, pending: 0 })
  expect((await f.service.claim(device, now + 3)).job).toBeNull()
  f.sqlite.close()
})

it('retires unsubmitted obsolete generations despite heartbeats while retaining issued files', async () => {
  const f = fixture()
  await f.seed(2)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const old = (await f.service.claim(device, now + 1)).job!
  await f.seed(2, 'new-patrol', now + 100)
  await f.service.plan(now + 100)
  await f.service.heartbeat(device, { jobId: old.id, leaseId: old.leaseId }, now + 101)
  const next = await f.service.claim(device, now + 102, {
    previousJobId: old.id,
    previousLeaseId: old.leaseId,
  })
  expect(next.previousJob).toMatchObject({ state: 'EXPIRED', submitted: false })
  expect(next.job!.id).not.toBe(old.id)
  const issued = (
    await f.service.prepare(device, { jobId: next.job!.id, leaseId: next.job!.leaseId }, now + 103)
  ).job
  await f.seed(2, 'later-patrol', now + 200)
  await f.service.plan(now + 200)
  await f.service.heartbeat(device, { jobId: issued.id, leaseId: issued.leaseId }, now + 201)
  const retained = (await f.service.claim(device, now + 202)).job!
  expect(retained.id).toBe(issued.id)
  expect(retained.needsReconciliation).toBe(true)
  f.sqlite.close()
})

it('reconciles whole batches without starving the tail behind another unresolved job', async () => {
  const f = fixture()
  await f.seed(20)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const issued = []
  for (let n = 0; n < 2; n++) {
    const at = now + 1 + n * 10,
      job = (await f.service.claim(device, at)).job!
    const keys = { jobId: job.id, leaseId: job.leaseId }
    const prepared = (await f.service.prepare(device, keys, at + 1)).job
    await f.service.results(
      device,
      {
        ...keys,
        eventId: 'unknown-' + n,
        filename: prepared.filename,
        sha256: prepared.sha256,
        warehouseCode: 'A1C5',
        status: 'UNKNOWN',
        errorCount: null,
        evidence: { rowText: 'unknown', observedAt: at + 2 },
      },
      at + 3,
    )
    issued.push(prepared)
  }
  for (const row of issued[0].rows.slice(1)) f.stocks.set(row.sku, 5)
  expect((await f.service.reconcile(now + 30)).reconciled).toBe(9)
  f.sqlite.prepare('UPDATE inventory_automatic_jobs SET reconcile_at=0').run()
  const tail = issued[1].rows.at(-1)!.sku
  f.stocks.set(tail, 5)
  let resolved = 0
  for (let n = 0; n < 3; n++) resolved += (await f.service.reconcile(now + 40 + n * 120001)).reconciled
  expect(resolved).toBe(1)
  expect(
    f.sqlite
      .prepare(
        "SELECT active FROM inventory_replenishment_rows WHERE json_extract(observation_json,'$.sku')=?",
      )
      .get(tail)?.active,
  ).toBe(0)
  f.sqlite.close()
})

it('compacts obsolete source-only staging while retaining current targets, qualification and submitted evidence', async () => {
  const f = fixture()
  await f.seed(3)
  f.sqlite.prepare("UPDATE inventory_source_rows SET ordered=1 WHERE sku='SKU-000-JIT'").run()
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!
  await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, now + 2)
  for (let n = 2; n <= 4; n++) {
    await f.seed(3, 'g' + n, now + n * 100)
    await f.service.plan(now + n * 100)
  }
  for (let n = 0; n < 20; n++) {
    const p = await f.service.prune(2)
    if (!p.removed && !p.scansRemoved) break
  }
  expect(f.sqlite.prepare('SELECT count(*) n FROM inventory_automatic_candidates').get()?.n).toBe(6)
  expect(
    f.sqlite
      .prepare(
        'SELECT count(*) n FROM inventory_replenishment_observations o JOIN inventory_automatic_scans a ON a.scan_id=o.scan_id',
      )
      .get()?.n,
  ).toBe(6)
  expect(
    f.sqlite
      .prepare(
        'SELECT count(*) n FROM inventory_replenishment_eligibility WHERE ordered_scan_id IS NOT NULL',
      )
      .get()?.n,
  ).toBe(3)
  expect(f.sqlite.prepare('SELECT count(*) n FROM inventory_replenishment_demands').get()?.n).toBe(3)
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM inventory_replenishment_rows WHERE active=1').get()?.n,
  ).toBe(3)
  expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  f.sqlite.close()
})

it('reconciles submitted evidence with rotated credentials for the same seller', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  await f.service.plan(now)
  const job = (await f.service.claim(device, now + 1)).job!,
    keys = { jobId: job.id, leaseId: job.leaseId }
  const prepared = (await f.service.prepare(device, keys, now + 2)).job
  await f.service.results(
    device,
    {
      ...keys,
      eventId: 'rotation',
      filename: prepared.filename,
      sha256: prepared.sha256,
      warehouseCode: 'A1C5',
      status: 'UNKNOWN',
      errorCount: null,
      evidence: { rowText: 'unknown', observedAt: now + 3 },
    },
    now + 4,
  )
  f.env.SP_REFRESH_TOKEN = 'rotated-refresh'
  f.stocks.set('SKU-000-JIT', 5)
  expect((await f.service.reconcile(now + 5)).reconciled).toBe(1)
  f.sqlite.close()
})

it('resumes an interrupted candidate page after new historical qualifications arrive', async () => {
  const f = fixture()
  await f.seed(1)
  await f.service.configure('admin', { enabled: true, intervalMinutes: 60 }, now - 1)
  const prepare = f.DB.prepare.bind(f.DB)
  let interrupt = true
  f.DB.prepare = ((sql: string) => {
    if (interrupt && sql.startsWith('UPDATE inventory_automatic_generations SET cursor')) {
      interrupt = false
      throw Error('interrupted cursor')
    }
    return prepare(sql)
  }) as typeof f.DB.prepare
  await expect(f.service.plan(now)).rejects.toThrow('interrupted cursor')
  f.sqlite
    .prepare(
      "INSERT INTO inventory_order_history_runs(id,seller,window_from,window_through,state,created_at) VALUES('hist','SELLER',0,1,'COMPLETE',?)",
    )
    .run(now)
  f.sqlite
    .prepare(
      "INSERT INTO inventory_order_history_qualifications VALUES('SELLER','SKU-000-JIT','hist',?)",
    )
    .run(now)
  expect((await f.service.plan(now + 1)).complete).toBe(true)
  expect((await f.service.claim(device, now + 2)).job?.rows).toHaveLength(1)
  f.sqlite.close()
})
