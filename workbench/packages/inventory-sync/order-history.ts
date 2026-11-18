import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import type { OpsBindings } from '../operations/model'
import { sourceChannel, sourceConnection, sourceErrorCode } from './source'

type HistoryRun = {
  id: string
  seller: string
  connection_revision: string | null
  window_from: number
  window_through: number
  state: string
  created_at: number
}
type HistoryDependencies = {
  orders: (start: string, end: string, token?: string) => ReturnType<AmazonUS['haulSalesPage']>
}
const day = 86400000
const retry = { retries: { limit: 4, delay: '30 seconds' as const, backoff: 'exponential' as const } }

/** Completed positive evidence only. A missing row never proves that a SKU never sold. */
export class InventoryOrderHistory {
  constructor(private readonly db: D1Database) {}
  async run(id: string) {
    const run = await this.db
      .prepare('SELECT * FROM inventory_order_history_runs WHERE id=?')
      .bind(id)
      .first<HistoryRun>()
    if (!run) throw new Error('SOURCE_HISTORY_MISSING')
    return run
  }
  async stage(id: string, skus: string[]) {
    const unique = [...new Set(skus.filter((sku) => sku.length <= 512 && sourceChannel(sku)))]
    for (let offset = 0; offset < unique.length; offset += 500)
      await this.db
        .prepare(`INSERT INTO inventory_order_history_staged(run_id,sku)
        SELECT ?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM inventory_order_history_runs WHERE id=? AND state='RUNNING')
        ON CONFLICT(run_id,sku) DO NOTHING`)
        .bind(id, JSON.stringify(unique.slice(offset, offset + 500)), id)
        .run()
  }
  async publish(id: string, pages: number, now: number) {
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO inventory_order_history_qualifications(seller,sku,evidence_run,observed_at)
        SELECT r.seller,s.sku,r.id,? FROM inventory_order_history_runs r JOIN inventory_order_history_staged s ON s.run_id=r.id
        WHERE r.id=? AND r.state='RUNNING' ON CONFLICT(seller,sku) DO NOTHING`)
        .bind(now, id),
      this.db
        .prepare(
          "UPDATE inventory_order_history_runs SET state='COMPLETE',pages=?,finished_at=? WHERE id=? AND state='RUNNING'",
        )
        .bind(pages, now, id),
    ])
  }
  async fail(id: string, error: unknown, now = Date.now()) {
    await this.db
      .prepare(
        "UPDATE inventory_order_history_runs SET state='FAILED',error=?,finished_at=? WHERE id=? AND state='RUNNING'",
      )
      .bind(sourceErrorCode(error), now, id)
      .run()
  }
}

/** One bounded older window at a time; ongoing hourly patrol owns recent orders. */
export async function launchInventoryOrderHistory(
  env: Pick<OpsBindings, 'DB' | 'RUNNER'>,
  enabled: boolean,
  now = Date.now(),
) {
  if (!enabled) return null
  const store = new InventoryOrderHistory(env.DB)
  const seller = (
    await env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
      seller: string
    }>()
  )?.seller
  const activation = (
    await env.DB.prepare('SELECT activated_at FROM inventory_source_settings WHERE singleton=1').first<{
      activated_at: number | null
    }>()
  )?.activated_at
  if (!seller || !activation) return null
  const running = await env.DB.prepare(
    "SELECT id FROM inventory_order_history_runs WHERE seller=? AND state='RUNNING'",
  )
    .bind(seller)
    .first<{ id: string }>()
  if (running) {
    const status = await env.RUNNER.get(running.id)
      .then((i) => i.status())
      .catch(() => null)
    if (status && ['errored', 'terminated', 'complete'].includes(status.status)) {
      await store.fail(running.id, new Error('SOURCE_HISTORY_INTERRUPTED'), now)
      return null
    }
    if (!status) await env.RUNNER.create({ id: running.id, params: { runId: running.id } })
    return running.id
  }
  const completed = await env.DB.prepare(
    "SELECT min(window_from) oldest FROM inventory_order_history_runs WHERE seller=? AND state='COMPLETE'",
  )
    .bind(seller)
    .first<{ oldest: number | null }>()
  const through = completed?.oldest ?? activation - 7 * day
  // Orders API v2026-01-01 exposes at most two years in the US marketplace.
  const earliestDate = new Date(now)
  earliestDate.setUTCFullYear(earliestDate.getUTCFullYear() - 2)
  const oldest = earliestDate.getTime()
  if (through <= oldest) return null
  const from = Math.max(oldest, through - 30 * day)
  const id = `inventory-history-${seller}-${Math.floor(from / 60000)}-${crypto.randomUUID()}`
  const inserted =
    await env.DB.prepare(`INSERT OR IGNORE INTO inventory_order_history_runs(id,seller,window_from,window_through,state,created_at)
    SELECT ?,?,?,?,'RUNNING',? WHERE NOT EXISTS(SELECT 1 FROM inventory_order_history_runs WHERE seller=? AND state='RUNNING')`)
      .bind(id, seller, from, through, now, seller)
      .run()
  if (!inserted.meta.changes) return null
  try {
    await env.RUNNER.create({ id, params: { runId: id } })
  } catch (error) {
    if (
      !(await env.RUNNER.get(id)
        .then((i) => i.status())
        .catch(() => null))
    )
      throw error
  }
  return id
}

export async function inventoryOrderHistoryWorkflow(
  env: OpsBindings,
  id: string,
  step: WorkflowStep,
  injected?: HistoryDependencies,
) {
  const store = new InventoryOrderHistory(env.DB)
  try {
    const run = await step.do('history-start', async () => {
      const saved = await store.run(id)
      if (saved.state !== 'RUNNING') throw new Error('SOURCE_HISTORY_NOT_RUNNING')
      const identity = injected ? null : (await sourceConnection(env)).identity
      if (identity && identity.seller !== saved.seller) throw new Error('SOURCE_CONNECTION_CHANGED')
      await env.DB.prepare('UPDATE inventory_order_history_runs SET connection_revision=? WHERE id=?')
        .bind(identity?.revision ?? null, id)
        .run()
      return { ...saved, identity }
    })
    let token: string | undefined
    const seen = new Set<string>()
    let pages = 0
    for (;;) {
      const cursor = token,
        pageNumber = pages
      const result: { nextToken: string | null } = await step.do(
        'history-page-' + pages,
        retry,
        async () => {
          const connection = injected ? null : await sourceConnection(env, run.identity!)
          const orders =
            injected?.orders ??
            ((start: string, end: string, next?: string) =>
              new AmazonUS(connection!.credentials, undefined, env.DB).haulSalesPage(start, end, next))
          const page = await orders(
            new Date(run.window_from).toISOString(),
            new Date(run.window_through).toISOString(),
            cursor,
          )
          const skus = [
            ...new Set(
              page.orders.flatMap((order) => {
                const created = Date.parse(order.createdTime)
                if (
                  !Number.isFinite(created) ||
                  created < run.window_from ||
                  created > run.window_through
                )
                  throw new Error('SOURCE_HISTORY_RANGE_MISMATCH')
                return order.items
                  .filter((item) => item.units > 0 && item.sku && sourceChannel(item.sku))
                  .map((item) => item.sku!)
              }),
            ),
          ]
          if (run.identity) await sourceConnection(env, run.identity)
          await env.ARCHIVE.put(
            `inventory-history/${id}/page-${pageNumber}.json`,
            JSON.stringify({ skus, from: run.window_from, through: run.window_through }),
          )
          await store.stage(id, skus)
          return { nextToken: page.nextToken }
        },
      )
      pages++
      if (!result.nextToken) break
      if (seen.has(result.nextToken) || pages >= 5000)
        throw new Error('SOURCE_ORDER_PAGINATION_INCOMPLETE')
      seen.add(result.nextToken)
      token = result.nextToken
    }
    await step.do('history-publish', retry, async () => {
      if (run.identity) await sourceConnection(env, run.identity)
      await store.publish(id, pages, Date.now())
    })
    return { runId: id, state: 'COMPLETE', pages }
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowInternalError') throw error
    await step.do('history-failed', () => store.fail(id, error))
    throw new Error(sourceErrorCode(error))
  }
}
