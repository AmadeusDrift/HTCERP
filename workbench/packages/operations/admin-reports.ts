import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import type { AmazonComparison } from '../amazon/auto-compare'
import { reportComparisons } from '../amazon/research-links'
import { normalizeHistory, normalizeProduct } from '../catalog/facts'
import { ingestGeekbi } from '../catalog/ingest'
import { PublicError } from '../contracts/errors'
import { readTrackingDetail } from './geekbi-direct'
import { businessClock, parse } from './model'
import { parseDetail } from './providers'

export interface ReportProduct {
  id: string
  title: string
  thumbnail?: string
  weeks?: number[]
  price: number | null
  sold: number | null
  daily: number | null
  snapshotAt: string | null
  selectionBasis: string
  reason: string
  today: number | null
  yesterday: number | null
  detailAt: string | null
  todayAt: string | null
  yesterdayAt: string | null
  researchId: string | null
  amazonEligible?: boolean
  amazonComparison?: AmazonComparison
  amazonPriceScreen?: { candidates: { asin: string; price: number | null }[] }
  aiReading?: { route: string; reason?: string; next?: string }
  evidence: string
}
export interface AdminReport {
  expansion?: {
    day:string; seeds:number; hits:number; unique:number; priced:number; low:number; middle:number
    shortlist:{asin:string;title:string;price:number;shipping:number|null}[]
  }
  exclusions?: { reason: string; n: number }[]
  kind: 'selection' | 'tracking'
  day: string
  previousDay: string
  createdAt: string
  actor: string
  runId: string
  examined: number
  matched: number
  items: ReportProduct[]
  points: number
  pendingPoints: number
  aiMicros: number
  pendingMicros: number
  scope: string
}
type SourceRow = Pick<
  ReportProduct,
  'id' | 'title' | 'price' | 'sold' | 'daily' | 'snapshotAt' | 'researchId' | 'evidence'
>
type Settings = { platform: string; maxPrice: number | null; keyword: string; tiers: number[] }
const emptyDays = { today: null, yesterday: null, todayAt: null, yesterdayAt: null, detailAt: null }
const reportDay = (ts: string) => businessClock(Date.parse(ts)).slice(0, 10)
const eligibleRun = `SELECT j.id,j.created_at,plan.result_json AS plan
  FROM job_runs j JOIN job_steps plan ON plan.run_id=j.id AND plan.step_key='plan'
  WHERE j.kind='discovery' AND j.status IN ('succeeded','partial') AND json_extract(j.inputs_json,'$.mode')='live'
  AND json_extract(plan.result_json,'$.settings.platform') IN ('temu','amazon')
  AND EXISTS(SELECT 1 FROM job_steps s WHERE s.run_id=j.id AND s.step_key GLOB 'search-[0-9]*' AND s.status='succeeded')
  AND NOT EXISTS(SELECT 1 FROM job_seen h JOIN job_runs r ON r.id=h.child_id WHERE h.run_id=j.id
    AND r.status NOT IN ('succeeded','partial','failed','cancelled'))`
const dayStart = (day: string) => new Date(day + 'T00:00:00+08:00').toISOString()
const reportCols = `COALESCE(SUM(CASE WHEN unit='points' THEN actual END),0) AS points,
  COALESCE(SUM(CASE WHEN unit='points' AND actual IS NULL THEN reserved END),0) AS pendingPoints,
  COALESCE(SUM(CASE WHEN unit='micros' THEN actual END),0) AS aiMicros,
  COALESCE(SUM(CASE WHEN unit='micros' AND actual IS NULL THEN reserved END),0) AS pendingMicros`
type Cost = Pick<AdminReport, 'points' | 'pendingPoints' | 'aiMicros' | 'pendingMicros'>
export const adminReportRoutes = new Hono<AppEnv>()
adminReportRoutes.use('/admin-reports', async (c, next) => {
  if (c.var.actor.role !== 'admin')
    throw new PublicError('FORBIDDEN', '只有管理员可以查看和生成这两份日报。', 403)
  await next()
})
adminReportRoutes.get('/admin-reports', async (c) => {
  const db = c.env.DB
  const [saved, latest] = await Promise.all([
    db
      .prepare('SELECT report_json FROM admin_daily_reports ORDER BY day DESC,rowid DESC LIMIT 60')
      .all<{ report_json: string }>(),
    db
      .prepare(eligibleRun + ' AND j.created_at>=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1')
      .bind(dayStart(businessClock().slice(0, 10)))
      .first<{ id: string }>(),
  ])
  const reports = saved.results.map((r) => JSON.parse(r.report_json) as AdminReport)
  const byRun = new Map<string, ReportProduct[]>()
  for (const report of reports) {
    for (const item of report.items) {
      if (!item.researchId) continue
      const group = byRun.get(item.researchId)
      if (group) group.push(item)
      else byRun.set(item.researchId, [item])
    }
  }
  // Later Amazon checks are dated supplements to the saved source snapshot.
  for (const row of await reportComparisons(db, [...byRun.keys()])) {
    const products: string[] = row.decisionProducts ? JSON.parse(row.decisionProducts) : []
    for (const item of byRun.get(row.id) ?? []) {
      if (row.target !== item.id && !products.includes(item.id)) continue
      if (row.choice) {
        const terra = row.terra && row.target === item.id ? JSON.parse(row.terra) : null
        item.aiReading = { route: row.choice, reason: terra?.selection?.reason, next: terra?.nextActions?.[0] }
      }
      item.amazonEligible = ['succeeded', 'partial'].includes(row.status)
      if (row.product_id === item.id && row.result_json) item.amazonComparison = JSON.parse(row.result_json)
    }
  }
  return c.json({
    reports,
    latestRun: latest?.id ?? null,
  })
})
adminReportRoutes.post('/admin-reports', async (c) => {
  const { runId } = parse(z.object({ runId: z.uuid() }), await c.req.json()),
    db = c.env.DB
  const prior = await db.prepare('SELECT kind FROM admin_daily_reports WHERE run_id=?').bind(runId).all()
  if (prior.results.length === 2) return c.json({ runId })
  const run = await db
    .prepare(eligibleRun + ' AND j.id=?')
    .bind(runId)
    .first<{ id: string; created_at: string; plan: string }>()
  if (!run) throw new PublicError('NOT_READY', '请先完成一次美国站在线发现任务和关联研究。', 409)
  const day = reportDay(run.created_at),
    previousDay = businessClock(Date.parse(run.created_at) - 86400000).slice(0, 10)
  if (day !== businessClock().slice(0, 10))
    throw new PublicError('INVALID_DATE', '请选择今天完成的调查，以便核对今天与昨天的数据。', 409)
  const { settings, categoryIds } = JSON.parse(run.plan) as { settings: Settings; categoryIds: string[] }
  const hits = await db
    .prepare(`SELECT q.product_id AS id, q.total_sold AS sold,q.child_id AS researchId,q.evidence_ref AS evidence,
    COALESCE(NULLIF(json_extract(s.snapshot_json,'$.title_cn'),''),json_extract(s.snapshot_json,'$.title'),q.product_id) AS title,
    json_extract(s.snapshot_json,'$.min_price') AS price,json_extract(s.snapshot_json,'$.day_sold') AS daily,
    json_extract(s.snapshot_json,'$.updated_at') AS snapshotAt, d.summary AS decision,
    CASE WHEN json_array_length(t.result_json,'$.products')=1 AND json_extract(t.result_json,'$.products[0]')=q.product_id
      THEN json_extract(t.result_json,'$.selection.reason') END AS reasonText
    FROM job_seen q LEFT JOIN product_snapshots s ON s.product_id=q.product_id AND s.evidence_ref=q.evidence_ref
    LEFT JOIN job_steps d ON d.run_id=q.child_id AND d.step_key='decision' AND d.status='succeeded'
    LEFT JOIN job_steps t ON t.run_id=q.child_id AND t.step_key='terra' AND t.status='succeeded'
    WHERE q.run_id=? AND q.tier IS NOT NULL ORDER BY q.tier DESC, daily DESC,q.total_sold DESC,id`)
    .bind(runId)
    .all<SourceRow & { decision: string | null; reasonText: string | null }>()
  const counts = await db
    .prepare('SELECT COUNT(*) n,COUNT(tier) matched FROM job_seen WHERE run_id=?')
    .bind(runId)
    .first<{ n: number; matched: number }>()
  const selected: ReportProduct[] = hits.results.map(({ decision, reasonText, ...row }) => ({
    ...row,
    ...emptyDays,
    selectionBasis: '本轮在线检索达标',
    reason:
      reasonText ||
      decision ||
      (row.snapshotAt && reportDay(row.snapshotAt) < previousDay
        ? '销售记录更新较早，先复查近期销量。'
        : '符合价格和累计销量条件，尚待单品研究。'),
  }))
  const exclusions = await db.prepare(`SELECT exclusion_reason reason,COUNT(*) n FROM job_seen WHERE run_id=?
    AND tier IS NULL AND exclusion_reason IS NOT NULL GROUP BY exclusion_reason ORDER BY n DESC`).bind(runId).all<{reason:string;n:number}>()
  const byProduct = new Map(selected.map(p => [p.id,p]))
  const thumbnails = await db.prepare(`SELECT q.product_id id,json_extract(s.snapshot_json,'$.thumbnail') thumbnail
    FROM job_seen q JOIN product_snapshots s ON s.product_id=q.product_id AND s.evidence_ref=q.evidence_ref WHERE q.run_id=? AND q.tier IS NOT NULL`).bind(runId).all<{id:string;thumbnail:string}>()
  for (const row of thumbnails.results) { const p=byProduct.get(row.id); if(p && row.thumbnail) p.thumbnail=row.thumbnail }
  const until = Date.parse(dayStart(day))+86400000
  const dailyRows = await db.prepare(`WITH ranked AS (SELECT o.product_id id,date(o.observed_at,'+8 hours') d,o.day_sold v,
    row_number() OVER(PARTITION BY o.product_id,date(o.observed_at,'+8 hours') ORDER BY o.observed_at DESC) rn
    FROM observations o JOIN job_seen q ON q.product_id=o.product_id AND q.run_id=? AND q.tier IS NOT NULL
    WHERE o.day_sold>=0 AND o.observed_at>=? AND o.observed_at<?)
    SELECT id,d,v FROM ranked WHERE rn=1`).bind(runId,new Date(until-28*86400000).toISOString(),new Date(until).toISOString()).all<{id:string;d:string;v:number}>()
  const weeks = new Map<string,{sum:number;days:number}[]>()
  for(const row of dailyRows.results){
    const buckets=weeks.get(row.id) ?? Array.from({length:4},()=>({sum:0,days:0}))
    const index=Math.floor((Date.parse(dayStart(row.d))-(until-28*86400000))/(7*86400000))
    buckets[index].sum+=row.v; buckets[index].days++; weeks.set(row.id,buckets)
  }
  for(const [id,buckets] of weeks){
    const complete=buckets.every(b=>b.days===7)?buckets:buckets.slice(2)
    if(complete.every(b=>b.days===7)) byProduct.get(id)!.weeks=complete.map(b=>b.sum)
  }
  if (settings.platform === 'amazon') {
    const quotes = await db.prepare(`SELECT q.value AS quote FROM job_steps s, json_each(s.result_json,'$.quotes') q
      WHERE s.run_id=? AND s.step_key GLOB 'search-[0-9]*' AND s.status='succeeded' ORDER BY s.updated_at`)
      .bind(runId).all<{ quote: string }>()
    const byAsin = new Map(quotes.results.map(row => {
      const q = JSON.parse(row.quote) as { asin: string; price: number | null; tier: string }
      return [q.asin, q] as const
    }))
    for (const item of selected) {
      const quote = byAsin.get(item.id.split(':')[2])
      if (quote) item.amazonPriceScreen = { candidates: [quote] }
      item.reason += quote?.price != null ? ' 官方核价 $' + quote.price.toFixed(2) + '，' + quote.tier + '。' : ' 官方报价待核。'
    }
  }
  // When search results are stale, use comparable products with a recent observed history.
  // Keep the alternate source visible on each row and do not add it to the selection count.
  const toTrack = selected
    .filter((r) => r.snapshotAt && reportDay(r.snapshotAt) >= previousDay)
    .slice(0, 2)
  if (toTrack.length < 2 && settings.platform === 'temu') {
    const candidates = await db
      .prepare(`SELECT p.id,COALESCE(NULLIF(p.title_cn,''),p.title) AS title,p.min_price AS price,
      p.total_sold AS sold,p.day_sold AS daily,p.updated_at AS snapshotAt,p.evidence_ref AS evidence,NULL AS researchId
      FROM products p WHERE p.platform='temu' AND p.market='US' AND p.updated_at>=?
      AND (? IS NULL OR p.min_price<=?) AND p.total_sold>=?
      AND (?='[]' OR p.category_id IN (SELECT value FROM json_each(?)))
      AND (?='' OR instr(lower(p.title||' '||COALESCE(p.title_cn,'')),lower(?))>0)
      AND EXISTS(SELECT 1 FROM observations o WHERE o.product_id=p.id AND o.observed_at>=? AND o.observed_at<? AND o.day_sold IS NOT NULL)
      ORDER BY p.day_sold DESC,p.id LIMIT 4`)
      .bind(
        dayStart(day),
        settings.maxPrice,
        settings.maxPrice,
        Math.min(...settings.tiers),
        JSON.stringify(categoryIds),
        JSON.stringify(categoryIds),
        settings.keyword,
        settings.keyword,
        dayStart(previousDay),
        dayStart(day),
      )
      .all<SourceRow>()
    for (const r of candidates.results) {
      if (toTrack.length === 2) break
      if (!toTrack.some((t) => t.id === r.id))
        toTrack.push({ ...r, ...emptyDays, selectionBasis: '同范围商品库 · 已有昨日观测', reason: '' })
    }
  }
  for (const r of selected) {
    if (toTrack.length === 2) break
    if (!toTrack.some((t) => t.id === r.id)) toTrack.push(r)
  }
  const tracked: ReportProduct[] = []
  const prefix = 'admin-report/' + runId + '/'
  for (const item of toTrack) {
    if (settings.platform === 'amazon') {
      const rows = await db.prepare(`SELECT observed_at,day_sold FROM observations
        WHERE product_id=? AND observed_at>=? AND observed_at<? AND day_sold IS NOT NULL ORDER BY observed_at DESC`)
        .bind(item.id, dayStart(previousDay), new Date(Date.parse(dayStart(day))+86400000).toISOString())
        .all<{ observed_at: string; day_sold: number }>()
      const today = rows.results.find(o => reportDay(o.observed_at) === day)
      const yesterday = rows.results.find(o => reportDay(o.observed_at) === previousDay)
      tracked.push({ ...item, today: today?.day_sold ?? null, todayAt: today?.observed_at ?? null,
        yesterday: yesterday?.day_sold ?? null, yesterdayAt: yesterday?.observed_at ?? null,
        reason: today && yesterday ? '按极鲸云两日观测比较。' : '两日销量观测尚未齐全。' })
      continue
    }
    const goodsId = item.id.split(':')[2],
      operation = prefix + goodsId
    const response = await readTrackingDetail(c.env, operation, goodsId),
      detail = parseDetail(response.body, goodsId)
    const receipt = await db
      .prepare('SELECT step_key FROM usage_reservations WHERE direct_key=? ORDER BY rowid DESC LIMIT 1')
      .bind(operation)
      .first<{ step_key: string }>()
    const evidenceRef = 'geekbi/direct/' + receipt!.step_key + '.json'
    const origin = {
      platform: 'temu' as const,
      market: 'US' as const,
      fetchedAt: response.fetchedAt,
      evidenceRef,
      source: 'geekbi',
    }
    const product = normalizeProduct(detail.goods, origin)
    await ingestGeekbi(db, {
      ...origin,
      rows: [detail.goods],
      history: detail.history ?? [],
      detail: true,
    })
    const obs = (detail.history ?? []).flatMap((r) => {
      const h = normalizeHistory(r, item.id, origin)
      return h ? [{ at: h.observed_at, v: h.day_sold }] : []
    })
    if (product.updated_at) obs.push({ at: product.updated_at, v: product.day_sold })
    obs.sort((a, b) => b.at.localeCompare(a.at))
    const curr = obs.find((o) => o.v !== null && reportDay(o.at) === day),
      prev = obs.find((o) => o.v !== null && reportDay(o.at) === previousDay)
    const delta = curr?.v != null && prev?.v != null ? curr.v - prev.v : null
    tracked.push({
      ...item,
      price: product.min_price,
      sold: product.total_sold,
      daily: product.day_sold,
      snapshotAt: product.updated_at,
      today: curr?.v ?? null,
      yesterday: prev?.v ?? null,
      todayAt: curr?.at ?? null,
      yesterdayAt: prev?.at ?? null,
      detailAt: response.fetchedAt,
      evidence: evidenceRef,
      reason:
        delta === null
          ? '详情缺少其中一天的日销量，暂不能判断变化。'
          : delta > 0
            ? '日销量上升，下一次复查能否延续。'
            : delta < 0
              ? '日销量下降，继续观察后续两天，再决定是否跟进。'
              : '两天日销量相同，继续观察。',
    })
  }
  const costs = await db
    .prepare(
      'SELECT ' +
        reportCols +
        ' FROM usage_reservations WHERE run_id=? OR run_id IN (SELECT id FROM job_runs WHERE parent_id=?)',
    )
    .bind(runId, runId)
    .first<Cost>()
  const followCosts = await db
    .prepare('SELECT ' + reportCols + ' FROM usage_reservations WHERE direct_key GLOB ?')
    .bind(prefix + '*')
    .first<Cost>()
  const base = {
    day,
    previousDay,
    runId,
    actor: c.var.actor.username,
    createdAt: new Date().toISOString(),
    examined: counts!.n,
    matched: counts!.matched,
    scope: [
      settings.platform === 'amazon' ? 'Amazon 美国站' : 'Temu 美国站',
      categoryIds.length ? '类目 ' + categoryIds.join('、') : '全部类目',
      settings.maxPrice === null ? '不限价格' : '最低展示价不超过 $' + settings.maxPrice,
      '累计销量至少 ' + Math.min(...settings.tiers) + ' 件',
      settings.keyword,
    ]
      .filter(Boolean)
      .join(' · '),
  }
  const reports: AdminReport[] = [
    { ...base, ...costs!, kind: 'selection', items: selected, exclusions:exclusions.results },
    { ...base, ...followCosts!, kind: 'tracking', items: tracked },
  ]
  await db.batch(
    reports.map((r) =>
      db
        .prepare(
          'INSERT INTO admin_daily_reports(run_id,kind,day,report_json) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(runId, r.kind, r.day, JSON.stringify(r)),
    ),
  )
  return c.json({ runId })
})
