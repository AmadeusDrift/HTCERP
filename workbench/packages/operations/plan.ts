import {
  bad,
  type JobInput,
  type JobRow,
  promptVersion,
  type Settings,
  type StepResult,
  selectionPromptVersion,
  usage,
} from './model'
import { potentialProducts } from './potential'

export async function categoryIds(db: D1Database, settings: Settings) {
  if (settings.categoryId !== 'home') return settings.categoryId ? [settings.categoryId] : []
  const rows = await db
    .prepare(
      'SELECT category_id FROM category_mappings WHERE group_key=? AND platform=? ORDER BY category_id',
    )
    .bind('home', settings.platform)
    .all<{ category_id: string }>()
  if (!rows.results.length) throw bad('所选平台的家居类目尚未映射')
  return rows.results.map((r) => r.category_id)
}
export function tierFor(sold: number | null, tiers: number[]) {
  return sold === null ? null : (tiers.find((t) => sold >= t) ?? null)
}
export const snapshotFields =
  'id,title,platform,market,min_price,currency,total_sold,total_sold_field,day_sold,week_sold,month_sold,category_name,updated_at,fetched_at,evidence_ref'
function pinnedVariants(raw: unknown) {
  const rows = JSON.parse(String(raw ?? '[]')) as {
    sku_id: string
    specs: { specKey: string; specValue: string }[]
  }[]
  return rows.slice(0, 3).map((sku) => ({
    skuId: sku.sku_id.slice(0, 64),
    specs: sku.specs
      .slice(0, 4)
      .map((spec) => ({ key: spec.specKey.slice(0, 60), value: spec.specValue.slice(0, 100) })),
  }))
}
export async function cachedPlan(
  db: D1Database,
  job: JobRow,
  input: JobInput,
  s: Settings,
): Promise<StepResult> {
  const ids = await categoryIds(db, s)
  if (input.preset === 'potential') {
    const report = await potentialProducts(db, job.created_at, 1, 5)
    return { summary: '按团队新品预设完成库存商品评估，共 ' + report.total + ' 件候选。',
      result: { preset: 'potential', categoryIds: ids, focus: [], sampled: report.total, matched: report.total,
        examples: report.items, plannedMaxDataPoints: s.pageLimit * 10, plannedMaxAiMicros: 0 } }
  }
  let target = input.productId
    ? await db
        .prepare('SELECT ' + snapshotFields + ',variants_json FROM products WHERE id=?')
        .bind(input.productId)
        .first<Record<string, unknown>>()
    : null
  if (
    input.imageId &&
    !(await db
      .prepare('SELECT 1 AS present FROM research_images WHERE id=?')
      .bind(input.imageId)
      .first())
  )
    throw bad('参考图不存在')
  if (job.parent_id && input.productId) {
    const snapshot = await db
      .prepare(`SELECT s.snapshot_json FROM job_seen q JOIN product_snapshots s
      ON s.product_id=q.product_id AND s.evidence_ref=q.evidence_ref WHERE q.run_id=? AND q.product_id=?`)
      .bind(job.parent_id, input.productId)
      .first<{ snapshot_json: string }>()
    if (!snapshot) throw bad('缺少本轮发现的原始商品快照')
    const raw = JSON.parse(snapshot.snapshot_json) as Record<string, unknown>
    target = Object.fromEntries(
      (snapshotFields + ',variants_json').split(',').map((k) => [k, raw[k] ?? null]),
    )
  }
  if (input.productId && !target) throw bad('指定商品未在商品库中找到')
  const variants = pinnedVariants(target?.variants_json)
  if (target) delete target.variants_json
  const daily = await usage(db)
  const aiCap = Math.max(
    0,
    Math.min(input.maxAiMicros ?? s.aiDailyMicros, s.aiDailyMicros - daily.aiMicros),
  )
  const plannedMaxAiMicros =
    input.mode === 'cache'
      ? 0
      : job.kind === 'research'
        ? aiCap < 3000
          ? 0
          : Math.min(aiCap, 33000)
        : Math.min(s.researchLimit, Math.floor(aiCap / 33000)) * 33000
  // Keep one actual observation per Shanghai calendar day; gaps remain visible.
  const history = input.productId
    ? (
        await db
          .prepare(`SELECT day,observed_at,min_price,currency,total_sold,day_sold,evidence_ref
        FROM (SELECT date(observed_at,'+8 hours') AS day,observed_at,min_price,currency,total_sold,day_sold,evidence_ref,
          row_number() OVER(PARTITION BY date(observed_at,'+8 hours') ORDER BY observed_at DESC,COALESCE(fetched_at,'') DESC,evidence_ref DESC) AS r
          FROM observations WHERE product_id=?) WHERE r=1 ORDER BY day DESC LIMIT 7`)
          .bind(input.productId)
          .all<{ day: string; day_sold: number | null }>()
      ).results
    : []
  const earliest = history.at(-1),
    latest = history[0]
  const elapsedDays =
    earliest && latest ? (Date.parse(latest.day) - Date.parse(earliest.day)) / 86400000 : null
  const salesChange =
    elapsedDays !== null && elapsedDays > 0 && earliest?.day_sold != null && latest?.day_sold != null
      ? latest.day_sold - earliest.day_sold
      : null
  const clauses = ['market=?', 'platform=?'],
    binds: (string | number)[] = ['US', s.platform]
  if (ids.length) {
    clauses.push('category_id IN (' + ids.map(() => '?').join(',') + ')')
    binds.push(...ids)
  }
  if (s.maxPrice !== null) {
    clauses.push("currency='USD' AND min_price<=?")
    binds.push(s.maxPrice)
  }
  if (s.keyword) {
    clauses.push("(instr(lower(title),lower(?))>0 OR instr(lower(COALESCE(title_cn,'')),lower(?))>0)")
    binds.push(s.keyword, s.keyword)
  }
  const where = clauses.join(' AND ')
  // Zero disables the Amazon volume floor. Keep missing raw volume null in the report.
  const tierVolume = s.platform === 'amazon' ? 'COALESCE(total_sold,0)' : 'total_sold'
  const aggregate = s.tiers
    .map(
      (_, i) =>
        'SUM(CASE WHEN '+tierVolume+'>=?' + (i ? ' AND '+tierVolume+'<?' : '') + ' THEN 1 ELSE 0 END) AS t' + i,
    )
    .join(',')
  const cutoffs = s.tiers.flatMap((v, i) => (i ? [v, s.tiers[i - 1]] : [v]))
  const amazon = input.productId
    ? (
        await db
          .prepare(`SELECT m.asin,m.latest_search AS searchId,m.reviewed_at AS reviewedAt,
    substr(m.note,1,300) AS comparisonNote,substr(json_extract(e.snapshot,'$.specs'),1,300) AS specs,
    substr(json_extract(e.snapshot,'$.title'),1,250) AS title,json_extract(e.snapshot,'$.rank') AS salesRankProxy,
    p.price,p.currency,p.shipping,p.status AS priceStatus,p.fetched_at AS quotedAt
    FROM amazon_matches m JOIN amazon_catalog_evidence e ON e.search_id=m.latest_search AND e.asin=m.asin
    LEFT JOIN amazon_prices p ON p.id=(SELECT MAX(ap.id) FROM amazon_prices ap WHERE ap.product_id=m.product_id AND ap.asin=m.asin)
    WHERE m.product_id=? AND m.status='confirmed' ORDER BY m.reviewed_at DESC,m.asin LIMIT 3`)
          .bind(input.productId)
          .all()
      ).results
    : []
  const counts = await db
    .prepare(
      'SELECT COUNT(*) sampled,COUNT(*)-COUNT(total_sold) missing,' +
        aggregate +
        ' FROM products WHERE ' +
        where,
    )
    .bind(...cutoffs, ...binds)
    .first<Record<string, number>>()
  const batchResearch = job.kind === 'research' && !target
  const examples = await db
    .prepare(
      'SELECT ' +
        snapshotFields +
        (batchResearch ? ',variants_json' : '') +
        ' FROM products WHERE ' +
        where +
        ' AND '+tierVolume+'>=? ORDER BY total_sold DESC,id LIMIT 5',
    )
    .bind(...binds, s.tiers[s.tiers.length - 1])
    .all<Record<string, unknown>>()
  const tiers = s.tiers.map((lower, i) => ({
    lower,
    upper: i ? s.tiers[i - 1] : null,
    count: counts?.['t' + i] ?? 0,
  }))
  const matched = tiers.reduce((sum, t) => sum + t.count, 0)
  const focus =
    job.kind === 'discovery' && s.focusLimit > 0
      ? (
          await db
            .prepare(`SELECT p.id,p.platform,p.external_id FROM products p JOIN candidates c ON p.id=c.product_id
        WHERE c.stage IN ('follow','watch') AND p.market='US' AND p.platform=? AND p.platform!='shein'
        ORDER BY p.fetched_at,c.updated_at,p.id LIMIT ?`)
            .bind(s.platform, s.focusLimit)
            .all()
        ).results
      : []
  return {
    summary:
      (target ? '已保存指定商品快照；' : '') +
      '缓存范围内 ' +
      (counts?.sampled ?? 0) +
      ' 件，累计销量分层达标 ' +
      matched +
      ' 件，无新增费用。',
    result: {
      mode: 'cache',
      strategyVersion: job.strategy_version,
      goal: input.goal ?? '',
      target,
      variants,
      variantEvidenceRef: target?.evidence_ref ?? null,
      history,
      trend: {
        observedDates: history.length,
        elapsedDays,
        daySoldChange: salesChange,
        firstDate: earliest?.day ?? null,
        lastDate: latest?.day ?? null,
      },
      imageId: input.imageId ?? null,
      amazon,
      amazonScope: '本快照仅收录 Amazon 美国站已人工确认的匹配。排名为类目排名，竞品真实销量未知。',
      settings: s,
      categoryIds: ids,
      sampled: counts?.sampled ?? 0,
      missingTotalSold: counts?.missing ?? 0,
      matched,
      tiers,
      examples: batchResearch
        ? examples.results.map(({ variants_json, ...item }, index) =>
            index < 3 ? { ...item, variants: pinnedVariants(variants_json) } : item,
          )
        : examples.results,
      focus,
      actions: [
        '核对样本的销量口径和最近更新时间',
        '复核可比规格、Amazon 匹配与报价',
        '分别评估标品与差异化/POD机会并记录人工意见',
      ],
      limitations: ['缓存计数仅覆盖已入库样本', '未获得竞品真实销量、Haul来源或利润核算证据'],
      plannedMaxDataPoints: job.kind === 'discovery' ? (s.pageLimit + focus.length) * 10 : 0,
      plannedMaxAiMicros,
      promptVersion: job.kind === 'research' && target ? selectionPromptVersion : promptVersion,
    },
  }
}
