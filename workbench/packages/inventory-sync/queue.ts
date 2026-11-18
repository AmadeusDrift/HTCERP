import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { type ReceiveRow, receiveFile } from './receive-file'
import {
  decide,
  type InventoryObservation,
  inventoryKey,
  observationSchema,
  scopeKey,
  skuKey,
} from './rules'

const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const idSchema = z.string().min(1).max(512)
const leaseDuration = 120_000
const retryDelay = 120_000
type Eligibility = {
  sku_key: string
  ordered_scan_id: string | null
  new_listing_scan_id: string | null
}
const knownEligibility = (row?: Eligibility | null) => ({
  hasOrdered: !!row?.ordered_scan_id,
  newListing: !!row?.new_listing_scan_id,
})
type JobRecord = {
  id: string
  scope: string
  channel: string
  lease_id: string
  lease_until: number
  claimed_at: number
  prepared_at: number | null
  preflight_id: string | null
  state: string
  filename: string | null
  file_hash: string | null
  submitted_at: number | null
}
type RowRecord = {
  id: string
  job_id: string
  inventory_key: string
  observation_json: string
  quantity: number
  preflight_at: number | null
  file_row: number | null
  active: number
  outcome: string
  resolved_at: number | null
}
const resultSchema = z
  .object({
    rowId: idSchema,
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'UNKNOWN']),
    error: z.string().max(4000).optional(),
  })
  .strict()
type RowResult = z.infer<typeof resultSchema>
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Internal persistence service. HTTP callers must supply authenticated device scopes; no live routes are mounted yet. */
export class ReplenishmentQueue {
  constructor(private readonly db: D1Database) {}

  async configure(role: string, input: { enabledAt: number; intervalMinutes: number }) {
    if (role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以修改补库规则。', 403)
    const settings = z
      .object({ enabledAt: timeSchema, intervalMinutes: z.number().int().min(1).max(525600) })
      .strict()
      .parse(input)
    await this.db
      .prepare(`INSERT INTO inventory_replenishment_settings VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET interval_minutes=excluded.interval_minutes`)
      .bind(settings.enabledAt, settings.intervalMinutes)
      .run()
  }

  async settings() {
    const row = await this.db
      .prepare(`SELECT enabled_at AS enabledAt,interval_minutes AS intervalMinutes
      FROM inventory_replenishment_settings WHERE singleton=1`)
      .first<{ enabledAt: number; intervalMinutes: number }>()
    if (!row) throw new PublicError('NOT_CONFIGURED', '尚未初始化补库规则。', 409)
    return row
  }

  async decision(input: InventoryObservation) {
    const row = observationSchema.parse(input)
    const settings = await this.settings()
    const evidence = await this.db
      .prepare('SELECT * FROM inventory_replenishment_eligibility WHERE sku_key=?')
      .bind(skuKey(row))
      .first<Eligibility>()
    return decide(row, settings.enabledAt, knownEligibility(evidence))
  }

  async due(now: number) {
    timeSchema.parse(now)
    const settings = await this.settings()
    const row = await this.db
      .prepare(`SELECT MAX(scanned_at) AS latest FROM inventory_replenishment_scans
      WHERE state='COMPLETE' AND kind='patrol'`)
      .first<{ latest: number | null }>()
    return (
      now >= settings.enabledAt &&
      (row?.latest == null || now - row.latest >= settings.intervalMinutes * 60_000)
    )
  }

  async scan(
    id: string,
    input: InventoryObservation[],
    metadata: {
      complete: boolean
      source: string
      kind?: 'patrol' | 'preflight' | 'reconcile'
      automaticGeneration?: string
    },
    now: number,
  ) {
    idSchema.parse(id)
    idSchema.parse(metadata.source)
    timeSchema.parse(now)
    const kind = z.enum(['patrol', 'preflight', 'reconcile']).parse(metadata.kind ?? 'patrol')
    const rows = z.array(observationSchema).parse(input)
    const keys = rows.map(inventoryKey)
    if (new Set(keys).size !== keys.length) throw conflict('快照包含重复库存范围。')
    if (rows.some((r) => r.observedAt > now)) throw conflict('库存读取时间晚于当前时间。')
    const hash = await digest({ rows, complete: metadata.complete, source: metadata.source, kind })
    const scanInsert = this.db
      .prepare(
        `INSERT INTO inventory_replenishment_scans VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        id,
        hash,
        metadata.source,
        kind,
        metadata.complete ? 'INGESTING' : 'INCOMPLETE',
        now,
        rows.length,
      )
    if (metadata.automaticGeneration) {
      idSchema.parse(metadata.automaticGeneration)
      await this.db.batch([
        scanInsert,
        this.db
          .prepare('INSERT INTO inventory_automatic_scans VALUES(?,?) ON CONFLICT DO NOTHING')
          .bind(id, metadata.automaticGeneration),
      ])
    } else await scanInsert.run()
    const saved = await this.db
      .prepare('SELECT digest FROM inventory_replenishment_scans WHERE id=?')
      .bind(id)
      .first<{ digest: string }>()
    if (saved?.digest !== hash) throw conflict('同一巡查编号不能对应不同内容。')
    if (!metadata.complete) return { accepted: false, rows: 0 }
    const settings = await this.settings()
    // Stage observations in bounded batches; an interrupted scan never publishes a partial snapshot.
    for (let offset = 0; offset < rows.length; offset += 25) {
      const chunk = rows.slice(offset, offset + 25)
      const { results: prior } = await this.db
        .prepare(`SELECT * FROM inventory_replenishment_eligibility
        WHERE sku_key IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(chunk.map(skuKey)))
        .all<Eligibility>()
      const ledger = new Map(prior.map((entry) => [entry.sku_key, entry]))
      await this.db.batch(
        chunk.flatMap((row) => {
          const decision = decide(row, settings.enabledAt, knownEligibility(ledger.get(skuKey(row))))
          const qualifiesAsNew =
            row.createdAt !== null &&
            row.createdAt <= row.observedAt &&
            row.createdAt >= settings.enabledAt - 7 * 86_400_000
          return [
            this.db
              .prepare(`INSERT INTO inventory_replenishment_eligibility VALUES(?,?,?)
            ON CONFLICT(sku_key) DO UPDATE SET
            ordered_scan_id=COALESCE(inventory_replenishment_eligibility.ordered_scan_id,excluded.ordered_scan_id),
            new_listing_scan_id=COALESCE(inventory_replenishment_eligibility.new_listing_scan_id,excluded.new_listing_scan_id)`)
              .bind(skuKey(row), row.hasOrdered === true ? id : null, qualifiesAsNew ? id : null),
            this.db
              .prepare(`INSERT INTO inventory_replenishment_observations
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,inventory_key) DO NOTHING`)
              .bind(
                id,
                inventoryKey(row),
                scopeKey(row),
                decision.channel,
                JSON.stringify(row),
                row.observedAt,
                decision.action,
                decision.quantity,
                decision.reason,
              ),
          ]
        }),
      )
    }
    await this.db.batch([
      this.db
        .prepare(`UPDATE inventory_replenishment_scans SET state='COMPLETE' WHERE id=?
        AND row_count=(SELECT COUNT(*) FROM inventory_replenishment_observations WHERE scan_id=?)`)
        .bind(id, id),
      this.db
        .prepare(`INSERT INTO inventory_replenishment_demands
        (inventory_key,scope,channel,scan_id,observation_json,observed_at,action,quantity,reason)
        SELECT o.inventory_key,o.scope,o.channel,o.scan_id,o.observation_json,o.observed_at,o.action,o.quantity,o.reason
        FROM inventory_replenishment_observations o JOIN inventory_replenishment_scans s ON s.id=o.scan_id
        WHERE s.id=? AND s.state='COMPLETE'
        ON CONFLICT(inventory_key) DO UPDATE SET
          scan_id=excluded.scan_id,channel=excluded.channel,observation_json=excluded.observation_json,
          observed_at=excluded.observed_at,action=excluded.action,quantity=excluded.quantity,reason=excluded.reason
        WHERE excluded.observed_at>inventory_replenishment_demands.observed_at`)
        .bind(id),
    ])
    return { accepted: true, rows: rows.length }
  }

  async job(id: string) {
    const job = await this.db
      .prepare('SELECT * FROM inventory_replenishment_jobs WHERE id=?')
      .bind(id)
      .first<JobRecord>()
    if (!job) throw new PublicError('NOT_FOUND', '补库任务不存在。', 404)
    const { results } = await this.db
      .prepare('SELECT * FROM inventory_replenishment_rows WHERE job_id=? ORDER BY inventory_key')
      .bind(id)
      .all<RowRecord>()
    return {
      ...job,
      leaseId: job.lease_id,
      rows: results.map((r) => ({
        ...(JSON.parse(r.observation_json) as InventoryObservation),
        rowId: r.id,
        quantity: r.quantity,
        fileRow: r.file_row,
        outcome: r.outcome,
        active: r.active === 1,
      })),
    }
  }

  async claim(
    scope: string,
    now: number,
    maxRows = 100,
    allowlist?: string[],
    liveTrial?: { id: string; token: string },
    automatic?: {
      deviceId: string
      scopeJson: string
      seller: string
      revision: string
      generation: string
      credentialStamp: string
    },
  ) {
    timeSchema.parse(now)
    z.number().int().min(1).max(3000).parse(maxRows)
    if (allowlist) z.array(z.string().min(1).max(4096)).min(1).max(2).parse(allowlist)
    if (liveTrial) {
      idSchema.parse(liveTrial.id)
      idSchema.parse(liveTrial.token)
      if (!allowlist) throw conflict('真实小批量领取必须提供明确的库存范围。')
    }
    const filter = allowlist
      ? ' AND d.inventory_key IN (SELECT value FROM json_each(?))'
      : automatic
        ? ' AND EXISTS(SELECT 1 FROM inventory_automatic_candidates c WHERE c.generation=? AND c.inventory_key=d.inventory_key)'
        : ''
    const parameters = allowlist ? [JSON.stringify(allowlist)] : automatic ? [automatic.generation] : []
    const demandFilter = automatic ? "action IN ('receive','review')" : "action='receive' AND quantity>0"
    const guard = automatic
      ? `EXISTS(SELECT 1 FROM inventory_automatic_settings WHERE singleton=1 AND enabled=1) AND EXISTS(SELECT 1 FROM inventory_automatic_generations g JOIN inventory_source_current c ON c.generation=g.generation JOIN inventory_source_runs run ON run.id=g.generation JOIN inventory_automatic_settings s ON s.singleton=1 WHERE g.generation=? AND g.state='COMPLETE' AND run.started_at>s.activated_after) AND EXISTS(SELECT 1 FROM inventory_executors e JOIN inventory_devices v ON v.id=e.device_id WHERE e.scope_json=? AND e.device_id=? AND v.revoked_at IS NULL AND v.scope_json=e.scope_json) AND NOT EXISTS(SELECT 1 FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE a.scope_json=? AND a.receipt_event_id IS NULL AND j.state NOT IN('SKIPPED','EXPIRED')) AND NOT EXISTS(SELECT 1 FROM inventory_live_trials WHERE scope_json=? AND ended_at IS NULL)`
      : ''
    const candidate = await this.db
      .prepare(`SELECT channel FROM inventory_replenishment_demands d
      WHERE scope=? AND ${demandFilter} AND paused=0 AND retry_at<=?
        AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows r WHERE r.inventory_key=d.inventory_key AND r.active=1)
      ${filter} ORDER BY ${automatic ? 'retry_at,' : ''}inventory_key LIMIT 1`)
      .bind(scope, now, ...parameters)
      .first<{ channel: string }>()
    if (!candidate) return null
    if (automatic && (maxRows > 10 || allowlist || liveTrial)) throw conflict('Invalid automatic batch')
    const id = crypto.randomUUID(),
      lease = crypto.randomUUID()
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO inventory_replenishment_jobs(id,scope,channel,lease_id,lease_until,claimed_at,state)
        SELECT ?,?,?,?,?,?,'CLAIMED' ${liveTrial ? "WHERE EXISTS(SELECT 1 FROM inventory_live_trials WHERE id=? AND claim_token=? AND state='CLAIMING' AND ended_at IS NULL)" : automatic ? `WHERE ${guard}` : ''}`)
        .bind(
          id,
          scope,
          allowlist ? 'TRIAL' : candidate.channel,
          lease,
          now + leaseDuration,
          now,
          ...(liveTrial
            ? [liveTrial.id, liveTrial.token]
            : automatic
              ? [
                  automatic.generation,
                  automatic.scopeJson,
                  automatic.deviceId,
                  automatic.scopeJson,
                  automatic.scopeJson,
                ]
              : []),
        ),
      this.db
        .prepare(`INSERT INTO inventory_replenishment_rows(id,job_id,inventory_key,observation_json,quantity)
        SELECT lower(hex(randomblob(16))),?,d.inventory_key,d.observation_json,d.quantity
        FROM inventory_replenishment_demands d WHERE scope=? ${allowlist ? '' : 'AND channel=?'} AND ${demandFilter}
        AND paused=0 AND retry_at<=?
        AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=?)
        AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows r WHERE r.inventory_key=d.inventory_key AND r.active=1)
        ${filter} ORDER BY ${automatic ? 'retry_at,' : ''}inventory_key LIMIT ?`)
        .bind(id, scope, ...(allowlist ? [] : [candidate.channel]), now, id, ...parameters, maxRows),
      this.db
        .prepare(`DELETE FROM inventory_replenishment_jobs WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=?)`)
        .bind(id, id),
      ...(automatic
        ? [
            this.db
              .prepare(
                `INSERT INTO inventory_automatic_jobs(job_id,seller,generation,connection_revision,credential_stamp,scope_json,device_id,created_at) SELECT id,?,?,?,?,?,?,? FROM inventory_replenishment_jobs WHERE id=?`,
              )
              .bind(
                automatic.seller,
                automatic.generation,
                automatic.revision,
                automatic.credentialStamp,
                automatic.scopeJson,
                automatic.deviceId,
                now,
                id,
              ),
          ]
        : []),
      ...(liveTrial
        ? [
            this.db
              .prepare(
                'INSERT INTO inventory_live_jobs(job_id,trial_id,created_at) SELECT id,?,? FROM inventory_replenishment_jobs WHERE id=?',
              )
              .bind(liveTrial.id, now, id),
          ]
        : []),
    ])
    const exists = await this.db
      .prepare('SELECT 1 AS present FROM inventory_replenishment_jobs WHERE id=?')
      .bind(id)
      .first()
    return exists ? this.job(id) : null
  }

  private async claimed(id: string, lease: string, now: number) {
    timeSchema.parse(now)
    const job = await this.job(id)
    if (job.leaseId !== lease || job.state !== 'CLAIMED' || job.lease_until <= now)
      throw conflict('领取凭据已失效或任务已进入提交阶段。')
    return job
  }

  async heartbeat(id: string, lease: string, now: number) {
    timeSchema.parse(now)
    const result = await this.db
      .prepare(`UPDATE inventory_replenishment_jobs SET lease_until=?
      WHERE id=? AND lease_id=? AND lease_until>? AND state IN ('CLAIMED','SUBMITTING','SUBMITTED') RETURNING id`)
      .bind(now + leaseDuration, id, lease, now)
      .first()
    if (!result) throw conflict('任务租约无法续期。')
  }

  async preflight(id: string, lease: string, input: InventoryObservation[], now: number) {
    const job = await this.claimed(id, lease, now)
    const rows = z.array(observationSchema).parse(input)
    const expected = new Set(job.rows.filter((r) => r.outcome === 'PENDING').map(inventoryKey))
    if (
      rows.length !== expected.size ||
      new Set(rows.map(inventoryKey)).size !== rows.length ||
      rows.some(
        (r) => !expected.has(inventoryKey(r)) || r.observedAt < job.claimed_at || r.observedAt > now,
      )
    )
      throw conflict('执行前核对必须包含任务全部库存范围及领取后的读取结果。')
    const preflight = crypto.randomUUID()
    await this.db
      .prepare(`UPDATE inventory_replenishment_jobs SET prepared_at=NULL,preflight_id=?
      WHERE id=? AND lease_id=? AND state='CLAIMED' AND lease_until>?`)
      .bind(preflight, id, lease, now)
      .run()
    await this.scan(
      'preflight-' + preflight,
      rows,
      { complete: true, source: 'execution-preflight', kind: 'preflight' },
      now,
    )
    const settings = await this.settings()
    const statements = await Promise.all(
      rows.map(async (row) => {
        const known = await this.db
          .prepare('SELECT * FROM inventory_replenishment_eligibility WHERE sku_key=?')
          .bind(skuKey(row))
          .first<Eligibility>()
        const decision = decide(row, settings.enabledAt, knownEligibility(known))
        return this.db
          .prepare(`UPDATE inventory_replenishment_rows SET
        observation_json=?,quantity=?,preflight_at=?,preflight_id=?,outcome=?,active=?
        WHERE job_id=? AND inventory_key=? AND outcome='PENDING'
        AND EXISTS(SELECT 1 FROM inventory_replenishment_demands WHERE inventory_key=? AND observation_json=?)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=? AND preflight_id=? AND state='CLAIMED' AND lease_until>?)`)
          .bind(
            JSON.stringify(row),
            decision.quantity,
            row.observedAt,
            preflight,
            decision.action === 'receive' ? 'PENDING' : 'SKIPPED',
            decision.action === 'receive' ? 1 : 0,
            id,
            inventoryKey(row),
            inventoryKey(row),
            JSON.stringify(row),
            id,
            lease,
            preflight,
            now,
          )
      }),
    )
    // Bounded writes can resume safely: registration requires every remaining row to have preflight evidence.
    for (let offset = 0; offset < statements.length; offset += 25)
      await this.db.batch(statements.slice(offset, offset + 25))
    const prepared = await this.db
      .prepare(`UPDATE inventory_replenishment_jobs SET prepared_at=?,
      state=CASE WHEN EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='PENDING') THEN 'CLAIMED' ELSE 'SKIPPED' END
      WHERE id=? AND lease_id=? AND preflight_id=? AND state='CLAIMED' AND lease_until>?
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='PENDING'
        AND (preflight_id IS NULL OR preflight_id<>?)) RETURNING id`)
      .bind(now, id, id, lease, preflight, now, id, preflight)
      .first()
    if (!prepared) throw conflict('执行前核对与最新库存冲突或租约已变化，请重新读取。')
    return this.job(id)
  }

  async registerSubmission(
    id: string,
    lease: string,
    packet: {
      preflightId: string
      sha256: string
      rows: ReceiveRow[]
    },
    now: number,
  ) {
    idSchema.parse(packet.preflightId)
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(packet.sha256)
    const job = await this.claimed(id, lease, now)
    if (job.preflight_id !== packet.preflightId)
      throw conflict('文件不是由当前核对版本生成，请重新制表。')
    const file = await receiveFile(packet.rows)
    if (file.sha256 !== packet.sha256) throw conflict('文件内容与登记摘要不一致。')
    const expected = new Map(job.rows.filter((r) => r.outcome === 'PENDING').map((r) => [r.rowId, r]))
    if (
      packet.rows.length !== expected.size ||
      packet.rows.some((r) => {
        const target = expected.get(r.rowId)
        return (
          !target ||
          r.sku !== target.sku ||
          r.binCode !== target.binCode ||
          r.quantity !== target.quantity ||
          r.disposition !== 'GOOD'
        )
      })
    )
      throw conflict('文件行、数量或库存状态与核对结果不一致。')
    const filename = `receive-${id}.csv`
    const ready = await this.db
      .prepare(`UPDATE inventory_replenishment_jobs SET state='SUBMITTING',filename=?,file_hash=?,submitted_at=?
      WHERE id=? AND lease_id=? AND state='CLAIMED' AND lease_until>? AND prepared_at IS NOT NULL AND preflight_id=?
      AND EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='PENDING')
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows r JOIN inventory_replenishment_demands d
        ON d.inventory_key=r.inventory_key WHERE r.job_id=? AND r.outcome='PENDING'
        AND (r.preflight_at IS NULL OR r.preflight_id IS NULL OR r.preflight_id<>? OR r.preflight_at<>d.observed_at OR r.quantity<>d.quantity
          OR r.quantity<=0 OR d.action<>'receive' OR d.paused=1)) RETURNING id`)
      .bind(filename, file.sha256, now, id, lease, now, packet.preflightId, id, id, packet.preflightId)
      .first()
    if (!ready) throw conflict('尚未核对全部库存，或核对后库存/状态发生变化。')
    const rows = file.rowMap
    // A crash here leaves SUBMITTING locked for reconciliation, never eligible for a second upload.
    for (let offset = 0; offset < rows.length; offset += 25) {
      await this.db.batch(
        rows
          .slice(offset, offset + 25)
          .map((r) =>
            this.db
              .prepare(
                'UPDATE inventory_replenishment_rows SET file_row=? WHERE id=? AND job_id=? AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)',
              )
              .bind(r.fileRow, r.rowId, id, id, lease),
          ),
      )
    }
    const current = await this.job(id)
    if (current.leaseId !== lease) throw conflict('任务已转交其他设备。')
    return current
  }

  async dispatched(id: string, lease: string) {
    const saved = await this.db
      .prepare(`UPDATE inventory_replenishment_jobs SET state='SUBMITTED'
      WHERE id=? AND lease_id=? AND state IN ('SUBMITTING','SUBMITTED') RETURNING id`)
      .bind(id, lease)
      .first()
    if (!saved) throw conflict('无法确认此任务的上传派发。')
  }

  async results(id: string, lease: string, eventId: string, input: RowResult[], now: number) {
    timeSchema.parse(now)
    idSchema.parse(eventId)
    const rows = z.array(resultSchema).max(100).parse(input)
    if (new Set(rows.map((r) => r.rowId)).size !== rows.length) throw conflict('结果包含重复行。')
    const hash = await digest(rows)
    const job = await this.job(id)
    if (job.leaseId !== lease || job.submitted_at === null) throw conflict('结果与已登记提交不匹配。')
    const previous = await this.db
      .prepare('SELECT digest FROM inventory_replenishment_events WHERE job_id=? AND id=?')
      .bind(id, eventId)
      .first<{ digest: string }>()
    if (previous && previous.digest !== hash) throw conflict('同一事件编号不能对应不同结果。')
    if (previous) return this.job(id)
    const known = new Set(job.rows.map((r) => r.rowId))
    if (rows.some((r) => !known.has(r.rowId))) throw conflict('结果包含其他任务的行。')
    const outcomes = new Map(job.rows.map((r) => [r.rowId, r.outcome]))
    if (rows.some((r) => !['PENDING', 'UNKNOWN', r.outcome].includes(outcomes.get(r.rowId)!)))
      throw conflict('新结果与已确认的任务行结论冲突。')
    const statements = [
      this.db
        .prepare(`INSERT INTO inventory_replenishment_events
      SELECT ?,?,?,?,0,? WHERE EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=? AND submitted_at IS NOT NULL) ON CONFLICT(job_id,id) DO NOTHING`)
        .bind(id, eventId, hash, JSON.stringify(rows), now, id, lease),
    ]
    for (const row of rows) {
      statements.push(
        this.db
          .prepare(`UPDATE inventory_replenishment_rows SET outcome=?,active=?,result_event=?,resolved_at=?,error=?
        WHERE job_id=? AND id=? AND outcome IN ('PENDING','UNKNOWN')
        AND EXISTS(SELECT 1 FROM inventory_replenishment_events WHERE job_id=? AND id=? AND digest=? AND applied=0)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)`)
          .bind(
            row.outcome,
            row.outcome === 'FAILED' ? 0 : 1,
            eventId,
            row.outcome === 'UNKNOWN' ? null : now,
            row.error ?? null,
            id,
            row.rowId,
            id,
            eventId,
            hash,
            id,
            lease,
          ),
      )
      if (row.outcome === 'FAILED')
        statements.push(
          this.db
            .prepare(`UPDATE inventory_replenishment_demands SET
        failure_count=failure_count+1,retry_at=?,paused=CASE WHEN failure_count+1>=4 THEN 1 ELSE paused END
        WHERE inventory_key=(SELECT inventory_key FROM inventory_replenishment_rows WHERE job_id=? AND id=? AND result_event=?)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_events WHERE job_id=? AND id=? AND digest=? AND applied=0)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)`)
            .bind(now + retryDelay, id, row.rowId, eventId, id, eventId, hash, id, lease),
        )
      if (row.outcome === 'SUCCEEDED')
        statements.push(
          this.db
            .prepare(`UPDATE inventory_replenishment_demands SET failure_count=0,retry_at=0
        WHERE inventory_key=(SELECT inventory_key FROM inventory_replenishment_rows WHERE job_id=? AND id=? AND result_event=?)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_events WHERE job_id=? AND id=? AND digest=? AND applied=0)
        AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)`)
            .bind(id, row.rowId, eventId, id, eventId, hash, id, lease),
        )
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE inventory_replenishment_events SET applied=1 WHERE job_id=? AND id=? AND digest=? AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)`,
        )
        .bind(id, eventId, hash, id, lease),
    )
    statements.push(
      this.db
        .prepare(`UPDATE inventory_replenishment_jobs SET state=CASE
      WHEN EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='UNKNOWN') THEN 'UNKNOWN'
      WHEN EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='PENDING') THEN 'SUBMITTED'
      WHEN EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='FAILED') THEN
        CASE WHEN EXISTS(SELECT 1 FROM inventory_replenishment_rows WHERE job_id=? AND outcome='SUCCEEDED') THEN 'PARTIAL' ELSE 'FAILED' END
      ELSE 'SUCCEEDED' END WHERE id=? AND lease_id=?`)
        .bind(id, id, id, id, id, lease),
    )
    await this.db.batch(statements)
    const current = await this.job(id)
    if (current.leaseId !== lease) throw conflict('任务已转交其他设备。')
    return current
  }

  async recover(now: number) {
    timeSchema.parse(now)
    await this.db.batch([
      this.db
        .prepare(`UPDATE inventory_replenishment_rows SET outcome='EXPIRED',active=0 WHERE outcome='PENDING'
        AND job_id IN (SELECT id FROM inventory_replenishment_jobs WHERE state='CLAIMED' AND lease_until<=?)`)
        .bind(now),
      this.db
        .prepare(
          `UPDATE inventory_replenishment_jobs SET state='EXPIRED' WHERE state='CLAIMED' AND lease_until<=?`,
        )
        .bind(now),
      this.db
        .prepare(`UPDATE inventory_replenishment_rows SET outcome='UNKNOWN' WHERE outcome='PENDING'
        AND job_id IN (SELECT id FROM inventory_replenishment_jobs WHERE state IN ('SUBMITTING','SUBMITTED') AND lease_until<=?)`)
        .bind(now),
      this.db
        .prepare(
          `UPDATE inventory_replenishment_jobs SET state='UNKNOWN' WHERE state IN ('SUBMITTING','SUBMITTED') AND lease_until<=?`,
        )
        .bind(now),
    ])
  }

  async reconcile(rowId: string, input: InventoryObservation, now: number) {
    const row = await this.db
      .prepare('SELECT * FROM inventory_replenishment_rows WHERE id=?')
      .bind(rowId)
      .first<RowRecord>()
    const reading = observationSchema.parse(input)
    if (
      !row ||
      !['SUCCEEDED', 'UNKNOWN'].includes(row.outcome) ||
      inventoryKey(reading) !== row.inventory_key
    )
      throw conflict('对账库存与成功任务行不匹配。')
    // The submitted observation and increment are immutable: retain that submission's
    // target even when a new listing later qualifies for the higher ordered target.
    const submitted = observationSchema.parse(JSON.parse(row.observation_json))
    const target = submitted.sellable === null ? null : submitted.sellable + row.quantity
    if (
      reading.observedAt <=
        (row.resolved_at ?? (await this.job(row.job_id)).submitted_at ?? Number.MAX_SAFE_INTEGER) ||
      reading.observedAt > now ||
      reading.sellable === null ||
      target === null ||
      row.quantity <= 0 ||
      reading.sellable < target
    )
      return false
    await this.scan(
      'reconcile-' + rowId + '-' + reading.observedAt,
      [reading],
      { complete: true, source: 'execution-reconcile', kind: 'reconcile' },
      now,
    )
    await this.db
      .prepare(
        `UPDATE inventory_replenishment_rows SET active=0 WHERE id=? AND outcome IN ('SUCCEEDED','UNKNOWN')`,
      )
      .bind(rowId)
      .run()
    return true
  }
}
