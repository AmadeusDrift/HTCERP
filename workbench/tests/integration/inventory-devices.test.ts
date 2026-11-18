import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { InventoryDevices } from '../../packages/inventory-sync/devices'
import { receiveFile } from '../../packages/inventory-sync/receive-file'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  for (const migration of [
    '0041_inventory_replenishment.sql',
    '0043_inventory_devices.sql',
    '0044_inventory_live.sql',
    '0045_inventory_device_handoff.sql',
    '0046_inventory_automatic.sql',
    '0047_inventory_order_history.sql',
  ])
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'))
  sqlite.exec(
    "CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER1')",
  )
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const stmt = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => stmt.get(...values) ?? null,
      all: () => ({ results: stmt.all(...values) }),
      run: () => ({ meta: stmt.run(...values) }),
    }
  }
  return { sqlite, service: new InventoryDevices({ prepare } as unknown as D1Database) }
}

it('pairs once, stores only hashes, rejects expired codes and revokes across seller changes', async () => {
  const { sqlite, service } = fixture()
  try {
    const pair = await service.createPair('admin@test', 1000)
    const connected = await service.pair({ code: pair.code, name: 'Edge' }, 1100)
    expect(connected.mode).toBe('SIMULATION')
    expect(connected.scope.warehouseCode).toBe('A1C5')
    expect(sqlite.prepare('SELECT token_hash FROM inventory_devices').get()?.token_hash).not.toBe(
      connected.token,
    )
    await expect(service.pair({ code: pair.code, name: 'Duplicate' }, 1200)).rejects.toThrow()
    expect((await service.authenticate(connected.token, 1300)).id).toBe(connected.deviceId)
    const expired = await service.createPair('admin@test', 1000)
    await expect(service.pair({ code: expired.code, name: 'Late' }, 601001)).rejects.toThrow()
    sqlite.exec("UPDATE title_audit_store SET seller='OTHER'")
    await expect(service.authenticate(connected.token, 1400)).rejects.toThrow()
  } finally {
    sqlite.close()
  }
})

it('retains offline work and accepts idempotent simulated file receipts only for their device', async () => {
  const { sqlite, service } = fixture()
  try {
    const p = await service.createPair('admin@test', 1000)
    const a = await service.pair({ code: p.code, name: 'A' }, 1100)
    const device = await service.authenticate(a.token, 1200)
    const job = await service.createTest(a.deviceId, 1300)
    expect((await service.createTest(a.deviceId, 1400)).id).toBe(job.id)
    expect((await service.work(device)).job?.id).toBe(job.id)
    const file = await receiveFile(job.rows)
    const result = {
      jobId: job.id,
      nonce: job.nonce,
      sha256: file.sha256,
      rowCount: job.rows.length,
      mode: 'SIMULATION',
    }
    await expect(service.result(device, { ...result, sha256: 'a'.repeat(64) }, 1500)).rejects.toThrow()
    const p2 = await service.createPair('admin@test', 1600)
    const b = await service.pair({ code: p2.code, name: 'B' }, 1700)
    await expect(
      service.result(await service.authenticate(b.token, 1800), result, 1900),
    ).rejects.toThrow()
    await expect(service.result(device, { ...result, mode: 'REAL' }, 2000)).rejects.toThrow()
    expect(await service.result(device, result, 2100)).toEqual({ state: 'PASSED', mode: 'SIMULATION' })
    expect(await service.result(device, result, 2200)).toEqual({ state: 'PASSED', mode: 'SIMULATION' })
    expect((await service.work(device)).job).toBeNull()
    await service.revoke(a.deviceId, 2300)
    await expect(service.authenticate(a.token, 2400)).rejects.toThrow()
    await service.createTest(b.deviceId, 2500)
    await service.revoke(b.deviceId, 2600)
    await expect(service.createTest(b.deviceId, 2700)).rejects.toThrow()
    sqlite.exec("UPDATE title_audit_store SET seller='OTHER'")
    await expect(service.createTest(b.deviceId, 2800)).rejects.toThrow()
  } finally {
    sqlite.close()
  }
})
