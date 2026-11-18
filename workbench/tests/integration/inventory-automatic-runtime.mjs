import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// Local Miniflare only. Amazon requests and every stock value are fixtures.
export async function automaticRuntime({ api, db, admin, device, stocks }) {
  const base = 'http://127.0.0.1'
  async function call(path, body = {}) {
    const response = await api.fetch(base + '/api/inventory-device/automatic' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + device.token },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  assert.equal((await admin('/automatic/status')).enabled, false)
  assert.equal((await call('/claim')).job, null)
  const settings = await admin('/automatic/settings', {
    enabled: true,
    intervalMinutes: 60,
    startFrom: 'NEXT_PATROL',
  })
  assert.equal(settings.enabled, true)
  assert.equal((await admin('/automatic/plan', {})).skippedBeforeActivation, true)
  assert.equal((await call('/claim')).job, null)
  assert.equal((await admin('/automatic/status')).jobs.batches, 0)
  await delay(10)
  const previous = await db
    .prepare('SELECT * FROM inventory_source_runs ORDER BY started_at DESC LIMIT 1')
    .first()
  const started = Date.now(),
    generation = 'fixture-next-automatic-patrol'
  await db
    .prepare(`INSERT INTO inventory_source_runs(id,seller,started_at,activated_at,order_from,order_through,state,finished_at,connection_revision,inventory_status,listings_status,orders_status)
    VALUES(?,'SELLER1',?,?,?,?,'COMPLETE',?,?,'COMPLETE','COMPLETE','COMPLETE')`)
    .bind(
      generation,
      started,
      previous.activated_at,
      started - 86400000,
      started,
      started,
      previous.connection_revision,
    )
    .run()
  for (let n = 0; n < 12; n++) {
    const sku = `AUTO-${String(n).padStart(3, '0')}-JIT`
    stocks.set(sku, 3)
    await db
      .prepare(
        "INSERT INTO inventory_source_rows(generation,sku,channel,sellable,listing_status,ordered) VALUES(?,?,'JIT',3,'unknown',1)",
      )
      .bind(generation, sku)
      .run()
  }
  // A new-only SKU follows the same permit/receipt pipeline with target two.
  await db
    .prepare(
      "UPDATE inventory_source_rows SET ordered=NULL,new_listing=1,sellable=0 WHERE generation=? AND sku='AUTO-001-JIT'",
    )
    .bind(generation)
    .run()
  stocks.set('AUTO-001-JIT', 0)
  await db
    .prepare("UPDATE inventory_source_current SET generation=?,published_at=? WHERE seller='SELLER1'")
    .bind(generation, started)
    .run()
  assert.equal((await admin('/automatic/plan', {})).complete, true)
  const claimed = (await call('/claim')).job
  assert.equal(claimed.mode, 'AUTO_REPLENISH')
  assert.equal(claimed.rows.length, 10)
  stocks.set('AUTO-000-JIT', 4)
  const keys = { jobId: claimed.id, leaseId: claimed.leaseId }
  const prepared = (await call('/prepare', keys)).job
  assert.equal(prepared.rows[0].quantity, 1)
  assert.equal(prepared.rows.find((row) => row.sku === 'AUTO-001-JIT').quantity, 2)
  assert.equal(prepared.rows.length, 10)
  assert.equal((await call('/prepare', keys)).job.csv, undefined)
  await call('/dispatched', keys)
  const receipt = {
    ...keys,
    eventId: 'automatic-runtime-unknown',
    filename: prepared.filename,
    sha256: prepared.sha256,
    warehouseCode: 'A1C5',
    status: 'UNKNOWN',
    errorCount: null,
    evidence: { rowText: prepared.filename + ' Processing', observedAt: Date.now() },
  }
  assert.equal((await call('/results', receipt)).receipt.state, 'RECORDED')
  assert.equal((await call('/results', receipt)).replay, true)
  const next = await call('/claim', { previousJobId: keys.jobId, previousLeaseId: keys.leaseId })
  assert.equal(next.previousJob.state, 'RECORDED')
  assert.equal(next.previousJob.eventId, receipt.eventId)
  assert.equal(next.job.rows.length, 2)
  assert.ok(next.job.rows.every((row) => !prepared.rows.some((old) => old.sku === row.sku)))
  await admin('/automatic/settings', { enabled: false, intervalMinutes: 60 })
  const blocked = await api.fetch(base + '/api/inventory-device/automatic/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + device.token },
    body: JSON.stringify({ jobId: next.job.id, leaseId: next.job.leaseId }),
  })
  assert.equal(blocked.status, 409)
  for (const row of prepared.rows) stocks.set(row.sku, row.sku === 'AUTO-001-JIT' ? 2 : 5)
  // claim schedules a paced background reconciliation and its two-minute cooldown.
  // Let the mocked ten-listing read finish, then advance only this local fixture's due time.
  await delay(5000)
  await db.prepare('UPDATE inventory_automatic_jobs SET reconcile_at=0').run()
  await admin('/automatic/reconcile', {})
  const status = await admin('/automatic/status')
  assert.equal(status.reconciliation.unknown, 0)
  assert.equal(status.enabled, false)
  return {
    passed: true,
    realAmazonWrites: 0,
    skippedCurrentGeneration: true,
    firstBatchRows: 10,
    nextBatchRows: 2,
    durableUnknownAllowsUnrelatedBatch: true,
    latestStockQuantity: 1,
    disabledPermitBlocked: true,
    unknownReconciled: true,
    newOnlyTargetTwoReconciled: true,
  }
}
