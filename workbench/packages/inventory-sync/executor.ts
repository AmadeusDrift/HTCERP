import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { inventoryDeviceScope } from './connection'
export class InventoryExecutor {
  constructor(private readonly db: D1Database) {}
  async status() {
    const scope = JSON.stringify(await inventoryDeviceScope(this.db))
    // Prefer the current trial owner, then a historical owner, then the earliest legitimate device.
    // Initialize an empty installation once; never replace an existing selection.
    await this.db
      .prepare(`INSERT INTO inventory_executors(scope_json,device_id,version,updated_at)
      SELECT ?,COALESCE(
        (SELECT t.device_id FROM inventory_live_trials t JOIN inventory_devices d ON d.id=t.device_id AND d.scope_json=t.scope_json WHERE t.scope_json=? AND d.revoked_at IS NULL ORDER BY (t.ended_at IS NULL) DESC,t.created_at DESC LIMIT 1),
        (SELECT id FROM inventory_devices WHERE scope_json=? AND revoked_at IS NULL ORDER BY paired_at,id LIMIT 1)),0,?
      ON CONFLICT(scope_json) DO UPDATE SET device_id=excluded.device_id,
        version=inventory_executors.version+1,updated_at=excluded.updated_at
      WHERE inventory_executors.device_id IS NULL AND inventory_executors.version=0 AND excluded.device_id IS NOT NULL`)
      .bind(scope, scope, scope, Date.now())
      .run()
    return (await this.db
      .prepare('SELECT device_id AS deviceId,version FROM inventory_executors WHERE scope_json=?')
      .bind(scope)
      .first<{ deviceId: string | null; version: number }>())!
  }
  async activeTrial() {
    const scope = JSON.stringify(await inventoryDeviceScope(this.db))
    const trial = await this.db
      .prepare('SELECT id,device_id FROM inventory_live_trials WHERE ended_at IS NULL AND scope_json=?')
      .bind(scope)
      .first<{ id: string; device_id: string | null }>()
    return { activeTrialId: trial?.id ?? null, activeTrialOwner: trial?.device_id ?? null }
  }
  async select(actor: string, input: unknown, now: number) {
    const data = z
      .object({
        requestId: z.uuid(),
        deviceId: z.string().regex(/^[a-f0-9]{64}$/),
        expectedExecutorId: z.string().min(1).max(512).nullable(),
        expectedVersion: z.number().int().nonnegative(),
        expectedTrialId: z.uuid().nullable(),
      })
      .strict()
      .parse(input)
    const scopeObject = await inventoryDeviceScope(this.db),
      scope = JSON.stringify(scopeObject)
    await this.status()
    const payload = JSON.stringify(data)
    const gate =
      'EXISTS(SELECT 1 FROM inventory_executor_events WHERE request_id=? AND payload_json=? AND applied=0)'
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO inventory_executor_events(request_id,payload_json,scope_json,actor,old_device_id,new_device_id,trial_id,version,created_at)
        SELECT ?,?,?,?,e.device_id,?,?,e.version+1,? FROM inventory_executors e
        WHERE e.scope_json=? AND e.device_id IS ? AND e.version=? AND e.device_id IS NOT ?
        AND (SELECT id FROM inventory_live_trials WHERE scope_json=? AND ended_at IS NULL) IS ?
        AND EXISTS(SELECT 1 FROM inventory_devices WHERE id=? AND scope_json=? AND revoked_at IS NULL)
        AND EXISTS(SELECT 1 FROM title_audit_store WHERE singleton=1 AND seller=?)
        ON CONFLICT(request_id) DO NOTHING`)
        .bind(
          data.requestId,
          payload,
          scope,
          actor,
          data.deviceId,
          data.expectedTrialId,
          now,
          scope,
          data.expectedExecutorId,
          data.expectedVersion,
          data.deviceId,
          scope,
          data.expectedTrialId,
          data.deviceId,
          scope,
          scopeObject.sellerAccountId,
        ),
      this.db
        .prepare(`INSERT INTO inventory_device_transfers(request_id,job_id,scope_json,old_device_id,old_lease_id,new_device_id,new_lease_id,submitted,created_at)
        SELECT ?,j.id,t.scope_json,t.device_id,j.lease_id,?,lower(hex(randomblob(32))),j.submitted_at IS NOT NULL,?
        FROM inventory_replenishment_jobs j JOIN inventory_live_jobs l ON l.job_id=j.id JOIN inventory_live_trials t ON t.id=l.trial_id
        WHERE t.id=? AND t.ended_at IS NULL AND t.device_id IS NOT NULL AND ${gate}`)
        .bind(data.requestId, data.deviceId, now, data.expectedTrialId, data.requestId, payload),
      this.db
        .prepare(`INSERT INTO inventory_device_transfers(request_id,job_id,scope_json,old_device_id,old_lease_id,new_device_id,new_lease_id,submitted,created_at)
        SELECT ?,j.id,a.scope_json,a.device_id,j.lease_id,?,lower(hex(randomblob(32))),j.submitted_at IS NOT NULL,?
        FROM inventory_replenishment_jobs j JOIN inventory_automatic_jobs a ON a.job_id=j.id
        WHERE a.scope_json=? AND (EXISTS(SELECT 1 FROM inventory_replenishment_rows r WHERE r.job_id=j.id AND r.active=1) OR (a.receipt_event_id IS NULL AND j.state NOT IN('EXPIRED','SKIPPED'))) AND ${gate}`)
        .bind(data.requestId, data.deviceId, now, scope, data.requestId, payload),
      this.db
        .prepare(
          `UPDATE inventory_automatic_jobs SET device_id=? WHERE job_id IN (SELECT job_id FROM inventory_device_transfers WHERE request_id=?) AND ${gate}`,
        )
        .bind(data.deviceId, data.requestId, data.requestId, payload),
      this.db
        .prepare(`UPDATE inventory_replenishment_rows SET preflight_id=NULL,preflight_at=NULL
        WHERE job_id IN (SELECT j.id FROM inventory_replenishment_jobs j JOIN inventory_device_transfers x ON x.job_id=j.id WHERE x.request_id=? AND j.state='CLAIMED' AND j.submitted_at IS NULL) AND ${gate}`)
        .bind(data.requestId, data.requestId, payload),
      this.db
        .prepare(`UPDATE inventory_replenishment_jobs SET
        lease_id=(SELECT new_lease_id FROM inventory_device_transfers x WHERE x.job_id=inventory_replenishment_jobs.id AND x.request_id=?),
        lease_until=?,prepared_at=CASE WHEN submitted_at IS NULL THEN NULL ELSE prepared_at END,
        preflight_id=CASE WHEN submitted_at IS NULL THEN NULL ELSE preflight_id END
        WHERE id IN (SELECT job_id FROM inventory_device_transfers WHERE request_id=?) AND ${gate}`)
        .bind(data.requestId, now + 120000, data.requestId, data.requestId, payload),
      this.db
        .prepare(`UPDATE inventory_live_trials SET device_id=?,claim_token=NULL,updated_at=?,
        state=CASE WHEN state='CLAIMING' THEN CASE WHEN EXISTS(SELECT 1 FROM inventory_live_jobs WHERE trial_id=inventory_live_trials.id) THEN 'ACTIVE' ELSE 'READY' END ELSE state END
        WHERE id=? AND ended_at IS NULL AND ${gate}`)
        .bind(data.deviceId, now, data.expectedTrialId, data.requestId, payload),
      this.db
        .prepare(
          `UPDATE inventory_executors SET device_id=?,version=version+1,updated_at=? WHERE scope_json=? AND ${gate}`,
        )
        .bind(data.deviceId, now, scope, data.requestId, payload),
      this.db
        .prepare(
          'UPDATE inventory_executor_events SET applied=1 WHERE request_id=? AND payload_json=? AND applied=0',
        )
        .bind(data.requestId, payload),
    ])
    const saved = await this.db
      .prepare(
        'SELECT new_device_id,version,trial_id FROM inventory_executor_events WHERE request_id=? AND payload_json=? AND actor=? AND scope_json=? AND applied=1',
      )
      .bind(data.requestId, payload, actor, scope)
      .first<{ new_device_id: string; version: number; trial_id: string | null }>()
    if (!saved) throw new PublicError('CONFLICT', '执行设备或当前任务已变化，请刷新后重新选择。', 409)
    return {
      executor: { deviceId: saved.new_device_id, version: saved.version },
      trialId: saved.trial_id,
    }
  }
}
