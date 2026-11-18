import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { amazonAutomaticReader, automaticReadGroupSize } from './automatic-reader'
import { InventoryExecutor } from './executor'
import { type LiveDevice, type LiveEnvironment, type LiveReader, liveOutcomes, receipt } from './live'
import { fiveUnitNewListings } from './new-listing-targets'
import { automaticDemandPolicy, bulkPreflightFreshMs, ReplenishmentQueue } from './queue'
import { automaticFileMaxRows, receiveFile } from './receive-file'
import { type InventoryObservation, inventoryKey, observationSchema, scopeKey, skuKey } from './rules'
import { type SourceIdentity, sourceConnection, sourceMarket } from './source'

const id = z.string().min(1).max(512)
const command = z.object({ jobId: id, leaseId: id }).strict()
const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
const scopeFor = (seller: string) => ({
  sellerAccountId: seller,
  marketplaceId: sourceMarket,
  warehouseCode: 'A1C5',
})
type Job = Awaited<ReturnType<ReplenishmentQueue['job']>>
type Owner = {
  job_id: string
  seller: string
  connection_revision: string
  scope_json: string
  device_id: string
  receipt_event_id: string | null
}
const fileRows = (job: Job) =>
  job.rows
    .filter((r) => r.quantity > 0 && !['SKIPPED', 'EXPIRED'].includes(r.outcome))
    .map((r) => ({
      rowId: r.rowId,
      sku: r.sku,
      binCode: r.binCode,
      quantity: r.quantity,
      disposition: 'GOOD' as const,
    }))
const hash = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('')
export class InventoryAutomatic {
  private readonly queue: ReplenishmentQueue
  private readonly reader: LiveReader
  private readonly customReader: boolean
  constructor(
    private readonly env: LiveEnvironment,
    reader?: LiveReader,
  ) {
    this.queue = new ReplenishmentQueue(env.DB)
    this.reader = reader ?? amazonAutomaticReader(env)
    this.customReader = !!reader
  }
  async status() {
    const settings = await this.env.DB.prepare(
      'SELECT enabled,new_listings_enabled AS newListingsEnabled,(SELECT interval_minutes FROM inventory_source_settings WHERE singleton=1) AS intervalMinutes,updated_at AS updatedAt,activated_after AS activatedAfter FROM inventory_automatic_settings WHERE singleton=1',
    ).first<{
      enabled: number
      newListingsEnabled: number
      intervalMinutes: number
      updatedAt: number
      activatedAfter: number | null
    }>()
    const seller =
      (
        await this.env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
          seller: string
        }>()
      )?.seller ?? ''
    const generation = await this.env.DB.prepare(
      `SELECT g.*,c.generation AS source_generation FROM inventory_source_current c LEFT JOIN inventory_automatic_generations g ON g.generation=c.generation WHERE c.seller=?`,
    )
      .bind(seller)
      .first()
    const counts = await this.env.DB.prepare(
      `SELECT COUNT(*) AS candidates,COALESCE(SUM(d.paused=1),0) AS paused,COALESCE(SUM(d.retry_at>?),0) AS coolingDown,COALESCE(SUM(d.paused=0 AND d.retry_at<=? AND d.action IN('receive','review') AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_rows r WHERE r.inventory_key=d.inventory_key AND r.active=1)),0) AS pending FROM inventory_automatic_candidates a JOIN inventory_source_current c ON c.generation=a.generation AND c.seller=? JOIN inventory_replenishment_demands d ON d.inventory_key=a.inventory_key JOIN inventory_source_runs run ON run.id=a.generation JOIN inventory_automatic_settings s ON s.singleton=1 WHERE run.started_at>s.activated_after AND ${automaticDemandPolicy}`,
    )
      .bind(Date.now(), Date.now(), seller)
      .first()
    const jobs = await this.env.DB.prepare(
      `SELECT COUNT(*) AS batches,COALESCE(SUM(receipt_event_id IS NOT NULL),0) AS recorded,COALESCE(SUM(receipt_event_id IS NULL AND j.state NOT IN('EXPIRED','SKIPPED')),0) AS awaitingReceipt FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE a.seller=?`,
    )
      .bind(seller)
      .first()
    const reconciliation = await this.env.DB.prepare(
      `SELECT COUNT(*) AS pending,COALESCE(SUM(r.outcome='UNKNOWN'),0) AS unknown FROM inventory_automatic_jobs a JOIN inventory_replenishment_rows r ON r.job_id=a.job_id WHERE a.seller=? AND r.active=1 AND r.outcome IN('SUCCEEDED','UNKNOWN')`,
    )
      .bind(seller)
      .first()
    const history = await this.env.DB.prepare(
      `SELECT COALESCE(SUM(state='COMPLETE'),0) AS completedWindows,MIN(CASE WHEN state='COMPLETE' THEN window_from END) AS oldestFrom,MAX(CASE WHEN state='COMPLETE' THEN window_through END) AS latestThrough,COALESCE(SUM(state='RUNNING'),0) AS running,(SELECT COUNT(*) FROM inventory_order_history_qualifications q JOIN inventory_order_history_runs r ON r.id=q.evidence_run AND r.state='COMPLETE' WHERE q.seller=?) AS positiveSkus FROM inventory_order_history_runs WHERE seller=?`,
    )
      .bind(seller, seller)
      .first()
    return {
      mode: 'AUTO_REPLENISH',
      history,
      maxRows: automaticFileMaxRows,
      enabled: settings?.enabled === 1,
      newListingsEnabled: settings?.newListingsEnabled === 1,
      intervalMinutes: settings?.intervalMinutes ?? 60,
      updatedAt: settings?.updatedAt ?? 0,
      activatedAfter: settings?.activatedAfter ?? null,
      startFrom: 'NEXT_PATROL',
      generation,
      counts,
      jobs,
      reconciliation,
      executor: await new InventoryExecutor(this.env.DB).status(),
    }
  }
  async configure(role: string, input: unknown, now = Date.now()) {
    if (role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以修改自动补库。', 403)
    const data = z
      .object({
        enabled: z.boolean(),
        intervalMinutes: z.number().int().min(5).max(10080),
        startFrom: z.literal('NEXT_PATROL').default('NEXT_PATROL'),
        newListingsEnabled: z.boolean().optional(),
      })
      .strict()
      .parse(input)
    if (data.enabled) await sourceConnection(this.env)
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE inventory_automatic_settings SET activated_after=CASE WHEN enabled=0 AND ?=1 THEN ? ELSE activated_after END,enabled=?,interval_minutes=?,updated_at=?,new_listings_enabled=COALESCE(?,new_listings_enabled) WHERE singleton=1',
      ).bind(data.enabled ? 1 : 0, now, data.enabled ? 1 : 0, data.intervalMinutes, now,
        data.newListingsEnabled === undefined ? null : Number(data.newListingsEnabled)),
      this.env.DB.prepare(
        'UPDATE inventory_source_settings SET enabled=CASE WHEN ?=1 THEN 1 ELSE enabled END,interval_minutes=?,activated_at=COALESCE(activated_at,?),updated_at=? WHERE singleton=1',
      ).bind(data.enabled ? 1 : 0, data.intervalMinutes, now, now),
    ])
    return this.status()
  }
  /** One bounded source page. Only an entirely seeded, still-current COMPLETE generation may execute. */
  async plan(now = Date.now(), limit = 100, generation?: string) {
    z.number().int().min(1).max(500).parse(limit)
    const run = await this.env.DB.prepare(
      `SELECT r.id,r.seller,r.started_at,r.activated_at FROM inventory_source_current c
       JOIN inventory_source_runs r ON r.id=c.generation AND r.state='COMPLETE'
       JOIN title_audit_store t ON t.singleton=1 AND t.seller=c.seller
       WHERE (? IS NULL OR r.id=?)`,
    ).bind(generation ?? null, generation ?? null).first<{
      id: string
      seller: string
      started_at: number
      activated_at: number
    }>()
    if (!run) return { complete: generation !== undefined, rows: 0 }
    const activation = await this.env.DB.prepare(
      'SELECT activated_after,enabled,new_listings_enabled FROM inventory_automatic_settings WHERE singleton=1',
    ).first<{ activated_after: number | null; enabled: number; new_listings_enabled: number }>()
    if (!activation?.enabled) return { complete: true, rows: 0, disabled: true }
    if (
      activation?.enabled &&
      activation.activated_after !== null &&
      run.started_at <= activation.activated_after
    )
      return { complete: true, rows: 0, skippedBeforeActivation: true, generation: run.id }
    await this.queue.configure('admin', { enabledAt: run.activated_at, intervalMinutes: 60 })
    await this.env.DB.prepare(
      'INSERT INTO inventory_automatic_generations(generation,seller,updated_at) VALUES(?,?,?) ON CONFLICT(generation) DO NOTHING',
    )
      .bind(run.id, run.seller, now)
      .run()
    const progress = (await this.env.DB.prepare(
      'SELECT cursor,state FROM inventory_automatic_generations WHERE generation=?',
    )
      .bind(run.id)
      .first<{ cursor: string; state: string }>())!
    if (progress.state === 'COMPLETE') return { complete: true, rows: 0 }
    const page = (
      await this.env.DB.prepare(
        `SELECT r.sku,r.sellable,r.listing_status,r.created_at,r.ordered,r.new_listing,q.ordered_generation,q.new_generation,
           history.id AS history_run,e.ordered_scan_id
         FROM inventory_source_rows r
         LEFT JOIN inventory_source_qualifications q ON q.seller=?1 AND q.sku=r.sku
         LEFT JOIN inventory_order_history_qualifications h ON h.seller=?1 AND h.sku=r.sku
         LEFT JOIN inventory_order_history_runs history ON history.id=h.evidence_run AND history.seller=h.seller AND history.state='COMPLETE'
         LEFT JOIN inventory_replenishment_eligibility e ON e.sku_key=json_array(?1,'ATVPDKIKX0DER','A1C5',r.sku)
         WHERE r.generation=? AND r.sku>? AND r.listing_status NOT IN('banned','stopped','closed','suppressed')
         AND (r.ordered=1 OR q.ordered_generation IS NOT NULL OR history.id IS NOT NULL OR e.ordered_scan_id IS NOT NULL
           OR (?=1 AND (r.new_listing=1 OR q.new_generation IS NOT NULL)))
         AND (r.sellable IS NULL OR r.sellable < 5) ORDER BY r.sku LIMIT ?`,
      )
        .bind(run.seller, run.id, progress.cursor, activation.new_listings_enabled, limit)
        .all<{
          sku: string
          sellable: number | null
          listing_status: InventoryObservation['listingStatus']
          created_at: number | null
          ordered: number | null
          new_listing: number
          ordered_generation: string | null
          new_generation: string | null
          history_run: string | null
          ordered_scan_id: string | null
        }>()
    ).results
    const isOrdered = (r: (typeof page)[number]) =>
      r.ordered === 1 || !!r.ordered_generation || !!r.history_run || !!r.ordered_scan_id
    const targetFive = await fiveUnitNewListings(
      this.env.DB,
      run.seller,
      page.filter((r) => !isOrdered(r)).map((r) => r.sku),
    )
    const candidates = page.filter(
      (r) => r.sellable === null || r.sellable < (isOrdered(r) || targetFive.has(r.sku) ? 5 : 2),
    )
    const rows = candidates.map((r) => ({
      ...scopeFor(run.seller),
      binCode: 'Default',
      inventoryType: 'GOOD',
      sku: r.sku,
      sellable: r.sellable,
      listingStatus: r.listing_status,
      createdAt: r.created_at,
      hasOrdered: isOrdered(r) ? true : null,
      observedAt: run.started_at,
    }))
    if (rows.length) {
      const digest = await hash(JSON.stringify({ cursor: progress.cursor, rows, targetFive: [...targetFive] }))
      const scanId = 'automatic-' + run.id + '-' + digest
      await this.queue.scan(
        scanId,
        rows,
        {
          complete: true,
          source: 'automatic-source-candidates',
          automaticGeneration: run.id,
          fiveUnitNewListings: targetFive,
        },
        Math.max(now, run.started_at),
      )
      for (let offset = 0; offset < rows.length; offset += 75) {
        const batch = rows.slice(offset, offset + 75)
        const newKeys = batch
          .filter((_, index) => candidates[offset + index].new_listing || candidates[offset + index].new_generation)
          .map(skuKey)
        await this.env.DB.batch([
          this.env.DB.prepare(`INSERT INTO inventory_automatic_candidates
            SELECT ?,value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`)
            .bind(run.id, JSON.stringify(batch.map(inventoryKey))),
          ...(newKeys.length ? [
            this.env.DB.prepare(`UPDATE inventory_replenishment_eligibility SET new_listing_scan_id=?
              WHERE new_listing_scan_id IS NULL AND sku_key IN (SELECT value FROM json_each(?))`)
              .bind(scanId, JSON.stringify(newKeys)),
          ] : []),
        ])
      }
      // Candidate quantities are estimates only; review status is preserved and every permit requires fresh API preflight.
      await this.env.DB.prepare(
        `UPDATE inventory_replenishment_demands SET quantity=(CASE WHEN json_extract(observation_json,'$.hasOrdered')=1 OR json_extract(observation_json,'$.sku') IN (SELECT value FROM json_each(?)) THEN 5 ELSE 2 END)-COALESCE(json_extract(observation_json,'$.sellable'),0) WHERE scan_id=? AND action='review'`,
      )
        .bind(JSON.stringify([...targetFive]), scanId)
        .run()
    }
    if (page.length) {
      await this.env.DB.prepare(
        "UPDATE inventory_automatic_generations SET cursor=?,updated_at=? WHERE generation=? AND cursor=? AND state='SEEDING'",
      )
        .bind(page[page.length - 1].sku, now, run.id, progress.cursor)
        .run()
    }
    if (page.length < limit)
      await this.env.DB.prepare(
        "UPDATE inventory_automatic_generations SET state='COMPLETE',updated_at=? WHERE generation=? AND cursor=?",
      )
        .bind(now, run.id, page.at(-1)?.sku ?? progress.cursor)
        .run()
    return { complete: page.length < limit, rows: rows.length, generation: run.id }
  }
  private view(job: Job, includeRows = true) {
    return {
      id: job.id,
      leaseId: job.leaseId,
      mode: 'AUTO_REPLENISH' as const,
      ...(job.channel === 'BULK' ? { bulk: true as const } : {}),
      state: job.state,
      rows:
        !includeRows ? [] : job.state === 'CLAIMED'
          ? job.rows
              .filter((r) => r.outcome === 'PENDING')
              .map((r) => ({
                rowId: r.rowId,
                sku: r.sku,
                binCode: r.binCode,
                quantity: r.quantity || 5,
                disposition: 'GOOD' as const,
              }))
          : fileRows(job),
      rowStates: includeRows ? job.rows.map((r) => ({ sku: r.sku, outcome: r.outcome, active: r.active })) : [],
      warehouseCode: 'A1C5' as const,
      expiresAt: job.lease_until,
      filename: job.filename,
      sha256: job.file_hash,
      needsReconciliation: job.submitted_at !== null,
    }
  }
  private async owned(device: LiveDevice, input: unknown) {
    const data = command.parse(input),
      owner = await this.env.DB.prepare('SELECT * FROM inventory_automatic_jobs WHERE job_id=?')
        .bind(data.jobId)
        .first<Owner>()
    if (!owner || owner.device_id !== device.id || owner.scope_json !== device.scope_json)
      throw conflict('此自动任务不属于当前设备。')
    const job = await this.queue.job(data.jobId)
    if (job.leaseId !== data.leaseId) throw conflict('任务租约已变化。')
    return { owner, job }
  }
  private async retireStaleUnsubmitted() {
    // In one transaction, release only tasks that provably never received a CSV.
    // Heartbeats must not keep an obsolete generation or disabled activation alive.
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE inventory_replenishment_jobs SET state='EXPIRED'
        WHERE state='CLAIMED' AND submitted_at IS NULL AND id IN (
          SELECT a.job_id FROM inventory_automatic_jobs a WHERE NOT EXISTS (
            SELECT 1 FROM inventory_automatic_settings s
            JOIN inventory_source_current c ON c.seller=a.seller AND c.generation=a.generation
            JOIN inventory_source_runs r ON r.id=c.generation AND r.state='COMPLETE'
            JOIN title_audit_store t ON t.singleton=1 AND t.seller=a.seller
            WHERE s.singleton=1 AND s.enabled=1 AND r.started_at>s.activated_after
            AND a.credential_stamp=COALESCE((SELECT json_array(version,nonce,ciphertext) FROM connection_credentials WHERE provider='amazon'),'null')
          )
        )`),
      this.env.DB.prepare(`UPDATE inventory_replenishment_rows SET outcome='EXPIRED',active=0
        WHERE outcome='PENDING' AND job_id IN (
          SELECT j.id FROM inventory_replenishment_jobs j JOIN inventory_automatic_jobs a ON a.job_id=j.id
          WHERE j.state='EXPIRED' AND j.submitted_at IS NULL
        )`),
    ])
  }
  async claim(device: LiveDevice, now = Date.now(), input: unknown = {}, requireBulk = false) {
    const request = z
      .object({ previousJobId: id.optional(), previousLeaseId: id.optional(), bulk: z.literal(true).optional() })
      .strict()
      .refine((v) => !!v.previousJobId === !!v.previousLeaseId)
      .parse(input)
    if (request.bulk && requireBulk) {
      await this.env.DB.prepare(`UPDATE inventory_devices SET bulk_seen_at=?
        WHERE id=? AND revoked_at IS NULL AND scope_json=? AND COALESCE(bulk_seen_at,0)<?`)
        .bind(now, device.id, device.scope_json, now - 60_000).run()
    }
    await this.retireStaleUnsubmitted()
    await this.queue.recover(now)
    let previousJob: Record<string, unknown> | null = null
    if (request.previousJobId) {
      const transfer = await this.env.DB.prepare(
        'SELECT * FROM inventory_device_transfers WHERE job_id=? AND old_lease_id=? AND old_device_id=? AND scope_json=?',
      )
        .bind(request.previousJobId, request.previousLeaseId!, device.id, device.scope_json)
        .first<{ submitted: number; new_device_id: string }>()
      if (transfer)
        previousJob = {
          id: request.previousJobId,
          leaseId: request.previousLeaseId,
          state: 'TRANSFERRED',
          submitted: transfer.submitted === 1,
          newDeviceId: transfer.new_device_id,
        }
      else {
        const prior = await this.env.DB.prepare(
          `SELECT j.state,j.submitted_at,a.receipt_event_id FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE j.id=? AND j.lease_id=? AND a.device_id=? AND a.scope_json=?`,
        )
          .bind(request.previousJobId, request.previousLeaseId!, device.id, device.scope_json)
          .first<{ state: string; submitted_at: number | null; receipt_event_id: string | null }>()
        if (prior?.receipt_event_id)
          previousJob = {
            id: request.previousJobId,
            leaseId: request.previousLeaseId,
            state: 'RECORDED',
            submitted: true,
            eventId: prior.receipt_event_id,
          }
        else if (prior && prior.submitted_at === null && ['EXPIRED', 'SKIPPED'].includes(prior.state))
          previousJob = {
            id: request.previousJobId,
            leaseId: request.previousLeaseId,
            state: prior.state,
            submitted: false,
          }
      }
    }
    if ((await new InventoryExecutor(this.env.DB).status()).deviceId !== device.id)
      return { job: null, previousJob }
    const existing = await this.env.DB.prepare(
      `SELECT a.job_id FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE a.device_id=? AND a.scope_json=? AND a.receipt_event_id IS NULL AND j.state NOT IN('EXPIRED','SKIPPED') ORDER BY a.created_at LIMIT 1`,
    )
      .bind(device.id, device.scope_json)
      .first<{ job_id: string }>()
    if (existing) return { job: this.view(await this.queue.job(existing.job_id)), previousJob }
    if (requireBulk && !request.bulk) return { job: null, previousJob }
    const { identity } = await sourceConnection(this.env)
    if (device.scope_json !== JSON.stringify(scopeFor(identity.seller)))
      return { job: null, previousJob }
    const run = await this.env.DB.prepare(
      `SELECT r.id FROM inventory_source_current c JOIN inventory_source_runs r ON r.id=c.generation AND r.state='COMPLETE' JOIN inventory_automatic_generations g ON g.generation=r.id AND g.state='COMPLETE' WHERE c.seller=? AND r.connection_revision=?`,
    )
      .bind(identity.seller, identity.revision)
      .first<{ id: string }>()
    if (!run) return { job: null, previousJob }
    const stamp = await this.env.DB.prepare(
      "SELECT json_array(version,nonce,ciphertext) AS stamp FROM connection_credentials WHERE provider='amazon'",
    ).first<{ stamp: string }>()
    const job = await this.queue.claim(
      scopeKey(scopeFor(identity.seller)),
      now,
      request.bulk ? automaticFileMaxRows : 10,
      undefined,
      undefined,
      {
        deviceId: device.id,
        scopeJson: device.scope_json,
        seller: identity.seller,
        revision: identity.revision,
        generation: run.id,
        credentialStamp: stamp?.stamp ?? 'null',
        bulk: request.bulk,
      },
    )
    return { job: job ? this.view(job) : null, previousJob }
  }
  private async readOne(identity: SourceIdentity, sku: string, now: number) {
    const snapshot = await this.reader(identity, [sku], now),
      rows = z.array(observationSchema).parse(snapshot.observations)
    if (
      rows.length !== 1 ||
      rows[0].sku !== sku ||
      scopeKey(rows[0]) !== scopeKey(scopeFor(identity.seller)) ||
      rows[0].binCode !== 'Default' ||
      rows[0].inventoryType !== 'GOOD' ||
      rows[0].observedAt !== now
    )
      throw conflict('实时快照范围不一致。')
    return rows[0]
  }
  async prepare(device: LiveDevice, input: unknown, now = Date.now()) {
    const { owner, job } = await this.owned(device, input)
    if (job.state !== 'CLAIMED') return { job: this.view(job) }
    const enabled = await this.env.DB.prepare(
      'SELECT new_listings_enabled FROM inventory_automatic_settings WHERE singleton=1 AND enabled=1',
    ).first<{ new_listings_enabled: number }>()
    if (!enabled) throw conflict('自动补库已关闭。')
    const { identity } = await sourceConnection(this.env, {
      seller: owner.seller,
      revision: owner.connection_revision,
    })
    const observations: InventoryObservation[] = []
    const pending = job.rows.filter((r) => r.outcome === 'PENDING')
    const bulkId = job.channel === 'BULK' ? await this.queue.beginBulkPreflight(job.id, job.leaseId, now) : undefined
    const selected = bulkId
      ? pending.filter((r) => r.preflightId !== bulkId || (r.preflightAt ?? 0) < now - bulkPreflightFreshMs)
          .slice(0, automaticReadGroupSize)
      : pending
    const batch = selected.length && (!this.customReader || bulkId)
      ? await this.reader(identity, selected.map((r) => r.sku), now, Boolean(bulkId)).catch(() => {
          if (bulkId) throw conflict('批量库存复核暂不可用，将继续复核此批。')
          return null
        })
      : null
    if (batch?.evidence && this.env.ARCHIVE)
      await this.env.ARCHIVE.put(
        `inventory-automatic/${job.id}/preflight-${now}-${crypto.randomUUID()}.json`,
        JSON.stringify(batch),
      )
    const retries: string[] = []
    for (const row of selected) {
      let reading: InventoryObservation
      try {
        if (this.customReader && !bulkId) reading = await this.readOne(identity, row.sku, now)
        else {
          const matches = batch?.observations.filter((r) => r.sku === row.sku)
          if (matches?.length !== 1) throw Error('SOURCE_READING_MISSING')
          reading = observationSchema.parse(matches[0])
          if (inventoryKey(reading) !== inventoryKey(row) || reading.observedAt !== now)
            throw Error('SOURCE_READING_SCOPE')
        }
      } catch {
        const { rowId, quantity, fileRow, preflightAt, preflightId, outcome, active, ...observation } = row
        reading = { ...observation, sellable: null, listingStatus: 'unknown', observedAt: now }
      }
      observations.push(reading)
      if (reading.sellable === null || ['unknown', 'suppressed'].includes(reading.listingStatus))
        retries.push(inventoryKey(reading))
    }
    const targetFive = enabled.new_listings_enabled === 1 ? await fiveUnitNewListings(
      this.env.DB,
      owner.seller,
      observations.filter((r) => r.hasOrdered !== true).map((r) => r.sku),
    ) : undefined
    const permitNow = arguments.length < 3 ? Date.now() : now
    const checked = await this.queue.preflight(job.id, job.leaseId, observations, permitNow, {
      fiveUnitNewListings: targetFive,
      orderedOnly: enabled.new_listings_enabled === 0,
      bulkId,
    })
    if (retries.length) {
      await this.env.DB.prepare(`UPDATE inventory_replenishment_demands SET retry_at=?
        WHERE inventory_key IN (SELECT value FROM json_each(?)) AND observed_at=?`)
        .bind(permitNow + 120000, JSON.stringify(retries), now).run()
    }
    if (bulkId && selected.length) return { pending: true as const, job: this.view(checked, false) }
    if (checked.state === 'SKIPPED') return { job: this.view(checked) }
    const rows = fileRows(checked),
      file = await receiveFile(rows)
    await sourceConnection(this.env, identity)
    const prepared = await this.queue.registerSubmission(
      job.id,
      job.leaseId,
      { preflightId: checked.preflight_id!, sha256: file.sha256, rows },
      permitNow,
    )
    await this.owned(device, input)
    return { job: { ...this.view(prepared), csv: file.csv, needsReconciliation: false } }
  }
  async heartbeat(device: LiveDevice, input: unknown, now = Date.now()) {
    await this.retireStaleUnsubmitted()
    const { job } = await this.owned(device, input)
    if (job.lease_until > now && ['CLAIMED', 'SUBMITTING', 'SUBMITTED'].includes(job.state))
      await this.queue.heartbeat(job.id, job.leaseId, now)
    return { job: this.view((await this.owned(device, input)).job) }
  }
  async dispatched(device: LiveDevice, input: unknown) {
    const { job } = await this.owned(device, input)
    await this.queue.dispatched(job.id, job.leaseId)
    return { accepted: true, job: this.view((await this.owned(device, input)).job) }
  }
  async results(device: LiveDevice, input: unknown, now = Date.now()) {
    const data = receipt.parse(input),
      { job } = await this.owned(device, { jobId: data.jobId, leaseId: data.leaseId })
    if (
      job.submitted_at === null ||
      data.filename !== job.filename ||
      data.sha256 !== job.file_hash ||
      data.evidence.observedAt < job.submitted_at ||
      data.evidence.observedAt > now + 60000
    )
      throw conflict('回执与登记文件不一致。')
    if (!this.env.ARCHIVE) throw conflict('回执存档暂不可用。')
    const payload = JSON.stringify(data),
      digest = await hash(payload)
    await this.env.DB.prepare(
      'INSERT INTO inventory_automatic_events(job_id,event_id,digest,payload_json,received_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
    )
      .bind(job.id, data.eventId, digest, payload, now)
      .run()
    const saved = (await this.env.DB.prepare(
      'SELECT digest,applied FROM inventory_automatic_events WHERE job_id=? AND event_id=?',
    )
      .bind(job.id, data.eventId)
      .first<{ digest: string; applied: number }>())!
    if (saved.digest !== digest) throw conflict('同一回执事件不能修改内容。')
    if (!saved.applied) {
      const archiveKey =
        'inventory-automatic/' + job.id + '/receipt-' + (await hash(data.eventId)) + '.json'
      await this.env.ARCHIVE.put(archiveKey, payload, {
        httpMetadata: { contentType: 'application/json' },
      })
      await this.queue.results(job.id, job.leaseId, data.eventId, liveOutcomes(job, data), now)
      await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE inventory_automatic_events SET applied=1,archive_key=? WHERE job_id=? AND event_id=? AND digest=? AND EXISTS(SELECT 1 FROM inventory_replenishment_jobs WHERE id=? AND lease_id=?)',
        ).bind(archiveKey, job.id, data.eventId, digest, job.id, job.leaseId),
        this.env.DB.prepare(
          'UPDATE inventory_automatic_jobs SET receipt_event_id=COALESCE(receipt_event_id,?) WHERE job_id=? AND EXISTS(SELECT 1 FROM inventory_automatic_events WHERE job_id=? AND event_id=? AND applied=1)',
        ).bind(data.eventId, job.id, job.id, data.eventId),
      ])
    }
    const current = await this.owned(device, { jobId: job.id, leaseId: job.leaseId })
    if (!current.owner.receipt_event_id) throw conflict('回执尚未完成持久化。')
    return {
      accepted: true,
      replay: saved.applied === 1,
      job: this.view(current.job),
      receipt: {
        id: job.id,
        leaseId: job.leaseId,
        eventId: data.eventId,
        state: 'RECORDED' as const,
        submitted: true,
      },
    }
  }
  async reconcile(now = Date.now()) {
    await this.queue.recover(now)
    const rows = (
      await this.env.DB.prepare(
        `SELECT r.id,r.observation_json,a.job_id,a.seller,j.channel
         FROM inventory_automatic_jobs a JOIN inventory_replenishment_rows r ON r.job_id=a.job_id
         JOIN inventory_replenishment_jobs j ON j.id=a.job_id
         WHERE r.active=1 AND r.outcome IN('SUCCEEDED','UNKNOWN') AND r.reconcile_after<=? AND a.job_id=(
           SELECT q.job_id FROM inventory_automatic_jobs q WHERE q.reconcile_at<=?
           AND EXISTS(SELECT 1 FROM inventory_replenishment_rows pending WHERE pending.job_id=q.job_id
             AND pending.active=1 AND pending.outcome IN('SUCCEEDED','UNKNOWN') AND pending.reconcile_after<=?)
           ORDER BY q.reconcile_at,q.created_at,q.job_id LIMIT 1
         ) ORDER BY r.reconcile_after,r.id LIMIT ?`,
      )
        .bind(now, now, now, automaticReadGroupSize)
        .all<{
          id: string
          job_id: string
          observation_json: string
          seller: string
          channel: string
        }>()
    ).results
    let reconciled = 0
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) grouped.set(row.job_id, [...(grouped.get(row.job_id) ?? []), row])
    for (const [jobId, group] of grouped) {
      const bulk = group[0].channel === 'BULK'
      const lock = await this.env.DB.prepare(
        'UPDATE inventory_automatic_jobs SET reconcile_at=? WHERE job_id=? AND reconcile_at<=? RETURNING job_id',
      )
        .bind(now + (bulk ? 25_000 : 120_000), jobId, now)
        .first()
      if (!lock) continue
      try {
        if (bulk) await this.env.DB.prepare(`UPDATE inventory_replenishment_rows SET reconcile_after=?
          WHERE job_id=? AND id IN(SELECT value FROM json_each(?)) AND active=1`)
          .bind(now + 120_000, jobId, JSON.stringify(group.map((r) => r.id))).run()
        const { identity } = await sourceConnection(this.env)
        if (identity.seller !== group[0].seller) continue
        const snapshot = await this.reader(
          identity,
          group.map((r) => (JSON.parse(r.observation_json) as InventoryObservation).sku),
          now,
          bulk,
        )
        const verified: InventoryObservation[] = []
        for (const row of group) {
          const original = JSON.parse(row.observation_json) as InventoryObservation
          const matches = snapshot.observations.filter((r) => r.sku === original.sku)
          if (matches.length !== 1) continue
          const reading = observationSchema.parse(matches[0])
          if (inventoryKey(reading) !== inventoryKey(original) || reading.observedAt !== now) continue
          if (bulk) verified.push(reading)
          else if (await this.queue.reconcile(row.id, reading, now)) reconciled++
        }
        if (bulk) reconciled += await this.queue.reconcileBulk(jobId, verified, now)
      } catch {
        /* Retain submission locks; per-SKU read failures in the batch reader become unknown observations. */
      }
    }
    return { checked: rows.length, reconciled }
  }
  async prune(limit = 5000) {
    z.number().int().min(1).max(5000).parse(limit)
    // Reproducible source staging keeps current + latest two snapshots. Execution
    // evidence, current demands and qualification references remain intact.
    const obsolete = `SELECT g.generation FROM inventory_automatic_generations g
      JOIN inventory_source_runs old ON old.id=g.generation
      WHERE old.state='COMPLETE' AND g.generation NOT IN(SELECT generation FROM inventory_source_current)
      AND g.generation NOT IN(SELECT id FROM inventory_source_runs r WHERE r.seller=old.seller
        AND r.state='COMPLETE' ORDER BY r.started_at DESC,r.id DESC LIMIT 2)`
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM inventory_replenishment_observations WHERE rowid IN(
        SELECT o.rowid FROM inventory_replenishment_observations o
        JOIN inventory_automatic_scans a ON a.scan_id=o.scan_id
        WHERE a.generation IN(${obsolete}) LIMIT ?)`).bind(limit),
      this.env.DB.prepare(`DELETE FROM inventory_automatic_candidates WHERE rowid IN(
        SELECT rowid FROM inventory_automatic_candidates WHERE generation IN(${obsolete}) LIMIT ?)`).bind(
        limit,
      ),
    ])
    const unused = (
      await this.env.DB.prepare(`SELECT a.scan_id FROM inventory_automatic_scans a
      WHERE a.generation IN(${obsolete})
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_observations o WHERE o.scan_id=a.scan_id)
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_demands d WHERE d.scan_id=a.scan_id)
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_eligibility e WHERE e.ordered_scan_id=a.scan_id)
      AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_eligibility e WHERE e.new_listing_scan_id=a.scan_id)
      LIMIT 100`).all<{ scan_id: string }>()
    ).results.map((r) => r.scan_id)
    if (unused.length)
      await this.env.DB.batch([
        this.env.DB.prepare(
          'DELETE FROM inventory_automatic_scans WHERE scan_id IN(SELECT value FROM json_each(?))',
        ).bind(JSON.stringify(unused)),
        this.env.DB.prepare(
          'DELETE FROM inventory_replenishment_scans WHERE id IN(SELECT value FROM json_each(?))',
        ).bind(JSON.stringify(unused)),
      ])
    return { removed: results.reduce((sum, r) => sum + r.meta.changes, 0), scansRemoved: unused.length }
  }
}
