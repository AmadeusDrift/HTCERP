import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { InventoryConnection } from '../../packages/inventory-sync/connection'
import { InventoryDevices } from '../../packages/inventory-sync/devices'
import { InventoryExecutor } from '../../packages/inventory-sync/executor'
import { InventoryLive } from '../../packages/inventory-sync/live'
import { ReplenishmentQueue } from '../../packages/inventory-sync/queue'

const now = 1800000000000
const scope = { sellerAccountId: 'SELLER', marketplaceId: 'ATVPDKIKX0DER', warehouseCode: 'A1C5' }
const a = { id: 'a'.repeat(64), scope_json: JSON.stringify(scope) }
const b = { id: 'b'.repeat(64), scope_json: JSON.stringify(scope) }
const sha = async (s: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex')
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  for (const file of [
    '0008_accounts.sql',
    '0041_inventory_replenishment.sql',
    '0042_inventory_source.sql',
    '0043_inventory_devices.sql',
    '0044_inventory_live.sql',
  ])
    sqlite.exec(readFileSync('migrations/' + file, 'utf8'))
  sqlite.exec(`CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER'); CREATE TABLE connection_credentials(provider TEXT,version INTEGER,nonce TEXT,ciphertext TEXT);
    INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('admin','Admin','admin','','');
    INSERT INTO account_sessions VALUES('session','admin',1,${now / 1000 + 1000});`)
  for (const device of [a, b])
    sqlite
      .prepare(
        'INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at) VALUES(?,?,?,?,?)',
      )
      .run(device.id, device.id, device.id, device.scope_json, now)
  // Existing installations must retain their legitimate executor when migrating.
  sqlite.exec(readFileSync('migrations/0045_inventory_device_handoff.sql', 'utf8'))
  sqlite.exec(readFileSync('migrations/0046_inventory_automatic.sql', 'utf8'))
  sqlite.exec(readFileSync('migrations/0047_inventory_order_history.sql', 'utf8'))
  sqlite.exec(readFileSync('migrations/0058_inventory_new_listing_pause.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const stmt = sqlite.prepare(sql)
    return {
      sql,
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => stmt.get(...values) ?? null,
      all: () => ({ results: stmt.all(...values) }),
      run: () => ({ meta: stmt.run(...values) }),
    }
  }
  let beforeBatch: ((sql: string[]) => Promise<void>) | null = null
  let afterBatch: ((sql: string[]) => Promise<void>) | null = null
  const DB = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      const sql = statements.map((s) => s.sql)
      if (beforeBatch) await beforeBatch(sql)
      sqlite.exec('BEGIN')
      let result: ReturnType<ReturnType<typeof prepare>['run']>[]
      try {
        result = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
      if (afterBatch) await afterBatch(sql)
      return result
    },
  } as unknown as D1Database
  const env = { DB, SP_CLIENT_ID: 'client', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' }
  let pause: (() => Promise<void>) | null = null
  const reader = async (_identity: unknown, skus: string[], time: number) => {
    if (pause) await pause()
    return {
      observations: skus.map((sku) => ({
        ...scope,
        sku,
        binCode: 'Default',
        inventoryType: 'GOOD' as const,
        sellable: 2,
        listingStatus: 'active' as const,
        hasOrdered: true,
        createdAt: now - 86400000,
        observedAt: time,
      })),
      updatedAt: {},
    }
  }
  return {
    sqlite,
    DB,
    connection: new InventoryConnection(DB),
    executor: new InventoryExecutor(DB),
    live: new InventoryLive(env, reader),
    pause: (fn: (() => Promise<void>) | null) => {
      pause = fn
    },
    beforeBatch: (fn: typeof beforeBatch) => {
      beforeBatch = fn
    },
    afterBatch: (fn: typeof afterBatch) => {
      afterBatch = fn
    },
  }
}
const actor = { id: 'admin', username: 'Admin', role: 'admin' }
it('initializes the first connected executor after an empty-install status check without stealing later selection', async () => {
  const f = fixture()
  try {
    f.sqlite.exec('DELETE FROM inventory_executors; DELETE FROM inventory_devices')
    expect(await f.executor.status()).toEqual({ deviceId: null, version: 0 })
    const g = await grant(f)
    const device = await f.connection.connect(
      { grantId: g.grant.grantId, verifier: g.verifier },
      now + 1,
    )
    expect(await f.executor.status()).toEqual({ deviceId: device.deviceId, version: 1 })
    await f.live.createTrial('admin', { skus: ['ONE-J1T'] }, now + 2)
    expect(
      (await f.live.claim({ id: device.deviceId, scope_json: JSON.stringify(scope) }, now + 3)).job,
    ).not.toBeNull()
    const next = await grant(f, 'e'.repeat(64))
    await f.connection.connect({ grantId: next.grant.grantId, verifier: next.verifier }, now + 4)
    expect(await f.executor.status()).toEqual({ deviceId: device.deviceId, version: 1 })
  } finally {
    f.sqlite.close()
  }
})
async function grant(f: ReturnType<typeof fixture>, verifier = 'c'.repeat(64)) {
  const input = { requestId: crypto.randomUUID(), challenge: await sha(verifier), name: 'New computer' }
  return { input, verifier, grant: await f.connection.authorize(actor, 'session', input, now) }
}
async function switchTo(
  f: ReturnType<typeof fixture>,
  trialId: string | null,
  requestId = crypto.randomUUID(),
) {
  return f.executor.select(
    'admin',
    {
      requestId,
      deviceId: b.id,
      expectedExecutorId: a.id,
      expectedVersion: 0,
      expectedTrialId: trialId,
    },
    now + 40,
  )
}
async function claimed(f: ReturnType<typeof fixture>) {
  const status = await f.live.createTrial('admin', { skus: ['ONE-J1T'] }, now)
  const job = (await f.live.claim(a, now + 10)).job!
  return { trialId: status.trial!.id, job, keys: { jobId: job.id, leaseId: job.leaseId } }
}

it('redeems a session-bound proof once and returns the same secret after a lost reply', async () => {
  const f = fixture()
  try {
    const g = await grant(f)
    await expect(
      f.connection.connect({ grantId: g.grant.grantId, verifier: 'd'.repeat(64) }, now + 1),
    ).rejects.toThrow()
    const first = await f.connection.connect({ grantId: g.grant.grantId, verifier: g.verifier }, now + 2)
    expect(
      await f.connection.connect({ grantId: g.grant.grantId, verifier: g.verifier }, now + 3),
    ).toEqual(first)
    expect((await f.executor.status()).deviceId).toBe(a.id)
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_devices').get()?.n).toBe(3)
    f.sqlite.prepare('UPDATE inventory_devices SET revoked_at=? WHERE id=?').run(now + 4, first.deviceId)
    await expect(
      f.connection.connect({ grantId: g.grant.grantId, verifier: g.verifier }, now + 5),
    ).rejects.toThrow()
  } finally {
    f.sqlite.close()
  }
})

it('rejects expired, invalidated, non-admin and seller-switched grants without minting devices', async () => {
  const f = fixture()
  try {
    const g = await grant(f)
    const data = { grantId: g.grant.grantId, verifier: g.verifier }
    await expect(f.connection.connect(data, now + 120001)).rejects.toThrow()
    await expect(
      f.connection.authorize({ ...actor, role: 'viewer' }, 'session', g.input, now),
    ).rejects.toThrow()
    f.sqlite.exec("UPDATE accounts SET role='operator'")
    await expect(f.connection.connect(data, now + 1)).rejects.toThrow()
    f.sqlite.exec("UPDATE accounts SET role='admin'; UPDATE title_audit_store SET seller='OTHER'")
    await expect(f.connection.connect(data, now + 1)).rejects.toThrow()
    f.sqlite.exec("UPDATE title_audit_store SET seller='SELLER'; DELETE FROM account_sessions")
    await expect(f.connection.connect(data, now + 1)).rejects.toThrow()
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_devices').get()?.n).toBe(2)
  } finally {
    f.sqlite.close()
  }
})

it('CAS transfers an unsubmitted job, fences old commands and returns exact durable retirement proof', async () => {
  const f = fixture()
  try {
    const { trialId, job, keys } = await claimed(f)
    expect((await f.live.claim(b, now + 15)).job).toBeNull()
    const requestId = crypto.randomUUID()
    const switched = await switchTo(f, trialId, requestId)
    expect(await switchTo(f, trialId, requestId)).toEqual(switched)
    await expect(switchTo(f, trialId)).rejects.toThrow()
    const resumed = (await f.live.claim(b, now + 50)).job!
    expect(resumed.id).toBe(job.id)
    expect(resumed.leaseId).not.toBe(job.leaseId)
    expect(resumed.needsReconciliation).toBe(false)
    await expect(f.live.prepare(a, keys, now + 51)).rejects.toThrow()
    await expect(f.live.heartbeat(a, keys, now + 51)).rejects.toThrow()
    const proof = (
      await f.live.claim(a, now + 52, { previousJobId: job.id, previousLeaseId: job.leaseId })
    ).previousJob
    expect(proof).toMatchObject({
      id: job.id,
      leaseId: job.leaseId,
      state: 'TRANSFERRED',
      newDeviceId: b.id,
      submitted: false,
    })
    expect(
      (await f.live.claim(a, now + 52, { previousJobId: job.id, previousLeaseId: 'wrong' })).previousJob,
    ).toBeNull()
    expect(
      'csv' in (await f.live.prepare(b, { jobId: resumed.id, leaseId: resumed.leaseId }, now + 60)).job,
    ).toBe(true)
  } finally {
    f.sqlite.close()
  }
})

it('hands off possibly issued CSV as watch-only with the identical filename and digest', async () => {
  const f = fixture()
  try {
    const { trialId, keys } = await claimed(f)
    const issued = (await f.live.prepare(a, keys, now + 20)).job
    await switchTo(f, trialId)
    const resumed = (await f.live.claim(b, now + 50)).job!
    expect(resumed).toMatchObject({
      filename: issued.filename,
      sha256: issued.sha256,
      needsReconciliation: true,
    })
    expect(
      'csv' in (await f.live.prepare(b, { jobId: resumed.id, leaseId: resumed.leaseId }, now + 60)).job,
    ).toBe(false)
    await expect(f.live.dispatched(a, keys)).rejects.toThrow()
    await expect(
      new ReplenishmentQueue(f.DB).results(
        keys.jobId,
        keys.leaseId,
        'stale',
        [{ rowId: issued.rows[0].rowId, outcome: 'FAILED' }],
        now + 60,
      ),
    ).rejects.toThrow()
  } finally {
    f.sqlite.close()
  }
})

it('invalidates an API preflight in flight before any CSV can be issued', async () => {
  const f = fixture()
  try {
    const { trialId, keys } = await claimed(f)
    f.pause(async () => {
      f.pause(null)
      await switchTo(f, trialId)
    })
    await expect(f.live.prepare(a, keys, now + 20)).rejects.toThrow()
    const row = f.sqlite
      .prepare('SELECT submitted_at,prepared_at,preflight_id FROM inventory_replenishment_jobs')
      .get()
    expect(row).toMatchObject({ submitted_at: null, prepared_at: null, preflight_id: null })
    expect((await f.executor.status()).deviceId).toBe(b.id)
  } finally {
    f.sqlite.close()
  }
})

it('fences a stale result inside its SQL transaction even after its initial lease check passed', async () => {
  const f = fixture()
  try {
    const { trialId, keys } = await claimed(f)
    const issued = (await f.live.prepare(a, keys, now + 20)).job
    f.beforeBatch(async (sql) => {
      if (!sql.some((s) => s.includes('INSERT INTO inventory_replenishment_events'))) return
      f.beforeBatch(null)
      await switchTo(f, trialId)
    })
    await expect(
      new ReplenishmentQueue(f.DB).results(
        keys.jobId,
        keys.leaseId,
        'late',
        [{ rowId: issued.rows[0].rowId, outcome: 'FAILED' }],
        now + 30,
      ),
    ).rejects.toThrow()
    expect(
      f.sqlite.prepare('SELECT outcome,active FROM inventory_replenishment_rows').get(),
    ).toMatchObject({ outcome: 'PENDING', active: 1 })
    expect(
      f.sqlite.prepare('SELECT failure_count FROM inventory_replenishment_demands').get()?.failure_count,
    ).toBe(0)
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_replenishment_events').get()?.n).toBe(0)
  } finally {
    f.sqlite.close()
  }
})

it('never returns a replacement lease or CSV to a device switched after the submission permit', async () => {
  const f = fixture()
  try {
    const { trialId, keys } = await claimed(f)
    f.afterBatch(async (sql) => {
      if (!sql.some((s) => s.includes('SET file_row='))) return
      f.afterBatch(null)
      await switchTo(f, trialId)
    })
    await expect(f.live.prepare(a, keys, now + 20)).rejects.toThrow()
    const resumed = (await f.live.claim(b, now + 50)).job!
    expect(resumed.needsReconciliation).toBe(true)
    expect(resumed.filename).toBeTruthy()
    expect(
      'csv' in (await f.live.prepare(b, { jobId: resumed.id, leaseId: resumed.leaseId }, now + 60)).job,
    ).toBe(false)
  } finally {
    f.sqlite.close()
  }
})

it('does not return the new owner lease when takeover occurs during receipt API reconciliation', async () => {
  const f = fixture()
  try {
    const { trialId, keys } = await claimed(f)
    const issued = (await f.live.prepare(a, keys, now + 20)).job
    f.pause(async () => {
      f.pause(null)
      await switchTo(f, trialId)
    })
    await expect(
      f.live.results(
        a,
        {
          ...keys,
          eventId: 'receipt-racing-takeover',
          filename: issued.filename,
          sha256: issued.sha256,
          warehouseCode: 'A1C5',
          status: 'COMPLETED',
          errorCount: 0,
          evidence: { rowText: 'Completed 0', observedAt: now + 30 },
        },
        now + 30,
      ),
    ).rejects.toThrow()
    expect((await f.executor.activeTrial()).activeTrialOwner).toBe(b.id)
    expect(f.sqlite.prepare('SELECT applied FROM inventory_live_events').get()?.applied).toBe(1)
  } finally {
    f.sqlite.close()
  }
})

it.each(['SUBMITTED', 'UNKNOWN', 'WAITING_API'])(
  'transfers %s responsibility without creating another job or changing receipt evidence',
  async (state) => {
    const f = fixture()
    try {
      const { trialId, keys } = await claimed(f)
      const issued = (await f.live.prepare(a, keys, now + 20)).job
      await f.live.dispatched(a, keys, now + 21)
      if (state !== 'SUBMITTED')
        await f.live.results(
          a,
          {
            ...keys,
            eventId: 'receipt',
            filename: issued.filename,
            sha256: issued.sha256,
            warehouseCode: 'A1C5',
            status: state === 'UNKNOWN' ? 'UNKNOWN' : 'COMPLETED',
            errorCount: state === 'UNKNOWN' ? null : 0,
            evidence: { rowText: 'Original file receipt', observedAt: now + 25 },
          },
          now + 25,
        )
      const before = f.sqlite
        .prepare('SELECT filename,file_hash,submitted_at FROM inventory_replenishment_jobs')
        .get()
      await switchTo(f, trialId)
      const resumed = await f.live.claim(b, now + 50)
      if (state === 'WAITING_API') expect(resumed).toMatchObject({ job: null, state: 'WAITING_API' })
      else expect(resumed.job?.needsReconciliation).toBe(true)
      expect(
        f.sqlite
          .prepare('SELECT filename,file_hash,submitted_at FROM inventory_replenishment_jobs')
          .get(),
      ).toEqual(before)
      expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
      expect(
        (await f.live.claim(a, now + 60, { previousJobId: keys.jobId, previousLeaseId: keys.leaseId }))
          .previousJob,
      ).toMatchObject({ state: 'TRANSFERRED', submitted: true })
      expect((await f.executor.activeTrial()).activeTrialOwner).toBe(b.id)
    } finally {
      f.sqlite.close()
    }
  },
)

it('allows only one concurrent selection and retains auditable original ownership', async () => {
  const f = fixture()
  try {
    const { trialId } = await claimed(f)
    const results = await Promise.allSettled([switchTo(f, trialId), switchTo(f, trialId)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_executor_events').get()?.n).toBe(1)
    expect(
      f.sqlite.prepare('SELECT old_device_id,new_device_id FROM inventory_device_transfers').get(),
    ).toMatchObject({ old_device_id: a.id, new_device_id: b.id })
  } finally {
    f.sqlite.close()
  }
})

it('rejects a redundant executor selection without rotating the active lease', async () => {
  const f = fixture()
  try {
    const { trialId, job } = await claimed(f)
    await expect(
      f.executor.select(
        'admin',
        {
          requestId: crypto.randomUUID(),
          deviceId: a.id,
          expectedExecutorId: a.id,
          expectedVersion: 0,
          expectedTrialId: trialId,
        },
        now + 30,
      ),
    ).rejects.toThrow()
    expect((await f.live.claim(a, now + 40)).job?.leaseId).toBe(job.leaseId)
    expect(await f.executor.status()).toEqual({ deviceId: a.id, version: 0 })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_device_transfers').get()?.n).toBe(0)
  } finally {
    f.sqlite.close()
  }
})

it('requires takeover before revoking an active owner, then permits revocation without deleting work', async () => {
  const f = fixture()
  try {
    const { trialId } = await claimed(f)
    const devices = new InventoryDevices(f.DB)
    await expect(devices.revoke(a.id, now + 30)).rejects.toThrow('切换')
    await switchTo(f, trialId)
    expect(await devices.revoke(a.id, now + 50)).toEqual({ revoked: true })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})

it('invalidates a CLAIMING token with no job so a delayed claimant cannot create an orphan', async () => {
  const f = fixture()
  try {
    const status = await f.live.createTrial('admin', { skus: ['ONE-J1T'] }, now)
    f.sqlite
      .prepare("UPDATE inventory_live_trials SET state='CLAIMING',device_id=?,claim_token='old-token'")
      .run(a.id)
    await switchTo(f, status.trial!.id)
    expect(f.sqlite.prepare('SELECT claim_token,state FROM inventory_live_trials').get()).toMatchObject({
      claim_token: null,
      state: 'READY',
    })
    const row = f.sqlite
      .prepare('SELECT inventory_key,scope FROM inventory_replenishment_demands')
      .get()!
    expect(
      await new ReplenishmentQueue(f.DB).claim(
        row.scope as string,
        now + 50,
        2,
        [row.inventory_key as string],
        { id: status.trial!.id, token: 'old-token' },
      ),
    ).toBeNull()
    expect((await f.live.claim(b, now + 60)).job).toBeTruthy()
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})
