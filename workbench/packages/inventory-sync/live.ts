import { z } from 'zod'
import type { ConnectionBindings } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { InventoryExecutor } from './executor'
import { ReplenishmentQueue } from './queue'
import { receiveFile } from './receive-file'
import { type InventoryObservation, inventoryKey, observationSchema, scopeKey } from './rules'
import { AmazonSourceClient, type SourceIdentity, sourceConnection, sourceMarket } from './source'

const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
const id = z.string().min(1).max(512)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const command = z.object({ jobId: id, leaseId: id }).strict()
const trialInput = z
  .object({
    skus: z
      .array(id.refine((s) => s.trim() === s && !s.includes(',')))
      .min(1)
      .max(2),
  })
  .strict()
export const receipt = command
  .extend({
    eventId: id,
    filename: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    warehouseCode: z.literal('A1C5'),
    status: z.enum(['COMPLETED', 'FAILED', 'UNKNOWN']),
    errorCount: z.number().int().nonnegative().max(100000).nullable(),
    errors: z
      .array(
        z
          .object({
            sku: id.optional(),
            fileRow: z.number().int().nonnegative().optional(),
            message: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    evidence: z.object({ rowText: z.string().min(1).max(16000), observedAt: time }).strict(),
  })
  .strict()
export type LiveReceipt = z.infer<typeof receipt>
export type LiveDevice = { id: string; scope_json: string }
export type LiveEnvironment = ConnectionBindings & { ARCHIVE?: R2Bucket }
export type LiveSnapshot = {
  observations: InventoryObservation[]
  updatedAt: Record<string, number | null>
  evidence?: unknown
}
export type LiveReader = (identity: SourceIdentity, skus: string[], now: number) => Promise<LiveSnapshot>
type Trial = {
  id: string
  seller: string
  connection_revision: string
  scope_json: string
  skus_json: string
  actor: string
  created_at: number
  ended_at: number | null
  device_id: string | null
  claim_token: string | null
  state: string
  error: string | null
  snapshot_json: string | null
  updated_at: number
}
type Job = Awaited<ReturnType<ReplenishmentQueue['job']>>
const scopeFor = (seller: string) => ({
  sellerAccountId: seller,
  marketplaceId: sourceMarket,
  warehouseCode: 'A1C5',
})
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
async function hash(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('')
}

/** Fresh Listings Items status: listing and attribute restrictions always win.
 * Image errors alone do not block replenishment, including discoverable out-of-stock listings.
 * https://developer-docs.amazon/sp-api/reference/getlistingsitem
 * https://developer-docs.amazon/sp-api/docs/retrieve-details-about-a-listing
 * https://m.media-amazon.com/images/G/02/selleruniversity/Listings_Troubleshooting_EN4.pdf */
export function liveListing(
  raw: unknown,
  sku: string,
  now = Date.now(),
): { status: InventoryObservation['listingStatus']; createdAt: number | null } {
  const parsed = z
    .object({
      sku: z.string(),
      attributes: z.record(z.string(), z.unknown()).optional(),
      summaries: z.array(
        z.object({
          marketplaceId: z.string(),
          status: z.array(z.string()),
          createdDate: z.string().optional(),
        }),
      ),
      issues: z
        .array(
          z.object({
            code: z.string().optional(),
            severity: z.string(),
            categories: z.array(z.string()).optional(),
            enforcements: z
              .object({ actions: z.array(z.object({ action: z.string() })).optional() })
              .optional(),
          }),
        )
        .optional(),
    })
    .safeParse(raw)
  if (!parsed.success || parsed.data.sku !== sku) return { status: 'unknown', createdAt: null }
  const rows = parsed.data.summaries.filter((r) => r.marketplaceId === sourceMarket)
  if (rows.length !== 1) return { status: 'unknown', createdAt: null }
  const row = rows[0],
    created = row.createdDate ? Date.parse(row.createdDate) : NaN
  const createdAt = Number.isFinite(created) && created >= 0 ? created : null
  if (row.status.includes('DELETED')) return { status: 'closed', createdAt }
  if (
    parsed.data.issues?.some(
      (issue) =>
        issue.enforcements?.actions?.some(({ action }) =>
          [
            'LISTING_SUPPRESSED',
            'SEARCH_SUPPRESSED',
            'CATALOG_ITEM_REMOVED',
            'ATTRIBUTE_SUPPRESSED',
          ].includes(action),
        ) ||
        issue.categories?.some((category) =>
          /SUPPRESS|PROHIBIT|RESTRICT|REMOV|QUALIFIC|APPROV|BLOCK|BANNED|CLOSED|STOPPED/i.test(category),
        ),
    )
  )
    return { status: 'suppressed', createdAt }
  // Unknown enforcement actions remain on hold; never treat them as harmless image errors.
  if (parsed.data.issues?.some((issue) => issue.enforcements?.actions?.length))
    return { status: 'unknown', createdAt }
  if (
    parsed.data.issues?.some(
      (issue) =>
        issue.severity === 'ERROR' &&
        !(
          issue.categories?.length &&
          (issue.code === '300404' || issue.categories.includes('INVALID_IMAGE')) &&
          issue.categories.every((category) =>
            ['LISTING', 'INVALID_IMAGE', 'INVALID_ATTRIBUTE'].includes(category),
          )
        ),
    )
  )
    return { status: 'unknown', createdAt }
  if (!row.status.includes('DISCOVERABLE')) return { status: 'unknown', createdAt }
  // DISCOVERABLE describes the ASIN, not whether this seller's offer is still open.
  // Seller Central closes listings by ending/removing the offer; issues can remain empty.
  // Only the exact Low-Cost Store (BZR) offer can authorize this inventory workflow.
  const offers = z
    .array(
      z.object({
        marketplace_id: z.string(),
        audience: z.string(),
        start_at: z.object({ value: z.string() }).optional(),
        end_at: z.object({ value: z.string() }).optional(),
      }),
    )
    .safeParse(parsed.data.attributes?.purchasable_offer)
  if (!offers.success || !Number.isFinite(now)) return { status: 'unknown', createdAt }
  if (!offers.data.length) return { status: 'closed', createdAt }
  const matches = offers.data.filter((o) => o.marketplace_id === sourceMarket && o.audience === 'BZR')
  if (matches.length !== 1) return { status: 'unknown', createdAt }
  const offer = matches[0]
  const from = offer.start_at ? Date.parse(offer.start_at.value) : null
  const through = offer.end_at ? Date.parse(offer.end_at.value) : null
  if ((from !== null && !Number.isFinite(from)) || (through !== null && !Number.isFinite(through)))
    return { status: 'unknown', createdAt }
  if (through !== null && through <= now) return { status: 'closed', createdAt }
  if (from !== null && (from > now || (through !== null && from >= through)))
    return { status: 'unknown', createdAt }
  return { status: row.status.includes('BUYABLE') ? 'active' : 'out_of_stock', createdAt }
}

/** Only exact, unique Low-Cost Store API rows are execution evidence. Marketplace totals are held. */
export function liveInventory(rows: Record<string, unknown>[], sku: string) {
  const matches = rows.filter((row) => row.sellerSku === sku)
  if (matches.length !== 1) throw conflict('实时库存返回缺失或重复 SKU，已阻止上传。')
  const parsed = z
    .object({
      sellerSku: z.literal(sku),
      stores: z.tuple([z.literal('Low-Cost Store')]),
      condition: z.literal('NewItem'),
      inventoryDetails: z.object({ fulfillableQuantity: z.number().int().nonnegative() }),
      lastUpdatedTime: z.string().optional(),
    })
    .safeParse(matches[0])
  if (!parsed.success)
    throw conflict('实时库存未明确属于唯一 Low-Cost Store / NewItem 范围，已阻止上传。')
  const timestamp = parsed.data.lastUpdatedTime ? Date.parse(parsed.data.lastUpdatedTime) : NaN
  return {
    sellable: parsed.data.inventoryDetails.fulfillableQuantity,
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
  }
}

export function amazonLiveReader(
  env: LiveEnvironment,
  request: typeof fetch = (input, init) => fetch(input, init),
): LiveReader {
  return async (identity, skus, now) => {
    const { credentials: c } = await sourceConnection(env, identity)
    const inventory = await new AmazonSourceClient(env, request, identity).inventory(skus)
    if (inventory.nextToken || inventory.rows.some((row) => !skus.includes(row.sellerSku)))
      throw conflict('实时库存范围或分页未确认。')
    if (!c.SP_CLIENT_ID || !c.SP_CLIENT_SECRET || !c.SP_REFRESH_TOKEN)
      throw conflict('Amazon 连接尚未完成。')
    const auth = await request('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: c.SP_CLIENT_ID,
        client_secret: c.SP_CLIENT_SECRET,
        refresh_token: c.SP_REFRESH_TOKEN,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
    if (!auth.ok) throw conflict('实时 Listing 授权读取失败。')
    const token = z.object({ access_token: z.string().min(1) }).parse(await auth.json()).access_token
    const observations: InventoryObservation[] = [],
      updatedAt: Record<string, number | null> = {},
      evidence: unknown[] = []
    for (const sku of skus) {
      const stock = liveInventory(inventory.rows, sku)
      const query = new URLSearchParams({
        marketplaceIds: sourceMarket,
        includedData: 'summaries,issues,attributes',
        issueLocale: 'en_US',
      })
      const response = await request(
        `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${encodeURIComponent(identity.seller)}/${encodeURIComponent(sku)}?${query}`,
        {
          headers: { 'x-amz-access-token': token },
          redirect: 'manual',
          signal: AbortSignal.timeout(20000),
        },
      )
      if (!response.ok) throw conflict('实时 Listing 状态读取失败，已阻止上传。')
      const raw = await response.json(),
        listing = liveListing(raw, sku, now)
      const qualification =
        await env.DB.prepare(`SELECT q.ordered_generation FROM inventory_source_qualifications q
        JOIN inventory_source_runs r ON r.id=q.ordered_generation AND r.state='COMPLETE' AND r.seller=q.seller
        WHERE q.seller=? AND q.sku=? UNION ALL SELECT q.evidence_run AS ordered_generation FROM inventory_order_history_qualifications q JOIN inventory_order_history_runs r ON r.id=q.evidence_run AND r.state='COMPLETE' AND r.seller=q.seller WHERE q.seller=? AND q.sku=? LIMIT 1`)
          .bind(identity.seller, sku, identity.seller, sku)
          .first<{ ordered_generation: string }>()
      observations.push({
        ...scopeFor(identity.seller),
        binCode: 'Default',
        inventoryType: 'GOOD',
        sku,
        sellable: stock.sellable,
        listingStatus: listing.status,
        createdAt: listing.createdAt,
        hasOrdered: qualification ? true : null,
        observedAt: now,
      })
      updatedAt[sku] = stock.updatedAt
      evidence.push({ sku, inventory: inventory.rows.filter((r) => r.sellerSku === sku), listing: raw })
    }
    await sourceConnection(env, identity)
    return { observations, updatedAt, evidence }
  }
}

/** Receipt classification never guesses a file-row offset. Unmapped partial errors lock all rows. */
export function liveOutcomes(job: Job, result: LiveReceipt) {
  const rows = job.rows.filter(
    (row) => row.quantity > 0 && !['SKIPPED', 'EXPIRED'].includes(row.outcome),
  )
  const errors = result.errors ?? []
  let mapped = new Map<string, string>()
  if (
    result.status === 'COMPLETED' &&
    result.errorCount !== null &&
    result.errorCount > 0 &&
    errors.length === result.errorCount &&
    errors.every((e) => e.sku && rows.filter((row) => row.sku === e.sku).length === 1) &&
    new Set(errors.map((e) => e.sku)).size === errors.length
  )
    mapped = new Map(errors.map((error) => [error.sku!, error.message]))
  return rows.map((row) => ({
    rowId: row.rowId,
    outcome:
      result.status === 'FAILED'
        ? ('FAILED' as const)
        : result.status === 'COMPLETED' && result.errorCount === 0 && errors.length === 0
          ? ('SUCCEEDED' as const)
          : mapped.size
            ? mapped.has(row.sku)
              ? ('FAILED' as const)
              : ('SUCCEEDED' as const)
            : ('UNKNOWN' as const),
    ...(mapped.has(row.sku)
      ? { error: mapped.get(row.sku)! }
      : result.status === 'FAILED'
        ? { error: '平台文件处理失败' }
        : {}),
  }))
}

export class InventoryLive {
  private readonly queue: ReplenishmentQueue
  private readonly reader: LiveReader
  constructor(
    private readonly env: LiveEnvironment,
    reader?: LiveReader,
  ) {
    this.queue = new ReplenishmentQueue(env.DB)
    this.reader = reader ?? amazonLiveReader(env)
  }
  private async active() {
    return this.env.DB.prepare(
      'SELECT * FROM inventory_live_trials WHERE ended_at IS NULL',
    ).first<Trial>()
  }
  private async identity(trial: Trial) {
    return (
      await sourceConnection(this.env, { seller: trial.seller, revision: trial.connection_revision })
    ).identity
  }
  private async read(trial: Trial, now: number, skus = JSON.parse(trial.skus_json) as string[]) {
    const identity = await this.identity(trial)
    const snapshot = await this.reader(identity, skus, now)
    const rows = z.array(observationSchema).parse(snapshot.observations)
    if (
      rows.length !== skus.length ||
      new Set(rows.map((r) => r.sku)).size !== rows.length ||
      rows.some(
        (r) =>
          !skus.includes(r.sku) ||
          scopeKey(r) !== scopeKey(scopeFor(trial.seller)) ||
          r.binCode !== 'Default' ||
          r.inventoryType !== 'GOOD' ||
          r.observedAt !== now,
      )
    )
      throw conflict('实时快照库存范围或读取时间不一致。')
    await this.identity(trial)
    if (this.env.ARCHIVE && snapshot.evidence)
      await this.env.ARCHIVE.put(
        `inventory-live/${trial.id}/snapshot-${now}-${crypto.randomUUID()}.json`,
        JSON.stringify(snapshot),
        { httpMetadata: { contentType: 'application/json' } },
      )
    await this.env.DB.prepare('UPDATE inventory_live_trials SET snapshot_json=?,updated_at=? WHERE id=?')
      .bind(JSON.stringify({ observations: rows, updatedAt: snapshot.updatedAt }), now, trial.id)
      .run()
    return { ...snapshot, observations: rows }
  }
  private view(job: Job) {
    return {
      id: job.id,
      leaseId: job.leaseId,
      mode: 'REAL_TRIAL' as const,
      state: job.state,
      rows: fileRows(job),
      rowStates: job.rows.map((r) => ({ sku: r.sku, outcome: r.outcome, active: r.active })),
      warehouseCode: 'A1C5' as const,
      expiresAt: job.lease_until,
      filename: job.filename,
      sha256: job.file_hash,
      needsReconciliation: job.submitted_at !== null,
    }
  }
  async status() {
    const seller = (
      await this.env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
        seller: string
      }>()
    )?.seller
    const trial = await this.env.DB.prepare(
      'SELECT * FROM inventory_live_trials WHERE seller=? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(seller ?? '')
      .first<Trial>()
    const jobs = trial
      ? (
          await this.env.DB.prepare(
            'SELECT job_id FROM inventory_live_jobs WHERE trial_id=? ORDER BY created_at DESC',
          )
            .bind(trial.id)
            .all<{ job_id: string }>()
        ).results
      : []
    return {
      mode: 'REAL_TRIAL',
      maxSkus: 2,
      automaticExecutionEnabled: false,
      trial: trial
        ? {
            id: trial.id,
            state: trial.state,
            skus: JSON.parse(trial.skus_json),
            createdAt: trial.created_at,
            endedAt: trial.ended_at,
            deviceId: trial.device_id,
            error: trial.error,
            snapshot: trial.snapshot_json ? JSON.parse(trial.snapshot_json) : null,
          }
        : null,
      jobs: await Promise.all(jobs.map(async (r) => this.view(await this.queue.job(r.job_id)))),
    }
  }
  async createTrial(actor: string, input: unknown, now = Date.now()) {
    time.parse(now)
    const { skus } = trialInput.parse(input)
    if (new Set(skus).size !== skus.length) throw conflict('小批量 SKU 不能重复。')
    if (await this.active()) throw conflict('已有未完成的小批量任务，请先处理回执或对账。')
    const { identity } = await sourceConnection(this.env)
    const baseline = await this.env.DB.prepare(
      'SELECT activated_at FROM inventory_source_settings WHERE singleton=1',
    ).first<{ activated_at: number | null }>()
    await this.queue.configure('admin', {
      enabledAt: baseline?.activated_at ?? now,
      intervalMinutes: 60,
    })
    const trialId = crypto.randomUUID()
    await this.env.DB.prepare(
      `INSERT INTO inventory_live_trials(id,seller,connection_revision,scope_json,skus_json,actor,created_at,state,updated_at) VALUES(?,?,?,?,?,?,?,'PREPARING',?)`,
    )
      .bind(
        trialId,
        identity.seller,
        identity.revision,
        JSON.stringify(scopeFor(identity.seller)),
        JSON.stringify(skus),
        actor,
        now,
        now,
      )
      .run()
    const trial = (await this.active())!
    try {
      const snapshot = await this.read(trial, now)
      const decisions = await Promise.all(snapshot.observations.map((row) => this.queue.decision(row)))
      if (decisions.some((decision) => decision.action !== 'receive'))
        throw conflict(
          '选择的 SKU 不符合补库条件：出单商品补到 5，未出单新品补到 2；禁售、未知状态或无资格商品不执行。',
        )
      const paused = await this.env.DB.prepare(
        'SELECT inventory_key FROM inventory_replenishment_demands WHERE paused=1 AND inventory_key IN (SELECT value FROM json_each(?))',
      )
        .bind(JSON.stringify(snapshot.observations.map(inventoryKey)))
        .first()
      if (paused) throw conflict('所选 SKU 已达到失败重试上限并暂停。')
      await this.queue.scan(
        'live-' + trial.id,
        snapshot.observations,
        { complete: true, source: 'live-amazon-api-trial' },
        now,
      )
      const ready = await this.env.DB.prepare(
        "UPDATE inventory_live_trials SET state='READY' WHERE id=? AND state='PREPARING' AND ended_at IS NULL RETURNING id",
      )
        .bind(trial.id)
        .first()
      if (!ready) throw conflict('初始化租约已失效，请重新创建小批量任务。')
      return this.status()
    } catch (error) {
      await this.env.DB.prepare(
        "UPDATE inventory_live_trials SET state='FAILED',error=?,ended_at=?,updated_at=? WHERE id=?",
      )
        .bind(error instanceof PublicError ? error.message : '实时数据读取失败', now, now, trial.id)
        .run()
      throw error
    }
  }
  private async owned(device: LiveDevice, input: unknown) {
    const data = command.parse(input)
    const trial = await this.env.DB.prepare(
      `SELECT t.* FROM inventory_live_trials t JOIN inventory_live_jobs j ON j.trial_id=t.id WHERE j.job_id=?`,
    )
      .bind(data.jobId)
      .first<Trial>()
    if (!trial || trial.device_id !== device.id || trial.scope_json !== device.scope_json)
      throw conflict('此任务不属于当前设备。')
    await this.identity(trial)
    const job = await this.queue.job(data.jobId)
    if (job.leaseId !== data.leaseId) throw conflict('任务租约不匹配。')
    return { trial, job }
  }
  async claim(device: LiveDevice, now = Date.now(), input: unknown = {}) {
    const request = z
      .object({ previousJobId: id.optional(), previousLeaseId: id.optional() })
      .strict()
      .refine((value) => !!value.previousJobId === !!value.previousLeaseId)
      .parse(input)
    const result = await this.claimCurrent(device, now)
    if (result.job) await this.owned(device, { jobId: result.job.id, leaseId: result.job.leaseId })
    const transferred = request.previousJobId
      ? await this.env.DB.prepare(`SELECT job_id,old_lease_id,new_device_id,submitted FROM inventory_device_transfers
        WHERE job_id=? AND old_lease_id=? AND old_device_id=? AND scope_json=?`)
          .bind(request.previousJobId, request.previousLeaseId!, device.id, device.scope_json)
          .first<{ job_id: string; old_lease_id: string; new_device_id: string; submitted: number }>()
      : null
    const previous = request.previousJobId
      ? await this.env.DB.prepare(`SELECT j.id,j.lease_id,j.state FROM inventory_replenishment_jobs j
      JOIN inventory_live_jobs l ON l.job_id=j.id JOIN inventory_live_trials t ON t.id=l.trial_id
      WHERE j.id=? AND j.lease_id=? AND j.state IN ('EXPIRED','SKIPPED') AND j.submitted_at IS NULL AND t.device_id=? AND t.scope_json=?`)
          .bind(request.previousJobId, request.previousLeaseId!, device.id, device.scope_json)
          .first<{ id: string; lease_id: string; state: 'EXPIRED' | 'SKIPPED' }>()
      : null
    // This is proof for replacing only a local pre-submission latch. Submitted/unknown work never qualifies.
    return {
      ...result,
      previousJob: transferred
        ? {
            id: transferred.job_id,
            leaseId: transferred.old_lease_id,
            state: 'TRANSFERRED' as const,
            submitted: transferred.submitted === 1,
            newDeviceId: transferred.new_device_id,
          }
        : previous
          ? {
              id: previous.id,
              leaseId: previous.lease_id,
              state: previous.state,
              submitted: false as const,
            }
          : null,
    }
  }
  private async claimCurrent(device: LiveDevice, now: number) {
    if ((await new InventoryExecutor(this.env.DB).status()).deviceId !== device.id) return { job: null }
    const trial = await this.active()
    if (!trial) return { job: null }
    if (trial.scope_json !== device.scope_json || (trial.device_id && trial.device_id !== device.id))
      return { job: null }
    await this.identity(trial)
    if (trial.state === 'WAITING_API') {
      // Device polling retries read-only reconciliation after API lag. Receipt locks stay intact on
      // errors or below-target readings; completing a trial never creates another replenishment job.
      const reconciled = await this.reconcile(now).catch(() => null)
      return { job: null, state: reconciled?.trial?.state ?? 'WAITING_API' }
    }
    if (trial.state === 'PREPARING') {
      if (now - trial.updated_at > 300000)
        await this.env.DB.prepare(
          "UPDATE inventory_live_trials SET state='FAILED',ended_at=?,error='初始化中断，请重新创建小批量任务。' WHERE id=? AND state='PREPARING' AND updated_at=?",
        )
          .bind(now, trial.id, trial.updated_at)
          .run()
      return { job: null, state: trial.state }
    }
    const previous = await this.env.DB.prepare(
      'SELECT job_id,created_at FROM inventory_live_jobs WHERE trial_id=? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(trial.id)
      .first<{ job_id: string; created_at: number }>()
    if (trial.state === 'CLAIMING') {
      // The queue and trial association commit together. Resume a lost response, never create a second job.
      if (!previous || previous.created_at < trial.updated_at) {
        if (now - trial.updated_at <= 120000) return { job: null, state: 'CLAIMING' }
        // Invalidate the token before reopening: a delayed old claimant cannot create an orphan job.
        const recovered = await this.env.DB.prepare(
          "UPDATE inventory_live_trials SET state='READY',claim_token=NULL WHERE id=? AND state='CLAIMING' AND claim_token IS ? AND updated_at=? RETURNING id",
        )
          .bind(trial.id, trial.claim_token, trial.updated_at)
          .first()
        if (!recovered) return { job: null }
      } else {
        await this.env.DB.prepare(
          "UPDATE inventory_live_trials SET state='ACTIVE' WHERE id=? AND state='CLAIMING' AND claim_token IS ?",
        )
          .bind(trial.id, trial.claim_token)
          .run()
      }
    }
    if (previous) {
      let job = await this.queue.job(previous.job_id)
      if (job.state === 'CLAIMED' && job.lease_until <= now) {
        await this.queue.recover(now)
        job = await this.queue.job(previous.job_id)
      }
      if (['CLAIMED', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'].includes(job.state))
        return { job: this.view(job) }
      if (
        job.rows.some((r) => r.outcome === 'SUCCEEDED' && r.active) &&
        !job.rows.some((r) => r.outcome === 'FAILED')
      )
        return { job: null, state: 'WAITING_API' }
    }
    const claimToken = crypto.randomUUID()
    const lock = await this.env.DB.prepare(
      `UPDATE inventory_live_trials SET device_id=COALESCE(device_id,?),state='CLAIMING',updated_at=?,claim_token=? WHERE id=? AND state NOT IN ('PREPARING','CLAIMING') AND ended_at IS NULL AND (device_id IS NULL OR device_id=?)
      AND EXISTS(SELECT 1 FROM inventory_executors e JOIN inventory_devices d ON d.id=e.device_id WHERE e.scope_json=inventory_live_trials.scope_json AND e.device_id=? AND d.revoked_at IS NULL) RETURNING id`,
    )
      .bind(device.id, now, claimToken, trial.id, device.id, device.id)
      .first()
    if (!lock) return { job: null }
    const authorizedKeys = (JSON.parse(trial.skus_json) as string[]).map((sku) =>
      inventoryKey({
        ...scopeFor(trial.seller),
        binCode: 'Default',
        inventoryType: 'GOOD',
        sku,
        sellable: null,
        listingStatus: 'unknown',
        hasOrdered: null,
        createdAt: null,
        observedAt: now,
      }),
    )
    // Queue keeps failed SKU retry timers and attempt counters across administrator trials.
    const job = await this.queue.claim(scopeKey(scopeFor(trial.seller)), now, 2, authorizedKeys, {
      id: trial.id,
      token: claimToken,
    })
    const finalized = await this.env.DB.prepare(
      "UPDATE inventory_live_trials SET state='ACTIVE',updated_at=? WHERE id=? AND state='CLAIMING' AND claim_token=? RETURNING id",
    )
      .bind(now, trial.id, claimToken)
      .first()
    if (!job && finalized) await this.refresh(trial.id, now)
    if (job) await this.owned(device, { jobId: job.id, leaseId: job.leaseId })
    return { job: job ? this.view(job) : null }
  }
  async prepare(device: LiveDevice, input: unknown, now = Date.now()) {
    const { trial, job } = await this.owned(device, input)
    if (job.state !== 'CLAIMED') return { job: this.view(job) }
    const snapshot = await this.read(
      trial,
      now,
      job.rows.filter((r) => r.outcome === 'PENDING').map((r) => r.sku),
    )
    const checked = await this.queue.preflight(job.id, job.leaseId, snapshot.observations, now)
    if (checked.state === 'SKIPPED') {
      await this.refresh(trial.id, now)
      return { job: this.view(checked) }
    }
    const rows = fileRows(checked),
      file = await receiveFile(rows)
    await this.identity(trial)
    const prepared = await this.queue.registerSubmission(
      job.id,
      job.leaseId,
      { preflightId: checked.preflight_id!, sha256: file.sha256, rows },
      now,
    )
    await this.owned(device, { jobId: job.id, leaseId: job.leaseId })
    return { job: { ...this.view(prepared), csv: file.csv, needsReconciliation: false } }
  }
  async heartbeat(device: LiveDevice, input: unknown, now = Date.now()) {
    const { job } = await this.owned(device, input)
    if (job.lease_until > now && ['CLAIMED', 'SUBMITTING', 'SUBMITTED'].includes(job.state))
      await this.queue.heartbeat(job.id, job.leaseId, now)
    return { job: this.view((await this.owned(device, input)).job) }
  }
  async dispatched(device: LiveDevice, input: unknown, _now = Date.now()) {
    const { job } = await this.owned(device, input)
    await this.queue.dispatched(job.id, job.leaseId)
    return { accepted: true, job: this.view((await this.owned(device, input)).job) }
  }
  async results(device: LiveDevice, input: unknown, now = Date.now()) {
    const result = receipt.parse(input)
    const { trial, job } = await this.owned(device, { jobId: result.jobId, leaseId: result.leaseId })
    if (
      !job.submitted_at ||
      result.filename !== job.filename ||
      result.sha256 !== job.file_hash ||
      result.evidence.observedAt < job.submitted_at ||
      result.evidence.observedAt > now + 60000
    )
      throw conflict('回执与登记文件、范围或提交时间不一致。')
    const payload = JSON.stringify(result),
      digest = await hash(payload)
    await this.env.DB.prepare(
      'INSERT INTO inventory_live_events(job_id,event_id,digest,payload_json,received_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id,event_id) DO NOTHING',
    )
      .bind(job.id, result.eventId, digest, payload, now)
      .run()
    const stored = await this.env.DB.prepare(
      'SELECT digest,applied FROM inventory_live_events WHERE job_id=? AND event_id=?',
    )
      .bind(job.id, result.eventId)
      .first<{ digest: string; applied: number }>()
    if (stored?.digest !== digest) throw conflict('同一回执事件不能修改内容。')
    if (stored.applied)
      return {
        accepted: true,
        replay: true,
        job: this.view((await this.owned(device, { jobId: result.jobId, leaseId: result.leaseId })).job),
      }
    const archiveKey = `inventory-live/${trial.id}/receipt-${await hash(job.id + '/' + result.eventId)}.json`
    if (this.env.ARCHIVE)
      await this.env.ARCHIVE.put(archiveKey, payload, {
        httpMetadata: { contentType: 'application/json' },
      })
    await this.queue.results(job.id, job.leaseId, result.eventId, liveOutcomes(job, result), now)
    await this.env.DB.prepare(
      'UPDATE inventory_live_events SET applied=1,archive_key=? WHERE job_id=? AND event_id=? AND digest=?',
    )
      .bind(this.env.ARCHIVE ? archiveKey : null, job.id, result.eventId, digest)
      .run()
    await this.refresh(trial.id, now)
    // Receipt acceptance survives an unavailable or lagging Amazon API; reconciliation can resume.
    await this.reconcile(now + 1).catch(() => {})
    return {
      accepted: true,
      job: this.view((await this.owned(device, { jobId: result.jobId, leaseId: result.leaseId })).job),
    }
  }
  private async refresh(trialId: string, now: number) {
    const rows = (
      await this.env.DB.prepare(
        `SELECT r.*,d.paused FROM inventory_live_jobs l JOIN inventory_replenishment_rows r ON r.job_id=l.job_id JOIN inventory_replenishment_demands d ON d.inventory_key=r.inventory_key WHERE l.trial_id=?`,
      )
        .bind(trialId)
        .all<{ outcome: string; active: number; paused: number; inventory_key: string }>()
    ).results
    if (!rows.length) return
    const active = rows.filter((r) => r.active)
    let state = 'ACTIVE',
      terminal = false
    if (active.some((r) => r.outcome === 'UNKNOWN')) state = 'UNKNOWN'
    else if (active.some((r) => r.outcome === 'PENDING')) state = 'ACTIVE'
    else {
      const fulfilled = new Set(
        rows.filter((r) => ['SUCCEEDED', 'SKIPPED'].includes(r.outcome)).map((r) => r.inventory_key),
      )
      const retry = rows.some(
        (r) => r.outcome === 'FAILED' && !r.paused && !fulfilled.has(r.inventory_key),
      )
      if (retry) state = 'RETRY_WAIT'
      else if (active.some((r) => r.outcome === 'SUCCEEDED')) state = 'WAITING_API'
      else {
        state = rows.some((r) => r.paused && !fulfilled.has(r.inventory_key))
          ? 'FAILED'
          : rows.some((r) => r.outcome === 'SUCCEEDED')
            ? 'COMPLETE'
            : 'SKIPPED'
        terminal = true
      }
    }
    await this.env.DB.prepare(
      'UPDATE inventory_live_trials SET state=?,ended_at=?,updated_at=? WHERE id=?',
    )
      .bind(state, terminal ? now : null, now, trialId)
      .run()
  }
  async reconcile(now = Date.now()) {
    const trial = await this.active()
    if (!trial) return this.status()
    if (['PREPARING', 'CLAIMING'].includes(trial.state)) return this.status()
    const snapshot = await this.read(trial, now)
    const jobs = (
      await this.env.DB.prepare('SELECT job_id FROM inventory_live_jobs WHERE trial_id=?')
        .bind(trial.id)
        .all<{ job_id: string }>()
    ).results
    for (const saved of jobs) {
      const job = await this.queue.job(saved.job_id)
      for (const row of job.rows.filter((r) => r.outcome === 'SUCCEEDED' && r.active)) {
        const reading = snapshot.observations.find((r) => inventoryKey(r) === inventoryKey(row))
        // Remain WAITING_API below target. A newer local fetch is not proof of inventory application.
        if (reading) await this.queue.reconcile(row.rowId, reading, now)
      }
    }
    await this.refresh(trial.id, now)
    return this.status()
  }
}
