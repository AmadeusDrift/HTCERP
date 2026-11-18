import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import type { OpsBindings } from '../operations/model'
import { fiveUnitNewListings } from './new-listing-targets'
import { ReplenishmentQueue } from './queue'
import { type InventoryObservation, inventoryKey } from './rules'
import { AmazonSourceClient, sourceChannel, sourceConnection, sourceMarket } from './source'

type Lane = 'stock' | 'orders'
type Change = { sku: string; sellable: number | null }
const overlap = 5 * 60_000
const maxWindow = 60 * 60_000
const lag = 3 * 60_000
const retry = { retries: { limit: 2, delay: '10 seconds' as const, backoff: 'exponential' as const } }

export function lowCostStockChanges(rows: Record<string, unknown>[], through: number): Change[] {
  const unique = new Map<string, number | null>()
  for (const row of rows) {
    const sku = row.sellerSku
    if (typeof sku !== 'string' || !sourceChannel(sku) || sku.trim() !== sku
      || sku.length > 512 || sku.includes(',') || !Array.isArray(row.stores)
      || row.stores.length !== 1 || row.stores[0] !== 'Low-Cost Store' || row.condition !== 'NewItem') continue
    const updated = Date.parse(String(row.lastUpdatedTime))
    if (!Number.isFinite(updated) || updated > through) continue
    const stock = (row.inventoryDetails as { fulfillableQuantity?: unknown } | null)?.fulfillableQuantity
    if (typeof stock !== 'number' || !Number.isSafeInteger(stock) || stock < 0) continue
    unique.set(sku, unique.has(sku) ? null : stock)
  }
  return [...unique].flatMap(([sku, sellable]) => sellable === null ? [] : [{ sku, sellable }])
}

export async function recordInventoryDelta(
  env: Pick<OpsBindings, 'DB'>,
  generation: string,
  seller: string,
  lane: Lane,
  observedAt: number,
  changes: Change[],
) {
  if (!changes.length) return 0
  const guard = `SELECT s.new_listings_enabled
    FROM inventory_source_current c JOIN inventory_source_runs run ON run.id=c.generation
    JOIN inventory_automatic_generations g ON g.generation=c.generation AND g.state='COMPLETE'
    JOIN inventory_automatic_settings s ON s.singleton=1 AND s.enabled=1
    WHERE c.seller=? AND c.generation=? AND run.state='COMPLETE' AND run.started_at>s.activated_after`
  const valid = await env.DB.prepare(guard).bind(seller, generation).first<{ new_listings_enabled: number }>()
  if (!valid) return 0
  const skuMap = new Map(changes.filter(({ sku }) => Boolean(sourceChannel(sku))).map(row => [row.sku, row]))
  const data = await env.DB.prepare(`SELECT p.value AS sku,r.listing_status,r.created_at,
      (q.ordered_generation IS NOT NULL OR r.ordered IS 1 OR e.ordered_scan_id IS NOT NULL
        OR history.id IS NOT NULL) AS ordered,
      (q.new_generation IS NOT NULL OR r.new_listing IS 1) AS new_listing,
      c.inventory_key IS NOT NULL AS queued
    FROM json_each(?) p
    LEFT JOIN inventory_source_rows r ON r.generation=? AND r.sku=p.value
    LEFT JOIN inventory_source_qualifications q ON q.seller=? AND q.sku=p.value
    LEFT JOIN inventory_replenishment_eligibility e ON e.sku_key=json_array(?,?,'A1C5',p.value)
    LEFT JOIN inventory_automatic_candidates c ON c.generation=?
      AND c.inventory_key=json_array(?,?,'A1C5','Default','GOOD',p.value)
    LEFT JOIN inventory_order_history_qualifications h ON h.seller=? AND h.sku=p.value
    LEFT JOIN inventory_order_history_runs history ON history.id=h.evidence_run AND history.seller=h.seller AND history.state='COMPLETE'`)
    .bind(JSON.stringify([...skuMap.keys()]), generation, seller, seller, sourceMarket,
      generation, seller, sourceMarket, seller)
    .all<{ sku: string; listing_status: InventoryObservation['listingStatus'] | null
      created_at: number | null; ordered: number; new_listing: number; queued: number }>()
  const rows: InventoryObservation[] = data.results
    .filter(r => lane === 'orders' ? !r.ordered || !r.queued : r.ordered || (valid.new_listings_enabled && r.new_listing))
    .map(r => ({
      sellerAccountId: seller, marketplaceId: sourceMarket, warehouseCode: 'A1C5',
      binCode: 'Default', inventoryType: 'GOOD', sku: r.sku,
      sellable: skuMap.get(r.sku)!.sellable, listingStatus: r.listing_status ?? 'unknown',
      createdAt: r.created_at, hasOrdered: lane === 'orders' || r.ordered ? true : null,
      observedAt,
    }))
  if (!rows.length) return 0
  const targets = valid.new_listings_enabled
    ? await fiveUnitNewListings(env.DB, seller, rows.filter(r => r.hasOrdered !== true).map(r => r.sku))
    : undefined
  const scanId = 'inventory-delta-' + crypto.randomUUID()
  await new ReplenishmentQueue(env.DB).scan(scanId, rows,
    { complete: true, kind: 'patrol', source: 'warehouse-delta-' + lane, fiveUnitNewListings: targets },
    observedAt)
  const keys = rows.filter(r => r.sellable === null || r.sellable < (r.hasOrdered || targets?.has(r.sku) ? 5 : 2))
    .map(inventoryKey)
  const saved = await env.DB.prepare(`INSERT INTO inventory_automatic_candidates
    SELECT ?,value FROM json_each(?) WHERE EXISTS(${guard})
    ON CONFLICT(generation,inventory_key) DO NOTHING`)
    .bind(generation, JSON.stringify(keys), seller, generation).run()
  return saved.meta.changes
}

async function baseline(env: Pick<OpsBindings, 'DB'>) {
  return env.DB.prepare(`SELECT r.id,r.seller,r.started_at,r.order_through,r.inventory_source_at
    FROM inventory_source_current c JOIN title_audit_store t ON t.seller=c.seller
    JOIN inventory_source_runs r ON r.id=c.generation AND r.state='COMPLETE'
    JOIN inventory_automatic_generations g ON g.generation=c.generation AND g.state='COMPLETE'
    JOIN inventory_automatic_settings s ON s.singleton=1 AND s.enabled=1
    WHERE r.started_at>s.activated_after`).first<{
    id: string; seller: string; started_at: number; order_through: number; inventory_source_at: string | null
  }>()
}

export async function scheduleInventoryDelta(env: OpsBindings, now: number) {
  const enabled = await env.DB.prepare('SELECT enabled FROM inventory_delta_settings WHERE singleton=1')
    .first<{ enabled: number }>()
  if (!enabled?.enabled || !(await baseline(env))) return
  for (const lane of ['orders', 'stock'] as const) {
    const id = 'inventory-delta-' + lane + '-' + Math.floor(now / overlap)
    await env.RUNNER.create({ id, params: { runId: id } }).catch(async (error) => {
      const existing = await env.RUNNER.get(id).then(instance => instance.status()).catch(() => null)
      if (!existing) throw error
    })
  }
}

export async function inventoryDeltaWorkflow(env: OpsBindings, id: string, step: WorkflowStep) {
  const match = /^inventory-delta-(stock|orders)-(\d+)$/.exec(id)
  if (!match) throw Error('SOURCE_DELTA_ID')
  const lane = match[1] as Lane
  const end = Number(match[2]) * overlap - lag
  const acquired = await step.do('inventory-delta-lock', retry, async () => {
    const base = await baseline(env)
    if (!base) return null
    const enabled = await env.DB.prepare('SELECT enabled FROM inventory_delta_settings WHERE singleton=1')
      .first<{ enabled: number }>()
    if (!enabled?.enabled) return null
    const { identity } = await sourceConnection(env)
    if (identity.seller !== base.seller) return null
    const inventoryTime = Date.parse(base.inventory_source_at ?? '')
    const initial = lane === 'orders' ? base.order_through : Number.isFinite(inventoryTime) ? inventoryTime : base.started_at
    const lease = await env.DB.prepare(`INSERT INTO inventory_delta_cursors
        (seller,revision,lane,watermark,lease_id,lease_until)
      SELECT ?,?,?,?,?,? WHERE ?<?
      ON CONFLICT(seller,revision,lane) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,
        watermark=MAX(inventory_delta_cursors.watermark,excluded.watermark)
      WHERE (inventory_delta_cursors.lease_until<=? OR inventory_delta_cursors.lease_id=excluded.lease_id)
        AND inventory_delta_cursors.watermark<? RETURNING watermark`)
      .bind(base.seller, identity.revision, lane, initial, id, Date.now() + 900_000, initial, end, Date.now(), end)
      .first<{ watermark: number }>()
    if (!lease) return null
    return { base, identity, from: lease.watermark - overlap, through: Math.min(lease.watermark + maxWindow, end) }
  })
  if (!acquired) return null
  const { base, identity, from, through } = acquired
  const key = [base.seller, identity.revision, lane, id]
  const stock = new AmazonSourceClient(env, undefined, identity)
  let next: string | null = null
  const tokens = new Set<string>()
  let matches = 0
  let queued = 0
  try {
    for (let index = 0; index < 1000; index++) {
      const token = next ?? undefined
      const page = await step.do('inventory-delta-page-' + index, retry, async () => {
        const { credentials } = await sourceConnection(env, identity)
        let changes: Change[], nextToken: string | null
        if (lane === 'stock') {
          const result = await stock.inventoryChanges(from, token)
          changes = lowCostStockChanges(result.rows, through)
          nextToken = result.nextToken
        } else {
          const api = new AmazonUS(credentials, undefined, env.DB)
          const result = await api.haulSalesPage(new Date(from).toISOString(), new Date(through).toISOString(), token)
          changes = result.orders.flatMap(order => order.items.flatMap(item =>
            item.sku && item.units > 0 ? [{ sku: item.sku, sellable: null }] : []))
          nextToken = result.nextToken
        }
        let added = 0
        for (let offset = 0; offset < changes.length; offset += 100)
          added += await recordInventoryDelta(env, base.id, base.seller, lane, through, changes.slice(offset, offset + 100))
        return { nextToken, matches: changes.length, added }
      })
      matches += page.matches
      queued += page.added
      next = page.nextToken
      if (!next) break
      if (tokens.has(next)) throw Error('SOURCE_DELTA_PAGINATION')
      tokens.add(next)
    }
    if (next || (await baseline(env))?.id !== base.id) throw Error('SOURCE_DELTA_INCOMPLETE')
    await step.do('inventory-delta-checkpoint', retry, async () => {
      await sourceConnection(env, identity)
      await env.DB.prepare(`UPDATE inventory_delta_cursors SET watermark=?,last_success_at=?,
        tracked_rows=tracked_rows+?,lease_until=0 WHERE seller=? AND revision=? AND lane=? AND lease_id=? AND watermark<?`)
        .bind(through, Date.now(), matches, ...key, through).run()
    })
    return { lane, matches, queued, through }
  } catch (error) {
    await env.DB.prepare(`UPDATE inventory_delta_cursors SET lease_until=0
      WHERE seller=? AND revision=? AND lane=? AND lease_id=?`).bind(...key).run()
    throw error
  }
}

export async function assessInventoryDelta(env: OpsBindings, step: WorkflowStep) {
  return step.do('verify-low-cost-stock-increment', async () => {
    const { identity } = await sourceConnection(env)
    const client = new AmazonSourceClient(env, undefined, identity)
    const now = Date.now()
    const items: Record<string, unknown>[] = []
    let next: string | undefined
    for (let page = 0; page < 5; page++) {
      const response = await client.inventoryChanges(now - 15 * 60_000, next)
      items.push(...response.rows)
      next = response.nextToken ?? undefined
      if (!next) break
    }
    return { scanned: items.length, lowCost: lowCostStockChanges(items, now).length, more: Boolean(next) }
  })
}

/** The regular full patrol remains the fallback until both streams have caught up. */
export async function hasFreshInventoryDeltas(env: Pick<OpsBindings, 'DB'>, now: number) {
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM inventory_delta_cursors d
    JOIN inventory_delta_settings s ON s.singleton=1 AND s.enabled=1 AND s.replace_frequent_full_scans=1
    JOIN inventory_automatic_settings a ON a.singleton=1 AND a.enabled=1 AND a.new_listings_enabled=0
    JOIN inventory_source_current c ON c.seller=d.seller
    JOIN inventory_source_runs r ON r.id=c.generation AND r.connection_revision=d.revision
    WHERE (d.lane='orders' OR d.tracked_rows>0) AND d.watermark>=? AND d.last_success_at>=?`)
    .bind(now - 20 * 60_000, now - 20 * 60_000).first<{ n: number }>()
  return recent?.n === 2
}
