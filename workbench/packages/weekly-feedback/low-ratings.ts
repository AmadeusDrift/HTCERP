import type { WorkflowStep } from 'cloudflare:workers'
import { z } from 'zod'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import type { OpsBindings } from '../operations/model'
import { listingProduct } from './model'
import { automaticFeedbackOwner, feedbackOwnerRules, isHaulListing } from './owner-rules'

const reviewMetric = z.object({ value: z.number().int().nonnegative().nullish() }).nullish()
const reviewCounts = z.object({ lowRatingReviewCount: reviewMetric, totalReviewCount: reviewMetric })
const reportRow = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  totals: z.object({ reviews: reviewCounts.nullish() }).nullish(),
  metrics: z
    .array(
      z.object({
        groupByKey: z.object({
          asin: z
            .string()
            .regex(/^[A-Z0-9]{10}$/)
            .nullish(),
        }),
        metrics: z.object({ reviews: reviewCounts.nullish() }).nullish(),
      }),
    )
    .nullish(),
})

export async function readLowRatings(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const days: { date: string; low: number | null; total: number | null }[] = []
  const hits: { date: string; asin: string; low: number; total: number | null }[] = []
  const parse = (line: string) => {
    if (!line.trim()) return
    const row = reportRow.parse(JSON.parse(line))
    if (row.startDate !== row.endDate) throw new Error('Amazon 未返回逐日评价统计。')
    const totals = row.totals?.reviews
    days.push({
      date: row.startDate,
      low: totals?.lowRatingReviewCount?.value ?? null,
      total: totals?.totalReviewCount?.value ?? null,
    })
    for (const metric of row.metrics ?? []) {
      const asin = metric.groupByKey.asin
      const reviews = metric.metrics?.reviews
      const low = reviews?.lowRatingReviewCount?.value
      if (asin && low && low > 0)
        hits.push({ date: row.startDate, asin, low, total: reviews?.totalReviewCount?.value ?? null })
    }
  }
  try {
    let pending = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      const lines = (pending + decoder.decode(chunk.value, { stream: true })).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) parse(line)
    }
    parse(pending + decoder.decode())
  } finally {
    await reader.cancel()
  }
  return { days, hits }
}

export async function collectWeeklyLowRatings(env: OpsBindings, step: WorkflowStep, week: string) {
  const date = (days: number) => new Date(Date.parse(week) - days * 86400000).toISOString().slice(0, 10)
  const run = { start: date(7), end: date(1) }
  const query = `query {
    analytics_sellerAnalytics_2025_03_31 {
      sellerAnalyticsView(startDate: "${run.start}", endDate: "${run.end}", aggregateBy: DAY, marketplaceId: ["ATVPDKIKX0DER"]) {
        startDate endDate
        totals { reviews { lowRatingReviewCount { value } totalReviewCount { value } } }
        metrics { groupByKey { asin } metrics { reviews { lowRatingReviewCount { value } totalReviewCount { value } } } }
      }
    }
  }`
  const amazon = async () =>
    new AmazonUS((await providerCredentials(env, 'amazon')).credentials, undefined, env.DB)
  const days = new Map<string, Awaited<ReturnType<typeof readLowRatings>>['days'][number]>()
  const hits = new Map<string, Awaited<ReturnType<typeof readLowRatings>>['hits'][number]>()
  let token: string | undefined
  for (let page = 0; ; page++) {
    const cursor = token
    const id = await step.do('submit-low-ratings-' + page, async () =>
      (await amazon()).submitDataKioskQuery(query, cursor),
    )
    let report: Awaited<ReturnType<AmazonUS['dataKioskQueryStatus']>> | undefined
    for (let poll = 0; poll < 40; poll++) {
      report = await step.do(`low-ratings-status-${page}-${poll}`, async () =>
        (await amazon()).dataKioskQueryStatus(id),
      )
      if (report.processingStatus === 'DONE') break
      if (report.processingStatus === 'FATAL' || report.processingStatus === 'CANCELLED')
        throw new Error('Amazon 未能生成评价统计，状态为 ' + report.processingStatus)
      await step.sleep(`wait-low-ratings-${page}-${poll}`, '30 seconds')
    }
    if (report?.processingStatus !== 'DONE') throw new Error('Amazon 评价统计尚未生成。')
    const documentId = report.dataDocumentId
    if (documentId) {
      const result = await step.do('read-low-ratings-' + page, async () =>
        readLowRatings(await (await amazon()).dataKioskDocument(documentId)),
      )
      for (const day of result.days) days.set(day.date, day)
      for (const hit of result.hits) hits.set(hit.date + ':' + hit.asin, hit)
    }
    token = report.pagination?.nextToken
    if (!token) break
    if (token === cursor) throw new Error('Amazon 评价统计返回重复分页标记。')
  }
  if (
    days.size !== 7 ||
    [...days.values()].some(
      (d) => d.date < run.start || d.date > run.end || d.low === null || d.total === null,
    )
  )
    throw new PublicError(
      'DATA_INCOMPLETE',
      'Amazon 还未返回完整的七天评价统计，请稍后重试。',
      502,
      'amazon',
    )
  const counts = new Map<string, number>()
  for (const hit of hits.values()) counts.set(hit.asin, (counts.get(hit.asin) ?? 0) + hit.low)
  const found = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return {
    ...run,
    reviewCount: [...days.values()].reduce((sum, d) => sum + (d.total ?? 0), 0),
    lowRatingCount: [...days.values()].reduce((sum, d) => sum + (d.low ?? 0), 0),
    found,
  }
}

export async function stageLowRatingListings(
  env: OpsBindings,
  step: WorkflowStep,
  runId: string,
  seller: string,
  priorRun: string | null,
  found: [string, number][],
) {
  for (let offset = 0; offset < found.length; offset += 20) {
    const candidates = found.slice(offset, offset + 20)
    const asins = candidates.map(([asin]) => asin)
    await step.do('low-rating-listings-' + offset, async () => {
      const api = new AmazonUS((await providerCredentials(env, 'amazon')).credentials, undefined, env.DB)
      const rows = new Map<string, ReturnType<typeof listingProduct> & { haul: boolean }>()
      const tokens = new Set<string>()
      let token: string | undefined
      do {
        const result = await api.feedbackListingsByAsin(seller, asins, token)
        for (const item of result.items) {
          const row = listingProduct(item)
          if (row.asin && asins.includes(row.asin))
            rows.set(row.sku, { ...row, haul: isHaulListing(item) })
        }
        token = result.pagination?.nextToken
        if (token && tokens.has(token)) throw new Error('Amazon 刊登查询返回重复分页标记。')
        if (token) tokens.add(token)
      } while (token)
      const previous = priorRun
        ? (
            await env.DB.prepare(
              "SELECT sku,asin,role FROM weekly_feedback_listings WHERE run=? AND asin IN (SELECT value FROM json_each(?)) AND role<>'unknown'",
            )
              .bind(priorRun, JSON.stringify(asins))
              .all<Pick<ReturnType<typeof listingProduct>, 'sku' | 'asin' | 'role'>>()
          ).results
        : []
      const roles = new Map(previous.map((row) => [row.sku, row]))
      const ownerRules = await feedbackOwnerRules(env.DB, seller)
      const matched = new Set<string>()
      const statements = []
      for (const row of rows.values()) {
        const old = roles.get(row.sku)
        const role = row.role === 'unknown' && old?.asin === row.asin ? old.role : row.role
        if (row.asin && (role === 'child' || role === 'standalone')) matched.add(row.asin)
        statements.push(
          env.DB.prepare(
            'INSERT INTO weekly_feedback_listings(run,sku,asin,title,image,role) VALUES(?,?,?,?,?,?) ON CONFLICT(run,sku) DO UPDATE SET asin=excluded.asin,title=excluded.title,image=excluded.image,role=excluded.role',
          ).bind(runId, row.sku, row.asin, row.title, row.image, role),
        )
        if (row.haul && (role === 'child' || role === 'standalone')) {
          const assignment = automaticFeedbackOwner(env.DB, seller, row.sku, ownerRules)
          if (assignment) statements.push(assignment)
        }
      }
      for (const [asin, lowRatingCount] of candidates) {
        if (matched.has(asin)) continue
        statements.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO weekly_feedback_items(run,asin,data,status,error) VALUES(?,?,?,'failed','有新增低星评价，但未匹配到已确认的子体或独立商品 SKU。')",
          ).bind(runId, asin, JSON.stringify({ asin, period: null, topics: [], lowRatingCount })),
        )
      }
      for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50))
    })
  }
}

export async function previewWeeklyLowRatings(env: OpsBindings, step: WorkflowStep, runId: string) {
  const week = await step.do('low-rating-report-period', async () => {
    const row = await env.DB.prepare(
      "SELECT week FROM weekly_feedback_runs WHERE id=? AND seller=(SELECT seller FROM title_audit_store WHERE singleton=1) AND marketplace='ATVPDKIKX0DER' AND status IN ('partial','done')",
    )
      .bind(runId)
      .first<{ week: string }>()
    if (!row) throw new Error('未找到已生成的美国站周报。')
    return row.week
  })
  const { found, ...run } = await collectWeeklyLowRatings(env, step, week)
  const amazon = async () =>
    new AmazonUS((await providerCredentials(env, 'amazon')).credentials, undefined, env.DB)
  let matched = 0,
    withTopics = 0,
    failed = 0
  const examples: { asin: string; sku: string; lowRatings: number; topics: string[] }[] = []
  const metrics = new Map<string, number>()
  for (let start = 0; start < found.length; start += 10) {
    const chunk = found.slice(start, start + 10)
    const result = await step.do('low-rating-topics-' + start, async () => {
      const api = await amazon()
      const outcomes: {
        asin: string
        sku: string
        lowRatings: number
        topics: string[]
        failed: boolean
      }[] = []
      for (const [asin, lowRatings] of chunk) {
        const listing = await env.DB.prepare(
          "SELECT sku FROM weekly_feedback_listings WHERE run=? AND asin=? AND role IN ('child','standalone') ORDER BY sku LIMIT 1",
        )
          .bind(runId, asin)
          .first<{ sku: string }>()
        if (!listing) continue
        try {
          const feedback = await api.reviewTopics(asin)
          outcomes.push({
            asin,
            sku: listing.sku,
            lowRatings,
            topics: feedback.topics.map((t) => t.name),
            failed: false,
          })
        } catch {
          outcomes.push({ asin, sku: listing.sku, lowRatings, topics: [], failed: true })
        }
      }
      return outcomes
    })
    matched += result.length
    for (const item of result) {
      if (item.failed) failed++
      if (!item.topics.length) continue
      withTopics++
      for (const topic of new Set(item.topics)) metrics.set(topic, (metrics.get(topic) ?? 0) + 1)
      if (examples.length < 8)
        examples.push({
          asin: item.asin,
          sku: item.sku,
          lowRatings: item.lowRatings,
          topics: item.topics.slice(0, 3),
        })
    }
  }
  return step.do('low-rating-week-summary', async () => ({
    ...run,
    lowRatingAsins: found.length,
    matched,
    withTopics,
    failed,
    examples,
    leadingTopics: [...metrics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }))
}
