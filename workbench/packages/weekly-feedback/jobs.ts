import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { drainGroupNotifications, queueWeeklyGroup } from '../group-notifications/delivery'
import type { OpsBindings } from '../operations/model'
import { collectWeeklyLowRatings, stageLowRatingListings } from './low-ratings'
import { feedbackWeek, listingProduct, marketplace, mergeTopics, safeImage } from './model'
import { weeklyProductNames } from './product-names'
import { sendWeeklyNotifications } from './wecom'

const genericFailure = '差评主题读取失败，请重试或检查连接。'
const message = (error: unknown) => (error instanceof PublicError ? error.message : genericFailure)

export async function probeWeeklyReviewCounts(
  env: OpsBindings,
  step: WorkflowStep,
  existingQueryId?: string,
) {
  const query = `query {
    analytics_sellerAnalytics_2025_03_31 {
      sellerAnalyticsView(startDate: "2026-11-06", endDate: "2026-11-06", aggregateBy: DAY, marketplaceId: ["ATVPDKIKX0DER"]) {
        startDate endDate
        totals { reviews { lowRatingReviewCount { value } totalReviewCount { value } } }
        metrics { groupByKey { asin } metrics { reviews { lowRatingReviewCount { value } totalReviewCount { value } } } }
      }
    }
  }`
  const amazon = async () => new AmazonUS((await providerCredentials(env, 'amazon')).credentials)
  const id =
    existingQueryId ??
    (await step.do('submit-review-count-probe', async () =>
      (await amazon()).submitDataKioskQuery(query),
    ))
  for (let poll = 0; poll < 20; poll++) {
    const status = await step.do('review-count-status-' + poll, async () =>
      (await amazon()).dataKioskQueryStatus(id),
    )
    if (status.processingStatus === 'IN_QUEUE' || status.processingStatus === 'IN_PROGRESS') {
      await step.sleep('wait-review-counts-' + poll, '20 seconds')
      continue
    }
    const document = status.errorDocumentId ?? status.dataDocumentId
    if (!document) return { status: status.processingStatus, document: 'none' }
    return step.do('review-count-document-sample', async () => {
      const reader = (await (await amazon()).dataKioskDocument(document))
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let sample = ''
      try {
        while (sample.length < 16000 && sample.split('\n').length < 4) {
          const chunk = await reader.read()
          if (chunk.done) break
          sample += chunk.value.slice(0, 16000 - sample.length)
        }
      } finally {
        await reader.cancel()
      }
      return {
        status: status.processingStatus,
        error: !!status.errorDocumentId,
        sample: sample.slice(0, 2500),
      }
    })
  }
  throw new Error('Amazon Data Kiosk 查询仍在处理中。')
}
export async function launchWeeklyFeedback(
  env: Pick<OpsBindings, 'DB' | 'RUNNER'>,
  seller: string,
  scheduledTime?: number,
) {
  const now = scheduledTime ?? Date.now()
  const week = feedbackWeek(now)
  const id =
    'weekly-feedback-' + (scheduledTime === undefined ? crypto.randomUUID() : seller + '-' + week)
  await env.DB.prepare(
    "UPDATE weekly_feedback_runs SET status='failed',finished=?,error='汇总超时，可手动重新生成。' WHERE status='running' AND started<?",
  )
    .bind(new Date().toISOString(), new Date(Date.now() - 7 * 86400000).toISOString())
    .run()
  const added = await env.DB.prepare(
    "INSERT OR IGNORE INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES(?,?,?,?,?,'running')",
  )
    .bind(id, seller, marketplace, week, new Date(now).toISOString())
    .run()
  if (!added.meta.changes) {
    const existing = await env.DB.prepare(
      "SELECT id FROM weekly_feedback_runs WHERE id=? OR (seller=? AND marketplace=? AND status='running') ORDER BY started DESC LIMIT 1",
    )
      .bind(id, seller, marketplace)
      .first<{ id: string }>()
    return { id: existing?.id ?? id, created: false }
  }
  try {
    const params = { runId: id, filterLowRatings: scheduledTime !== undefined }
    await env.RUNNER.create({ id, params })
  } catch {
    await env.DB.prepare(
      "UPDATE weekly_feedback_runs SET status='failed',finished=?,error='工作流启动失败，请手动重试。' WHERE id=?",
    )
      .bind(new Date().toISOString(), id)
      .run()
    throw new PublicError('SOURCE_UNAVAILABLE', '周报工作流启动失败，请重试。', 503)
  }
  return { id, created: true }
}

export async function scheduleWeeklyFeedback(env: OpsBindings, scheduledTime: number) {
  const beijing = new Date(scheduledTime + 8 * 3600000)
  if (beijing.getUTCDay() !== 3 || beijing.getUTCHours() !== 9 || beijing.getUTCMinutes() !== 0) return
  const settings = await env.DB.prepare(
    'SELECT enabled FROM weekly_feedback_settings WHERE singleton=1',
  ).first<{ enabled: number }>()
  if (!settings?.enabled) return
  const store = await env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
    seller: string
  }>()
  if (store) await launchWeeklyFeedback(env, store.seller, scheduledTime)
}

export async function weeklyFeedbackWorkflow(
  env: OpsBindings,
  id: string,
  step: WorkflowStep,
  repair = false,
  resolveListings = false,
  filterLowRatings = false,
) {
  try {
    const run = await step.do('weekly-feedback-store', async () => {
      const row = await env.DB.prepare(
        resolveListings
          ? "SELECT seller,started,reported,incomplete FROM weekly_feedback_runs WHERE id=? AND status='partial'"
          : repair
            ? "SELECT seller,started,reported,incomplete FROM weekly_feedback_runs r WHERE id=? AND (status='partial' OR (status='failed' AND error=?)) AND EXISTS(SELECT 1 FROM weekly_feedback_items WHERE run=r.id) AND NOT EXISTS(SELECT 1 FROM weekly_feedback_listings l WHERE l.run=r.id AND l.role IN ('child','standalone') AND l.asin IS NOT NULL AND NOT EXISTS(SELECT 1 FROM weekly_feedback_items i WHERE i.run=r.id AND i.asin=l.asin))"
            : "SELECT seller,started,reported,incomplete,week FROM weekly_feedback_runs WHERE id=? AND status='running'",
      )
        .bind(...(repair && !resolveListings ? [id, genericFailure] : [id]))
        .first<{
          seller: string
          started: string
          reported: number
          incomplete: number
          week?: string
        }>()
      if (!row) throw new Error(repair ? '周报尚未完成已识别 ASIN 的扫描。' : '周报未启动')
      const prior = repair
        ? null
        : await env.DB.prepare(
            "SELECT id FROM weekly_feedback_runs WHERE seller=? AND marketplace=? AND started<? AND status IN ('done','partial') ORDER BY started DESC,id DESC LIMIT 1",
          )
            .bind(row.seller, marketplace, row.started)
            .first<{ id: string }>()
      return { ...row, priorRun: prior?.id ?? null }
    })
    const filtered = filterLowRatings && !repair
    const lowRatings = filtered ? await collectWeeklyLowRatings(env, step, run.week!) : null
    const lowByAsin = new Map(lowRatings?.found)
    if (lowRatings)
      await stageLowRatingListings(env, step, id, run.seller, run.priorRun, lowRatings.found)
    const ranges = repair || filtered ? [] : [[Date.UTC(1994, 0), Date.parse(run.started), 0]]
    let sequence = 0,
      reported = repair ? run.reported : 0,
      incomplete = repair ? run.incomplete : 0
    while (ranges.length) {
      const [start, end, retry] = ranges.pop()!
      let cursor: string | undefined,
        seen = 0,
        expected = 0
      const tokens = new Set<string>()
      do {
        const token = cursor
        const page: { count: number; size: number; next: string | null } = await step.do(
          'weekly-listings-' + sequence++,
          { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
          async () => {
            const { credentials } = await providerCredentials(env, 'amazon')
            const result = await new AmazonUS(credentials, undefined, env.DB).feedbackListings(
              run.seller,
              start,
              end,
              token,
            )
            if (result.numberOfResults <= 1000 && result.items.length) {
              const rows = result.items.map(listingProduct)
              const unresolved = rows.filter((row) => row.role === 'unknown' && row.asin)
              const cached =
                run.priorRun && unresolved.length
                  ? (
                      await env.DB.prepare(
                        "SELECT sku,asin,role FROM weekly_feedback_listings WHERE run=? AND sku IN (SELECT value FROM json_each(?)) AND role<>'unknown'",
                      )
                        .bind(run.priorRun, JSON.stringify(unresolved.map((row) => row.sku)))
                        .all<Pick<(typeof rows)[number], 'sku' | 'asin' | 'role'>>()
                    ).results
                  : []
              const cachedBySku = new Map(cached.map((row) => [row.sku, row]))
              await env.DB.batch(
                rows.map((row) => {
                  const old = cachedBySku.get(row.sku)
                  const role =
                    row.role === 'unknown' && old && old.asin === row.asin ? old.role : row.role
                  return env.DB.prepare(
                    'INSERT INTO weekly_feedback_listings(run,sku,asin,title,image,role) VALUES(?,?,?,?,?,?) ON CONFLICT(run,sku) DO UPDATE SET asin=excluded.asin,title=excluded.title,image=excluded.image,role=excluded.role',
                  ).bind(id, row.sku, row.asin, row.title, row.image, role)
                }),
              )
            }
            return {
              count: result.numberOfResults,
              size: result.items.length,
              next: result.pagination?.nextToken ?? null,
            }
          },
        )
        if (sequence === 1) reported = page.count
        expected = Math.max(expected, page.count)
        if (page.count > 1000) {
          if (end - start < 4) {
            incomplete++
            break
          }
          const mid = Math.floor((start + end) / 2)
          // Overlap boundaries; SKU primary keys remove duplicates without dropping boundary listings.
          ranges.push([mid - 1, end, retry], [start, mid + 1, retry])
          break
        }
        seen += page.size
        if (
          (page.next && (tokens.has(page.next) || page.next === token || !page.size || seen >= 1000)) ||
          (!page.next && seen < expected)
        ) {
          if (!retry && end - start >= 4) {
            const mid = Math.floor((start + end) / 2)
            ranges.push([mid - 1, end, 1], [start, mid + 1, 1])
          } else incomplete++
          break
        }
        if (page.next) tokens.add(page.next)
        cursor = page.next ?? undefined
      } while (cursor)
    }
    if (!repair && !filtered)
      await step.do('weekly-listing-coverage', async () => {
        await env.DB.prepare('UPDATE weekly_feedback_runs SET reported=?,incomplete=? WHERE id=?')
          .bind(reported, incomplete, id)
          .run()
      })

    if (!filtered && (resolveListings || run.priorRun)) {
      let afterSku = ''
      for (let page = 0; ; page++) {
        const nextSku: string | null = await step.do(
          'weekly-resolve-listings-' + page,
          { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
          async () => {
            const { results } = await env.DB.prepare(
              run.priorRun
                ? "SELECT l.sku,l.asin FROM weekly_feedback_listings l WHERE l.run=? AND l.role='unknown' AND l.sku>? AND NOT EXISTS(SELECT 1 FROM weekly_feedback_listings previous WHERE previous.run=? AND previous.sku=l.sku AND previous.asin IS l.asin) ORDER BY l.sku LIMIT 20"
                : "SELECT sku,asin FROM weekly_feedback_listings WHERE run=? AND role='unknown' AND sku>? ORDER BY sku LIMIT 20",
            )
              .bind(...(run.priorRun ? [id, afterSku, run.priorRun] : [id, afterSku]))
              .all<{ sku: string; asin: string | null }>()
            if (!results.length) return null
            const { credentials } = await providerCredentials(env, 'amazon')
            const api = new AmazonUS(credentials, undefined, env.DB)
            const response = await api.feedbackListingsBySku(
              run.seller,
              results.map((row) => row.sku),
            )
            const bySku = new Map(response.items.map((item) => [item.sku, listingProduct(item)]))
            const updates = results.flatMap(({ sku, asin }) => {
              const confirmed = bySku.get(sku)
              if (!confirmed?.asin || (asin && confirmed.asin !== asin) || confirmed.role === 'unknown')
                return []
              return [
                env.DB.prepare(
                  "UPDATE weekly_feedback_listings SET role=?,asin=COALESCE(asin,?),image=COALESCE(image,?) WHERE run=? AND sku=? AND role='unknown'",
                ).bind(confirmed.role, confirmed.asin, confirmed.image, id, sku),
              ]
            })
            if (updates.length) await env.DB.batch(updates)
            return results.at(-1)!.sku
          },
        )
        if (!nextSku) break
        afterSku = nextSku
      }
    }

    // Read a small keyset in each step; no full-store payload is retained in Workflow memory.
    let after = ''
    for (;;) {
      const asins = await step.do('weekly-asin-page-' + after, async () => {
        const result = await env.DB.prepare(
          resolveListings
            ? "SELECT DISTINCT l.asin FROM weekly_feedback_listings l WHERE l.run=? AND l.role IN ('child','standalone') AND l.asin>? AND NOT EXISTS(SELECT 1 FROM weekly_feedback_items i WHERE i.run=l.run AND i.asin=l.asin AND i.status<>'failed') ORDER BY l.asin LIMIT 20"
            : repair
              ? "SELECT asin FROM weekly_feedback_items WHERE run=? AND status='failed' AND asin>? ORDER BY asin LIMIT 20"
              : "SELECT DISTINCT asin FROM weekly_feedback_listings WHERE run=? AND role IN ('child','standalone') AND asin>? ORDER BY asin LIMIT 20",
        )
          .bind(id, after)
          .all<{ asin: string }>()
        return result.results.map((row) => row.asin)
      })
      if (!asins.length) break
      await step.do(
        'weekly-feedback-batch-' + asins[0],
        { retries: { limit: 2, delay: '10 seconds' }, timeout: '10 minutes' },
        async (ctx) => {
          const { credentials } = await providerCredentials(env, 'amazon')
          const api = new AmazonUS(credentials, undefined, env.DB)
          for (const asin of asins) {
            const existing = await env.DB.prepare(
              'SELECT status FROM weekly_feedback_items WHERE run=? AND asin=?',
            )
              .bind(id, asin)
              .first<{ status: string }>()
            if (existing && (!repair || existing.status !== 'failed')) continue
            try {
              const mentions = await api.reviewTopics(asin, 'MENTIONS')
              const impact = mentions.topics.length
                ? await api.reviewTopics(asin, 'STAR_RATING_IMPACT')
                : mentions
              const samePeriod =
                mentions.period?.startDate === impact.period?.startDate &&
                mentions.period?.endDate === impact.period?.endDate
              const data = {
                ...mentions,
                topics: mergeTopics(mentions.topics, samePeriod ? impact.topics : []),
                ...(filtered ? { lowRatingCount: lowByAsin.get(asin) } : {}),
              }
              await env.DB.prepare(
                "INSERT INTO weekly_feedback_items(run,asin,data,status) VALUES(?,?,?,?) ON CONFLICT(run,asin) DO UPDATE SET data=excluded.data,status=excluded.status,error=NULL WHERE weekly_feedback_items.status='failed'",
              )
                .bind(id, asin, JSON.stringify(data), data.topics.length ? 'available' : 'no_data')
                .run()
            } catch (error) {
              if ((!(error instanceof PublicError) || error.retryable) && ctx.attempt < 3) throw error
              await env.DB.prepare(
                "INSERT OR IGNORE INTO weekly_feedback_items(run,asin,status,error,data) VALUES(?,?,'failed',?,?)",
              )
                .bind(
                  id,
                  asin,
                  message(error),
                  filtered
                    ? JSON.stringify({
                        asin,
                        period: null,
                        topics: [],
                        lowRatingCount: lowByAsin.get(asin),
                      })
                    : null,
                )
                .run()
              if (
                error instanceof PublicError &&
                ['FEEDBACK_FORBIDDEN', 'SOURCE_AUTH', 'NOT_CONFIGURED'].includes(error.code)
              )
                throw error
            }
          }
          const missing = await env.DB.prepare(
            'SELECT i.asin FROM weekly_feedback_items i WHERE i.run=? AND i.asin IN (SELECT value FROM json_each(?)) AND i.image IS NULL AND i.image_error IS NULL AND NOT EXISTS(SELECT 1 FROM weekly_feedback_listings l WHERE l.run=i.run AND l.asin=i.asin AND l.image IS NOT NULL)',
          )
            .bind(id, JSON.stringify(asins))
            .all<{ asin: string }>()
          if (missing.results.length) {
            let images: { asin: string; url: string }[] = [],
              imageError = ''
            try {
              images = await api.mainImages(missing.results.map((row) => row.asin))
            } catch {
              imageError = '商品主图补充失败。'
            }
            await env.DB.batch(
              missing.results.map(({ asin }) => {
                const image = safeImage(images.find((row) => row.asin === asin)?.url)
                return env.DB.prepare(
                  'UPDATE weekly_feedback_items SET image=?,image_error=? WHERE run=? AND asin=?',
                ).bind(image, image ? null : imageError || 'Amazon 未返回可用主图。', id, asin)
              }),
            )
          }
        },
      )
      after = asins.at(-1)!
    }
    await step.do('weekly-feedback-publish', async () => {
      const counts = await env.DB.prepare(
        "SELECT (SELECT count(*) FROM weekly_feedback_listings WHERE run=?) scanned,(SELECT count(*) FROM weekly_feedback_listings WHERE run=? AND (role='unknown' OR asin IS NULL)) unresolved,(SELECT count(*) FROM weekly_feedback_items WHERE run=? AND status='failed') failed",
      )
        .bind(id, id, id)
        .first<{ scanned: number; unresolved: number; failed: number }>()
      const partial =
        counts!.unresolved > 0 ||
        counts!.failed > 0 ||
        (!filtered && (incomplete > 0 || counts!.scanned !== reported))
      const warning = partial
        ? filtered
          ? `已筛出 ${lowByAsin.size} 个有新增低星评价的 ASIN，其中 ${counts!.failed} 个未能完成差评主题读取。${counts!.unresolved ? `另有 ${counts!.unresolved} 个 SKU 的关系待确认。` : ''}`
          : `Amazon 起始报告 ${reported} 个刊登，已读取 ${counts!.scanned} 个 SKU；${incomplete} 个时间窗未核齐，${counts!.unresolved} 个刊登的 ASIN 或父子关系待确认，${counts!.failed} 个 ASIN 的差评主题读取失败。`
        : null
      // A resumed Workflow can reach this checkpoint after an earlier invocation recorded a failure.
      await env.DB.prepare(
        "UPDATE weekly_feedback_runs SET status=?,error=?,finished=? WHERE id=? AND (status='running' OR (status='failed' AND error=?) OR (status='partial' AND ?))",
      )
        .bind(
          partial ? 'partial' : 'done',
          warning,
          new Date().toISOString(),
          id,
          genericFailure,
          Number(repair),
        )
        .run()
    })
    if (repair) return
    await step.do(
      'weekly-wecom-notifications',
      { retries: { limit: 0, delay: '1 second' } },
      async () => {
        if (await queueWeeklyGroup(env.DB, id, weeklyProductNames(env, true))) {
          await drainGroupNotifications(env, 'feedback')
          return
        }
        const settings = await env.DB.prepare(
          'SELECT notify_enabled FROM weekly_feedback_settings WHERE singleton=1',
        ).first<{ notify_enabled: number }>()
        if (settings?.notify_enabled) await sendWeeklyNotifications(env, id)
      },
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowInternalError') throw error
    await env.DB.prepare(
      "UPDATE weekly_feedback_runs SET status='failed',finished=?,error=? WHERE id=? AND status='running'",
    )
      .bind(new Date().toISOString(), message(error), id)
      .run()
    throw new Error('商品差评周报生成失败，请查看 ERP 中的执行记录。')
  }
}
