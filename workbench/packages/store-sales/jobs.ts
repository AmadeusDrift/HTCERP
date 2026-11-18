import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { drainGroupNotifications, enqueueDelivery } from '../group-notifications/delivery'
import { serviceGroup } from '../group-notifications/model'
import type { OpsBindings } from '../operations/model'
import { marketplace } from '../weekly-feedback/model'
import { feedbackOwnerRules, matchFeedbackOwner } from '../weekly-feedback/owner-rules'
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

export async function salesTeamMembers(db: D1Database) {
  const { results } = await db.prepare(`SELECT t.team,t.account_id FROM daily_sales_team_members t
    JOIN accounts a ON a.id=t.account_id WHERE a.active=1 AND a.role IN ('operator','admin')`)
    .all<{ team: keyof DailySalesGroups; account_id: string }>()
  const groups: DailySalesGroups = { a: [], b: [], c: [] }
  for (const row of results) groups[row.team].push(row.account_id)
  return groups
}

export async function scheduleDailySales(env: OpsBindings, tick: number) {
  const slot = scheduledSalesWindow(tick)
  if (!slot) return
  if (!(await serviceGroup(env.DB, 'daily-sales'))?.enabled) return
  const cutoff = Date.parse(slot.end)
  const id = slot.includeDaily ? 'daily-sales-auto-' + lastSalesDay(cutoff) : 'daily-sales-slot-' + cutoff
  try {
    await env.RUNNER.create({ id, params: { runId: id, salesTick: cutoff } })
  } catch (error) {
    // A repeated cron event can already have claimed the same report date.
    const existing = await env.RUNNER.get(id).then((instance) => instance.status()).catch(() => null)
    if (!existing) throw error
  }
}

async function orderOwners(db: D1Database, seller: string, orders: HaulSaleOrder[]) {
  const skus = [...new Set(orders.flatMap((order) => order.items.flatMap((line) => line.sku ? [line.sku] : [])))]
  const rules = await feedbackOwnerRules(db, seller)
  const assignments = new Map<string, { id: string; source: string }>()
  for (let offset = 0; offset < skus.length; offset += 80) {
    const batch = skus.slice(offset, offset + 80)
    const { results } = await db.prepare(`SELECT o.sku,a.id,o.source FROM weekly_feedback_owners o JOIN accounts a ON a.id=o.account_id
      WHERE o.seller=? AND o.marketplace=? AND a.active=1 AND a.role IN ('operator','admin')
      AND o.sku IN (${batch.map(() => '?').join(',')})`)
      .bind(seller, marketplace, ...batch).all<{ sku: string; id: string; source: string }>()
    for (const row of results) assignments.set(row.sku, row)
  }
  return (sku: string) => {
    const saved = assignments.get(sku)
    return saved?.source === 'manual'
      ? saved.id
      : matchFeedbackOwner(sku, rules)?.account_id ?? saved?.id ?? null
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
  const readOrders = async (from: string, through: string, stepPrefix: string) => {
    const orders: OrdersPage['orders'] = []
    const tokens = new Set<string>()
    let cursor: string | null = null
    for (let number = 1; ; number++) {
      const token: string | null = cursor
      const page: OrdersPage = await step.do(
        stepPrefix + number,
        { retries: { limit: 4, delay: '3 minutes', backoff: 'exponential' } },
        async (): Promise<OrdersPage> => {
          amazon ??= new AmazonUS((await providerCredentials(env, 'amazon')).credentials)
          return amazon.haulSalesPage(from, through, token ?? undefined)
        },
      )
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
    let previousTotals: Pick<DailySalesReport, 'haul' | 'jit'> | undefined
    if (slot) {
      const previous = await readOrders(slot.previous.start, slot.previous.end, 'read-yesterday-orders-')
      previousTotals = aggregateDailySales(reportDate, previous, () => null, { a: [], b: [], c: [] })
    }
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

      amazon ??= new AmazonUS((await providerCredentials(env, 'amazon')).credentials)
      const metrics = await amazon.partnerSales(from, through)
      const [metricStart, metricEnd] = metrics.interval.split('--').map(Date.parse)
      if (metricStart !== priorStart.getTime() || metricEnd !== Date.parse(through)) return null
      await db.prepare(`INSERT INTO daily_sales_year_baselines
        (sale_date,hours,source,source_ref,quantity,start_at,end_at,imported_at)
        VALUES (?,?,'amazon-sales-sp-api',?,?,?,?,?) ON CONFLICT(sale_date,hours,source) DO NOTHING`)
        .bind(from.slice(0, 10), duration / 3600000, metrics.interval, metrics.unitCount, from, through, new Date().toISOString()).run()
      return metrics.unitCount
    }).catch(() => null) : null
    report = await step.do(slot ? 'save-cumulative-sales' : 'save-daily-sales', async () => {
      const ownerOf = await orderOwners(db, seller, orders)
      const { results } = await db.prepare('SELECT sku,team FROM daily_sales_sku_teams')
        .all<{ sku: string; team: keyof DailySalesGroups }>()
      const confirmed = new Map(results.map(({ sku, team }) => [sku, team]))
      const groups = await salesTeamMembers(db)
      const value = aggregateDailySales(reportDate, orders, ownerOf, groups, (sku) => confirmed.get(sku))
      if (previousTotals) {
        value.window = { start, end }
        value.previousUnits = previousTotals.haul.units
        value.previousJitUnits = previousTotals.jit.units
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
