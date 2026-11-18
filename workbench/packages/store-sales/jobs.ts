import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { drainGroupNotifications, enqueueDelivery } from '../group-notifications/delivery'
import { serviceGroup } from '../group-notifications/model'
import type { OpsBindings } from '../operations/model'
import { salesSkuOwners, salesTeamMembers } from './assignments'
import {
  aggregateDailySales,
  type DailySalesGroups,
  type DailySalesReport,
  dailySalesText,
  dailySalesWindow,
  type HaulSaleOrder,
  lastSalesDay,
  scheduledSalesWindow,
} from './daily'

export interface DailySalesRun {
  id: string
  report_date: string
  status: 'running' | 'ready' | 'failed'
  report_json: string | null
  error: string | null
  updated_at: string
}

type OrdersPage = Awaited<ReturnType<AmazonUS['haulSalesPage']>>

const scheduledSalesRunId = (cutoff: number, includeDaily: boolean) =>
  includeDaily ? 'daily-sales-auto-' + lastSalesDay(cutoff) : 'daily-sales-slot-' + cutoff

async function readCachedSalesTotals(
  db: D1Database, seller: string, window: { start: string; end: string }, includeDaily: boolean,
): Promise<Pick<DailySalesReport, 'haul' | 'jit'> | null> {
  const id = scheduledSalesRunId(Date.parse(window.end), includeDaily)
  const row = await db.prepare("SELECT report_json FROM daily_sales_runs WHERE id=? AND status='ready'")
    .bind(id).first<{ report_json: string | null }>()
  if (!row?.report_json) return null
  let snapshot: DailySalesReport | null
  try {
    snapshot = JSON.parse(row.report_json) as DailySalesReport | null
  } catch {
    return null
  }
  if (snapshot?.seller !== seller || snapshot.window?.start !== window.start || snapshot.window.end !== window.end ||
      snapshot.jimei?.includedInJit !== true || !Number.isSafeInteger(snapshot.haul?.units) ||
      !Number.isSafeInteger(snapshot.jit?.units) || snapshot.jit.units < 0 || snapshot.haul.units < snapshot.jit.units) return null
  return { haul: snapshot.haul, jit: snapshot.jit }
}

export async function scheduleDailySales(env: OpsBindings, tick: number) {
  const slot = scheduledSalesWindow(tick)
  if (!slot) return
  if (!(await serviceGroup(env.DB, 'daily-sales'))?.enabled) return
  const cutoff = Date.parse(slot.end)
  const id = scheduledSalesRunId(cutoff, slot.includeDaily)
  try {
    await env.RUNNER.create({ id, params: { runId: id, salesTick: cutoff } })
  } catch (error) {
    // A repeated cron event can already have claimed the same report date.
    const existing = await env.RUNNER.get(id).then((instance) => instance.status()).catch(() => null)
    if (!existing) throw error
  }
}

export async function dailySalesWorkflow(
  env: OpsBindings, step: WorkflowStep, id: string, date: string, send: boolean, tick?: number,
) {
  const db = env.DB
  const slot = tick === undefined ? null : scheduledSalesWindow(tick)
  if (tick !== undefined && !slot) throw new Error('Invalid daily sales slot')
  const { start, end } = slot ?? dailySalesWindow(date)
  const reportDate = slot ? start.slice(0, 10) : date
  let amazon: AmazonUS | undefined
  let report: DailySalesReport
  const amazonClient = async () => {
    amazon ??= new AmazonUS((await providerCredentials(env, 'amazon')).credentials, undefined, db)
    return amazon
  }
  const readOrders = async (from: string, through: string, stepPrefix: string) => {
    const orders: OrdersPage['orders'] = []
    const tokens = new Set<string>()
    let cursor: string | null = null
    for (let number = 1; ; number++) {
      const token: string | null = cursor
      const pageName = stepPrefix + number
      let page: OrdersPage
      for (let attempt = 0; ; attempt++) {
        const result: OrdersPage | { waitSeconds: number } = await step.do(
          attempt === 0 ? pageName : `${pageName}-quota-retry-${attempt}`,
          { retries: { limit: 4, delay: '3 minutes', backoff: 'exponential' } },
          async () => {
            try {
              return await (await amazonClient()).haulSalesPage(from, through, token ?? undefined)
            } catch (error) {
              if (!(error instanceof PublicError) || error.code !== 'SOURCE_THROTTLED') throw error
              return { waitSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60)) + 1 }
            }
          },
        )
        if (!('waitSeconds' in result)) {
          page = result
          break
        }
        await step.sleep(`${pageName}-quota-wait-${attempt}`, `${result.waitSeconds} seconds`)
      }
      orders.push(...page.orders)
      cursor = page.nextToken
      if (!cursor) break
      if (tokens.has(cursor)) {
        throw new PublicError('DATA_INCOMPLETE', 'Amazon 订单分页未能完整读完。', 502, 'amazon')
      }
      tokens.add(cursor)
    }
    return orders
  }
  try {
    const seller = await step.do('start-daily-sales', async () => {
      await db.prepare(`INSERT INTO daily_sales_runs(id,report_date,status,updated_at) VALUES(?,?,'running',?)
        ON CONFLICT(id) DO NOTHING`).bind(id, reportDate, new Date().toISOString()).run()
      const store = await db.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{ seller: string }>()
      if (!store) throw new PublicError('NOT_CONFIGURED', '请先保存美国站 Seller ID。', 409)
      return store.seller
    })
    if (slot) {
      // Orders search requires the cutoff to be at least two minutes old.
      const availableAt = Date.parse(end) + 130000
      if (availableAt > Date.now()) await step.sleepUntil('orders-cutoff-available', availableAt)
    }
    const orders = await readOrders(start, end, slot ? 'read-cumulative-orders-' : 'read-orders-page-')
    const previousTotals = slot ? await step.do('read-yesterday-sales-cache', () =>
      readCachedSalesTotals(db, seller, slot.previous, slot.includeDaily)) : null
    const previousYearUnits = slot ? await step.do('read-prior-year-sales', { retries: { limit: 2, delay: '15 seconds' } }, async () => {
      const currentStart = new Date(start)
      const priorStart = new Date(start)
      priorStart.setUTCFullYear(currentStart.getUTCFullYear() - 1)
      // A leap day has no exact calendar match in the previous year.
      if (priorStart.getUTCDate() !== currentStart.getUTCDate()) return null
      const duration = Date.parse(end) - currentStart.getTime()
      const from = priorStart.toISOString()
      const through = new Date(priorStart.getTime() + duration).toISOString()
      const baseline = await db.prepare(`SELECT quantity FROM daily_sales_year_baselines
        WHERE start_at=? AND end_at=? ORDER BY source LIMIT 1`).bind(from, through).first<{ quantity: number }>()
      if (baseline) return baseline.quantity
      const cached = await readCachedSalesTotals(db, seller, { start: from, end: through }, slot.includeDaily)
      return cached?.haul.units ?? null
    }).catch(() => null) : null
    report = await step.do(slot ? 'save-cumulative-sales' : 'save-daily-sales', async () => {
      const skus = [...new Set(orders.flatMap((order) => order.items.flatMap((line) => line.sku ? [line.sku] : [])))]
      const ownerOf = await salesSkuOwners(db, seller, skus)
      const { results } = await db.prepare('SELECT sku,team FROM daily_sales_sku_teams')
        .all<{ sku: string; team: keyof DailySalesGroups }>()
      const confirmed = new Map(results.map(({ sku, team }) => [sku, team]))
      const groups = await salesTeamMembers(db)
      const value = aggregateDailySales(reportDate, orders, ownerOf, groups, (sku) => confirmed.get(sku))
      if (slot) {
        value.window = { start, end }
        value.seller = seller
        value.previousUnits = previousTotals?.haul.units ?? null
        value.previousJitUnits = previousTotals?.jit.units ?? null
        value.previousYearUnits = previousYearUnits
      }
      await db.prepare(`UPDATE daily_sales_runs SET status='ready',report_json=?,error=NULL,updated_at=? WHERE id=?`)
        .bind(JSON.stringify(value), new Date().toISOString(), id).run()
      return value
    })
  } catch (error) {
    await step.do('record-daily-sales-failure', async () => {
      const message = error instanceof PublicError ? error.message : '订单同步失败，请检查 Amazon 连接或稍后重试。'
      await db.prepare(`UPDATE daily_sales_runs SET status='failed',error=?,updated_at=? WHERE id=?`)
        .bind(message, new Date().toISOString(), id).run()
    })
    throw error
  }
  if (send) {
    await step.do('send-daily-sales', async () => {
      const group = await serviceGroup(db, 'daily-sales')
      if (!group?.enabled) return
      const content = dailySalesText(report)
      await enqueueDelivery(db, { id, service: 'daily-sales', groupId: group.id, accountId: null, content }).run()
      await drainGroupNotifications(env, 'daily-sales')
    })
  }
  return report
}
