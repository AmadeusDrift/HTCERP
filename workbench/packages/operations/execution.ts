import type { AmazonComparison } from '../amazon/auto-compare'
import { AmazonUS } from '../amazon/adapter'
import { haulPriceTier } from '../amazon/haul-price-tier'
import { normalizeProduct } from '../catalog/facts'
import { ingestGeekbi } from '../catalog/ingest'
import { geekSlots, providerCredentials, redactJson } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { amazonModelFacts, researchProducts } from './amazon-comparison'
import { geekCredential, isGeekSlotRefused, nextGeekSlot } from './geekbi'

export { testGeekbiSlot } from './geekbi-direct'

import {
  businessClock,
  currentStrategy,
  effective,
  getRun,
  type JobInput,
  type JobRow,
  models,
  now,
  type OpsBindings,
  promptVersion,
  type Settings,
  type StepResult,
  saveStep,
  selectionPromptVersion,
} from './model'
import { tierFor } from './plan'
import { potentialWindow } from './potential-scope'
import {
  aiRequest,
  bounds,
  charged,
  detailParams,
  type Envelope,
  fitsAiInput,
  geekRequest,
  isGeekBalanceRejection,
  parseDecision,
  parseDetail,
  parseSearch,
  parseTerra,
  retryAt,
  Stop,
  searchParams,
  sendRequest,
} from './providers'

interface Context {
  env: OpsBindings
  job: JobRow
  input: JobInput
  settings: Settings
  attempt: number
}
export const instanceId = (job: JobRow) => 'job-' + job.id + '-' + job.attempt
async function stillActive(c: Context) {
  const j = await getRun(c.env.DB, c.job.id)
  if (j.attempt !== c.attempt || j.status !== 'running')
    throw new Stop('任务已经暂停、取消或切换执行实例')
}
export async function activeContext(env: OpsBindings, id: string, instance: string) {
  const job = await getRun(env.DB, id)
  if (instanceId(job) !== instance || !['queued', 'running'].includes(job.status)) return null
  const updated = await env.DB.prepare(
    "UPDATE job_runs SET status='running',updated_at=? WHERE id=? AND attempt=? AND status IN ('queued','running')",
  )
    .bind(now(), id, job.attempt)
    .run()
  if (!updated.meta.changes) return null
  const input: JobInput = JSON.parse(job.inputs_json)
  const strategy = await currentStrategy(env.DB, job.strategy_version)
  return { env, job, input, settings: effective(strategy.settings, input), attempt: job.attempt }
}
type Unit = 'points' | 'micros'
export async function reserve(
  c: Context,
  key: string,
  unit: Unit,
  amount: number,
  logicalKey = key,
  slot = 1,
  priorCount = 0,
  revision: string | null = null,
) {
  const db = c.env.DB,
    daily = unit === 'points' ? 'dataDailyPoints' : 'aiDailyMicros'
  const runCap = unit === 'points' ? c.input.maxDataPoints : c.input.maxAiMicros
  const date = businessClock().slice(0, 10)
  const insert = await db
    .prepare(`INSERT INTO usage_reservations(run_id,step_key,unit,business_date,reserved,state,created_at,attempt,logical_key,credential_slot,credential_revision)
    SELECT ?,?,?,?,?,'reserved',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM job_runs WHERE id=? AND attempt=? AND status='running')
    AND (SELECT COUNT(*) FROM usage_reservations WHERE run_id=? AND logical_key=?)=?
    AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE balance_refused=1 AND business_date=? AND credential_slot=? AND ? IN (credential_revision,legacy_binding_match))
    AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE business_date=? AND unit=? AND actual>reserved)
    AND ?+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit=? AND business_date=?)
       <= MIN(?,(SELECT json_extract(settings_json,'$.${daily}') FROM strategy_versions ORDER BY version DESC LIMIT 1))
    AND ?+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit=? AND run_id=?) <= ?
    ON CONFLICT(run_id,step_key) DO NOTHING`)
    .bind(
      c.job.id,
      key,
      unit,
      date,
      amount,
      now(),
      c.attempt,
      logicalKey,
      slot,
      revision,
      c.job.id,
      c.attempt,
      c.job.id,
      logicalKey,
      priorCount,
      date,
      slot,
      revision,
      date,
      unit,
      amount,
      unit,
      date,
      c.settings[daily],
      amount,
      unit,
      c.job.id,
      Math.min(runCap ?? c.settings[daily], c.settings[daily]),
    )
    .run()
  if (insert.meta.changes) return
  const prior = await db
    .prepare('SELECT state FROM usage_reservations WHERE run_id=? AND step_key=?')
    .bind(c.job.id, key)
    .first()
  if (prior) throw new Stop('此步骤已有发送记录，缺少可重放响应，费用待核对；不会重复发送')
  if (revision && (await isGeekSlotRefused(db, slot, revision)))
    throw new PublicError('SLOT_REFUSED', '该组今天已返回余额不足。', 409)
  await stillActive(c)
  throw new Stop(unit === 'points' ? '积分预算不足，未发送此请求' : 'AI 金额预算不足，未发送此请求')
}
async function archived(
  c: Context,
  logicalKey: string,
  unit: Unit,
  estimate: number,
  request: (
    credentials: Pick<OpsBindings, 'GB_APP_KEY' | 'GB_APP_SECRET' | 'OPENROUTER_API_KEY'>,
  ) => Promise<Request> | Request,
) {
  const db = c.env.DB
  const prior = await db
    .prepare(
      'SELECT step_key,attempt,state,credential_slot FROM usage_reservations WHERE run_id=? AND logical_key=? ORDER BY attempt DESC, rowid DESC',
    )
    .bind(c.job.id, logicalKey)
    .all<{ step_key: string; attempt: number; state: string; credential_slot: number }>()
  const last = prior.results[0],
    prefix = 'jobs/' + c.job.id + '/v1/'
  let key = last?.step_key ?? logicalKey,
    ref = prefix + key + '.json'
  let result: Envelope
  const existing = last ? await c.env.ARCHIVE.get(ref) : null
  let saved = existing ? await existing.json<Envelope>() : null
  if (last && !saved) {
    await db
      .prepare(
        "UPDATE usage_reservations SET state='uncertain' WHERE run_id=? AND step_key=? AND state='reserved'",
      )
      .bind(c.job.id, key)
      .run()
    throw new Stop('上次发送没有可重放响应，费用待人工核对')
  }
  if (
    last &&
    saved &&
    last.attempt < c.attempt &&
    last.state === 'confirmed' &&
    prior.results.length < 3 &&
    (saved.status === 429 || saved.status >= 500) &&
    (charged(saved, unit) ?? Infinity) <= estimate
  ) {
    if (retryAt(saved) > Date.now()) throw new Stop('供应商的 Retry-After 等待时间尚未结束')
    key = logicalKey + '-attempt-' + c.attempt
    ref = prefix + key + '.json'
    saved = null
  }
  let slot = last?.credential_slot ?? 1
  let priorCount = prior.results.length
  let allowSkip = !last
  let sawRefusal = false
  if (
    last &&
    saved &&
    last.attempt < c.attempt &&
    unit === 'points' &&
    (saved.points === null || charged(saved, unit) === 0) &&
    isGeekBalanceRejection(saved)
  ) {
    // Re-evaluate all slots on an explicit retry. Daily refusals still exclude unchanged keys.
    allowSkip = true
    sawRefusal = true
    slot = 1
    saved = null
  }
  for (;;) {
    if (saved) result = saved
    else {
      // Build and validate the complete request before reserving. No retries after a possible send.
      const chosen =
        unit === 'points'
          ? allowSkip
            ? await nextGeekSlot(c.env, slot, sawRefusal)
            : await geekCredential(c.env, slot)
          : null
      if (unit === 'points' && !chosen) throw new Stop('极鲸云密钥待配置')
      if (chosen) slot = chosen.slot
      const { credentials } = chosen ?? (await providerCredentials(c.env, 'openrouter'))
      const credentialRevision = chosen?.revision ?? null
      if (allowSkip) {
        key =
          logicalKey +
          (slot === 1 ? '' : '-slot-' + slot) +
          (c.attempt === 0 ? '' : '-attempt-' + c.attempt)
        ref = prefix + key + '.json'
      }
      const req = await request(credentials)
      try {
        await reserve(c, key, unit, estimate, logicalKey, slot, priorCount, credentialRevision)
      } catch (e) {
        if (!(e instanceof PublicError && e.code === 'SLOT_REFUSED' && allowSkip)) throw e
        slot++
        sawRefusal = true
        continue
      }
      priorCount++
      try {
        result = await sendRequest(req, unit === 'micros' ? c.env.OPENROUTER_US : undefined)
        const secrets = [
          ...Object.values(credentials),
          c.env.GB_APP_KEY,
          c.env.GB_APP_SECRET,
          c.env.OPENROUTER_API_KEY,
        ]
        result = {
          ...result,
          body: redactJson(result.body, secrets),
          points: redactJson(result.points, secrets) as string | null,
          retryAfter: redactJson(result.retryAfter, secrets) as string | null | undefined,
        }
        const serialized = JSON.stringify(result)
        const object = await c.env.ARCHIVE.put(ref, serialized, {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/json' },
        })
        if (!object) throw new Stop('归档键冲突')
      } catch {
        await db
          .prepare(
            "UPDATE usage_reservations SET state='uncertain' WHERE run_id=? AND step_key=? AND state='reserved'",
          )
          .bind(c.job.id, key)
          .run()
        throw new Stop('发送后未能确认响应归档，预留费用待核对；已停止自动重发')
      }
    }
    const cost = charged(result, unit)
    const refused =
      unit === 'points' && (result.points === null || cost === 0) && isGeekBalanceRejection(result)
    await db
      .prepare(
        'UPDATE usage_reservations SET actual=?,state=?,balance_refused=? WHERE run_id=? AND step_key=?',
      )
      .bind(cost, cost === null ? 'uncertain' : 'confirmed', Number(refused), c.job.id, key)
      .run()
    if (refused) {
      sawRefusal = true
      if (slot >= geekSlots.length) throw new Stop('已配置的极鲸云凭据组余额不足')
      slot++
      saved = null
      allowSkip = true
      continue
    }
    if (result.status !== 200) {
      const reason: Record<number, string> = {
        401: '鉴权失败',
        403: '权限不足',
        402: '供应商拒绝了计费请求',
        429: '来源限流，已停止请求',
      }
      throw new Stop(
        (reason[result.status] ?? '来源请求失败') + '（HTTP ' + result.status + '），响应已归档',
      )
    }
    if (cost === null) throw new Stop('响应缺少有效费用凭证，已保留预留金额，等待人工核对')
    if (cost > estimate) throw new Stop('实际费用超过预留上限，已按响应记账，等待人工核对')
    return { result, ref }
  }
}
export async function storedResult(db: D1Database, id: string, key: string) {
  const stored = await db
    .prepare("SELECT result_json FROM job_steps WHERE run_id=? AND step_key=? AND status='succeeded'")
    .bind(id, key)
    .first<{ result_json: string }>()
  return stored ? (JSON.parse(stored.result_json) as Record<string, unknown>) : null
}
export async function stepOnce(
  c: Context,
  key: string,
  title: string,
  action: () => Promise<StepResult>,
) {
  await stillActive(c)
  const saved = await storedResult(c.env.DB, c.job.id, key)
  if (saved) return saved
  await saveStep(c.env.DB, c.job.id, key, title, 'running', { summary: '执行中', result: {} })
  try {
    const details = await action()
    await saveStep(c.env.DB, c.job.id, key, title, 'succeeded', details)
    return details.result
  } catch (error) {
    const reason =
      error instanceof Stop || error instanceof PublicError
        ? error.message
        : '步骤处理失败，请检查归档后补跑'
    const last = await c.env.DB.prepare(
      'SELECT step_key FROM usage_reservations WHERE run_id=? AND logical_key=? ORDER BY attempt DESC, rowid DESC LIMIT 1',
    )
      .bind(c.job.id, key)
      .first<{ step_key: string }>()
    const ref = 'jobs/' + c.job.id + '/v1/' + (last?.step_key ?? key) + '.json'
    const hasArchive = await c.env.ARCHIVE.head(ref)
    await saveStep(c.env.DB, c.job.id, key, title, 'failed', {
      summary: reason,
      result: {},
      evidenceRef: hasArchive ? ref : undefined,
    })
    throw new Stop(reason)
  }
}
export async function discoverPage(c: Context, page: number, ids: string[]): Promise<StepResult> {
  const { settings: s } = c
  const params = searchParams(s.platform, page, ids, s.keyword),
    key = 'search-' + page
  const potential = c.input.preset === 'potential'
  if (s.platform === 'amazon' && s.maxPrice !== null) params.priceMax = String(s.maxPrice)
  if (potential) Object.assign(params, { sort: 'onSaleTime', order: 'desc' })
  const { result, ref } = await archived(c, key, 'points', bounds.geekbi, (credentials) =>
    geekRequest(credentials, s.platform, false, params),
  )
  const data = parseSearch(result.body)
  const origin = {
    platform: s.platform,
    market: 'US' as const,
    fetchedAt: result.fetchedAt,
    source: 'geekbi',
    evidenceRef: ref,
  }
  const seen = new Map<string, { tier: number | null; sold: number | null; reason: string | null }>(),
    accepted: Record<string, unknown>[] = []
  const newSince = potential ? potentialWindow(result.fetchedAt) : ''
  let missingSold = 0
  for (const row of data.list) {
    const item = normalizeProduct(row, origin),
      tier = potential ? 0 : tierFor(item.total_sold ?? (s.platform === 'amazon' ? 0 : null), s.tiers)
    if (item.total_sold === null) missingSold++
    const withinWindow = !item.on_sale_at || (item.on_sale_at >= newSince && item.on_sale_at <= result.fetchedAt)
    const inCategory = !ids.length || ids.includes(item.category_id ?? '') ||
      (s.platform === 'amazon' && Array.isArray(row.catIds) && row.catIds.some(id => ids.includes(String(id))))
    let reason = null
    if (potential && !withinWindow) reason = '超出新品时间范围'
    else if (!inCategory) reason = '类目不符'
    else if ((potential && item.currency !== 'USD') || (s.maxPrice !== null && item.min_price === null)) reason = '资料不足'
    else if (s.maxPrice !== null && item.min_price !== null && item.min_price > s.maxPrice) reason = '超出价格上限'
    else if (tier === null) reason = item.total_sold === null ? '资料不足' : '销量未达标'
    const eligible = reason === null
    if (!seen.has(item.id) || eligible)
      seen.set(item.id, { tier: eligible ? tier : null, sold: item.total_sold, reason })
    if (eligible) accepted.push(row)
  }
  await ingestGeekbi(c.env.DB, { ...origin, rows: accepted })
  const entries = [...seen.entries()]
  for (let offset = 0; offset < entries.length; offset += 14) {
    const part = entries.slice(offset, offset + 14)
    await c.env.DB.prepare(
      'INSERT INTO job_seen(run_id,product_id,tier,first_page,total_sold,evidence_ref,exclusion_reason) VALUES ' +
        part.map(() => '(?,?,?,?,?,?,?)').join(',') +
        ' ON CONFLICT(run_id,product_id) DO UPDATE SET tier=excluded.tier,total_sold=excluded.total_sold,evidence_ref=excluded.evidence_ref,exclusion_reason=NULL' +
        ' WHERE job_seen.tier IS NULL AND excluded.tier IS NOT NULL',
    )
      .bind(...part.flatMap(([id, item]) => [c.job.id, id, item.tier, page, item.sold, ref,item.reason]))
      .run()
  }
  const first = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM job_seen WHERE run_id=? AND first_page=?',
  )
    .bind(c.job.id, page)
    .first<{ n: number }>()
  const counts = await c.env.DB.prepare(
    'SELECT tier,COUNT(*) count FROM job_seen WHERE run_id=? AND evidence_ref=? AND tier IS NOT NULL GROUP BY tier',
  )
    .bind(c.job.id, ref)
    .all<{ tier: number; count: number }>()
  const unique = first?.n ?? 0,
    duplicates = data.list.length - unique
  const matched = counts.results.reduce((n, row) => n + row.count, 0)
  const quotes = []
  let quoteStatus = ''
  if (s.platform === 'amazon' && matched) {
    const asins = [...new Set(accepted.map(row => String(row.goodsId)))]
    try {
      const { credentials } = await providerCredentials(c.env, 'amazon')
      const offers = await new AmazonUS(credentials).batchOffers(asins.slice(0,20))
      for (const asin of asins) {
        const offer = offers.get(asin)
        quotes.push({ asin, price: offer?.price ?? null, shipping: offer?.shipping ?? null,
          tier: haulPriceTier(offer?.price ?? null) })
      }
      quoteStatus = '已取得 ' + quotes.filter(q => q.price != null).length + ' 个官方报价'
    } catch (error) {
      quoteStatus = error instanceof PublicError ? '待补核价：' + error.message : '官方报价待补查'
    }
  }
  const exhausted =
    (s.platform === 'amazon' && page * Number(params.size) >= 200) ||
    data.hasMore === false ||
    data.list.length < Number(params.size) ||
    (data.total !== undefined && page * Number(params.size) >= data.total)
  const stop = exhausted
    ? '已到本次检索结果末页'
    : page === s.pageLimit
      ? '达到策略页数上限'
      : '继续下一页'
  return {
    summary:
      '返回 ' +
      data.list.length +
      ' 行，首次出现 ' +
      unique +
      ' 件，本页首次达标 ' +
      matched +
      ' 件。' +
      stop + (quoteStatus ? ' · ' + quoteStatus : ''),
    result: {
      page,
      params,
      rows: data.list.length,
      ...(s.platform === 'amazon' ? { quotes, quoteStatus } : {}),
      unique,
      duplicates,
      matched,
      missingSold,
      tiers: s.tiers.map((lower, i) => ({
        lower,
        upper: i ? s.tiers[i - 1] : null,
        count: counts.results.find((r) => r.tier === lower)?.count ?? 0,
      })),
      reportedTotal: data.total ?? null,
      exhausted,
      stop,
      postFilters: [potential ? '近 30 天上架或日期待核' : '累计销量', '美元价格', ...(ids.length ? ['来源类目复核'] : [])],
      strategyVersion: c.job.strategy_version,
    },
    evidenceRef: ref,
  }
}
export async function refreshFocus(c: Context, id: string): Promise<StepResult> {
  const externalId = id.split(':')[2],
    platform = c.settings.platform,
    params = detailParams(platform, externalId)
  const key = 'focus-' + externalId
  const { result, ref } = await archived(c, key, 'points', bounds.geekbi, (credentials) =>
    geekRequest(credentials, platform, true, params),
  )
  const data = parseDetail(result.body, externalId)
  await ingestGeekbi(c.env.DB, {
    platform,
    market: 'US',
    rows: [data.goods],
    detail: true,
    history: data.history ?? [],
    fetchedAt: result.fetchedAt,
    evidenceRef: ref,
  })
  return {
    summary: '已保存重点商品详情及 ' + (data.history?.length ?? 0) + ' 条来源历史',
    result: { productId: id, historyRows: data.history?.length ?? 0, params },
    evidenceRef: ref,
  }
}
export async function researchStep(
  c: Context,
  kind: 'decision' | 'terra',
  plan: Record<string, unknown>,
): Promise<StepResult> {
  const items = researchProducts(plan)
  const version =
    kind === 'terra' && plan.promptVersion === selectionPromptVersion
      ? selectionPromptVersion
      : promptVersion
  const comparison = kind === 'terra' ? await storedResult(c.env.DB, c.job.id, 'amazon-compare') : null
  if (kind === 'terra' && !Array.isArray(comparison?.comparisons))
    throw new Stop('缺少本次 Amazon 美国站检索记录')
  const comparisons = comparison?.comparisons as AmazonComparison[] | undefined
  let evidence: Record<string, unknown> = {
    goal: c.input.goal ?? '',
    products: items.map(({ variants: _variants, ...item }) => ({
      ...item,
      title: String(item.title).slice(0, 400),
    })),
    amazon: plan.amazon ?? [],
    history: plan.history ?? [],
    variants: plan.variants ?? [],
    variantEvidenceRef: plan.variantEvidenceRef ?? null,
    trend: plan.trend,
    amazonScope:
      kind === 'terra'
        ? 'amazon 是缓存的人工确认匹配；amazonComparisons 是按本次商品检索的待复核竞品。实时报价以 USD 计，运费单列。类目排名不代表销量。'
        : plan.amazonScope,
    amazonComparisons: comparisons ? amazonModelFacts(comparisons) : undefined,
    referenceImage: c.input.imageId ? '人工关联参考图；不能仅凭图片确认同款' : null,
    strategyVersion: c.job.strategy_version,
    decision: kind === 'terra' ? await storedResult(c.env.DB, c.job.id, 'decision') : undefined,
  }
  if (comparisons && !fitsAiInput(evidence)) {
    // Preserve comparable source metrics and one live result for every product before ancillary evidence.
    evidence = {
      goal: c.input.goal?.slice(0, 600),
      products: items.map((p) => ({
        id: p.id,
        title: String(p.title).slice(0, 140),
        platform: p.platform,
        min_price: p.min_price,
        currency: p.currency,
        total_sold: p.total_sold,
        total_sold_field: p.total_sold_field,
        day_sold: p.day_sold,
        week_sold: p.week_sold,
        month_sold: p.month_sold,
        updated_at: p.updated_at,
      })),
      amazon: Array.isArray(plan.amazon)
        ? plan.amazon.slice(0, 3).map((p) => ({
            asin: p.asin,
            title: String(p.title ?? '').slice(0, 80),
            salesRankProxy: p.salesRankProxy,
            price: p.price,
            shipping: p.shipping,
            currency: p.currency,
            quotedAt: p.quotedAt,
          }))
        : [],
      amazonComparisons: amazonModelFacts(comparisons, true),
      amazonScope: evidence.amazonScope,
      decision: (evidence.decision as { choice?: string } | null)?.choice,
      trend: plan.trend,
      referenceImage: evidence.referenceImage,
    }
  }
  const { result, ref } = await archived(c, kind, 'micros', bounds[kind], async (credentials) => {
    let image: string | undefined
    if (kind === 'terra' && c.input.imageId) {
      const asset = await c.env.ARCHIVE.get('research-images/' + c.input.imageId + '.jpg')
      if (!asset || asset.size > 160 * 1024) throw new Stop('参考图尚未归档或超过 160 KiB')
      const bytes = new Uint8Array(await asset.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      image = 'data:image/jpeg;base64,' + btoa(binary)
    }
    return aiRequest(credentials, kind, evidence, image, version)
  })
  const common = {
    model: kind === 'decision' ? models.decision : models.research,
    promptVersion: version,
    strategyVersion: c.job.strategy_version,
    snapshotStep: 'plan',
    products: items.map((item) => item.id),
  }
  if (kind === 'decision') {
    const d = parseDecision(result.body)
    return {
      summary: '模型分流：' + { research: '进一步研究', observe: '观察', review: '人工复核' }[d.choice],
      result: { ...common, ...d },
      evidenceRef: ref,
    }
  }
  const report = parseTerra(result.body, version)
  return { summary: report.summary, result: { ...common, ...report }, evidenceRef: ref }
}
export async function followDecision(
  c: Context,
  choice: 'research' | 'observe' | 'review',
): Promise<StepResult> {
  const labels = {
    research: 'Terra 报告待人工复核',
    observe: '需求信号需继续观察',
    review: '规格或需求证据需人工核对',
  }
  const nextAction = labels[choice],
    productId = c.input.productId
  const basis = await c.env.DB.prepare(
    "SELECT evidence_ref FROM job_steps WHERE run_id=? AND step_key=? AND status='succeeded'",
  )
    .bind(c.job.id, choice === 'research' ? 'terra' : 'decision')
    .first<{ evidence_ref: string }>()
  if (!basis) throw new Stop('缺少可追溯的模型响应')
  let watchCreated = false
  if (productId) {
    const author = choice === 'research' ? 'AI · Terra' : 'AI · Decisions'
    // Automatic triage is a provisional watch item. Manual feedback remains a separate history.
    const inserted =
      await c.env.DB.prepare(`INSERT INTO candidates(product_id,stage,lines_json,note,updated_by,updated_at)
      SELECT ?,'watch','[]',?,?,? WHERE EXISTS(SELECT 1 FROM job_runs WHERE id=? AND status='running' AND attempt=?)
      ON CONFLICT(product_id) DO NOTHING`)
        .bind(
          productId,
          nextAction + '。任务 ' + c.job.id + '，依据 ' + basis.evidence_ref,
          author,
          now(),
          c.job.id,
          c.attempt,
        )
        .run()
    watchCreated = Boolean(inserted.meta.changes)
  }
  return {
    summary:
      nextAction +
      (productId
        ? watchCreated
          ? '，已加入观察池。'
          : '，已保留既有候选状态与意见。'
        : '，请在研究范围内人工明确商品。'),
    result: {
      productId: productId ?? null,
      route: choice,
      nextAction,
      watchCreated,
      terraRequested: choice === 'research',
    },
    evidenceRef: basis.evidence_ref,
  }
}
export async function finish(
  env: OpsBindings,
  id: string,
  attempt: number,
  success: boolean,
  summary: string,
) {
  await env.DB.prepare(`UPDATE job_runs SET
    status=CASE status WHEN 'pausing' THEN 'paused' WHEN 'cancelling' THEN 'cancelled' ELSE ? END,
    summary=CASE WHEN status IN ('pausing','cancelling') THEN summary ELSE ? END, updated_at=?
    WHERE id=? AND attempt=? AND status IN ('running','queued','pausing','cancelling')`)
    .bind(success ? 'succeeded' : 'partial', summary, now(), id, attempt)
    .run()
}
