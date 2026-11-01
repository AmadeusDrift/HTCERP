import { createJob, hash } from './jobs'
import {
  getRun,
  type JobInput,
  type JobRow,
  type OpsBindings,
  type Settings,
  saveStep,
  sourceConfigured,
  usage,
} from './model'

export async function researchQueue(db: D1Database, id: string, page: number, pageSize: number) {
  const where =
    'FROM job_seen q JOIN products p ON p.id=q.product_id WHERE q.run_id=? AND q.tier IS NOT NULL'
  const rows = await db
    .prepare(
      'SELECT q.product_id AS productId,p.title,q.tier,q.total_sold AS totalSold,q.first_page AS page,' +
        'q.evidence_ref AS evidenceRef,q.child_id AS childId ' +
        where +
        ' ORDER BY q.tier DESC,q.total_sold DESC,q.product_id LIMIT ? OFFSET ?',
    )
    .bind(id, pageSize, (page - 1) * pageSize)
    .all<{
      productId: string
      title: string
      tier: number
      totalSold: number
      page: number
      evidenceRef: string
      childId: string | null
    }>()
  const count = await db
    .prepare('SELECT COUNT(*) AS n ' + where)
    .bind(id)
    .first<{ n: number }>()
  return { items: rows.results, total: count?.n ?? 0, page, pageSize }
}
export async function advanceQueue(
  env: OpsBindings,
  job: JobRow,
  s: Settings,
  input: JobInput,
  blocked: string,
) {
  // Link existing automatic research on identical business inputs, including pre-migration children.
  // Failed/uncertain work is also linked for explicit review rather than automatically billed again.
  await env.DB.prepare(`UPDATE job_seen AS q SET child_id=(
    SELECT j.id FROM job_runs j WHERE j.parent_id=q.run_id AND json_extract(j.inputs_json,'$.productId')=q.product_id LIMIT 1)
    WHERE q.run_id=? AND q.tier IS NOT NULL AND q.child_id IS NULL AND EXISTS(SELECT 1 FROM job_runs j WHERE j.parent_id=q.run_id)`)
    .bind(job.id)
    .run()
  await env.DB.prepare(`UPDATE job_seen AS q SET child_id=(
    SELECT old.child_id FROM discovery_input_facts cur JOIN discovery_input_facts old
      ON old.product_id=cur.product_id AND old.strategy_version=cur.strategy_version AND old.facts=cur.facts
    WHERE cur.run_id=q.run_id AND cur.product_id=q.product_id AND old.run_id<>cur.run_id AND old.child_id IS NOT NULL
    LIMIT 1) WHERE q.run_id=? AND q.tier IS NOT NULL AND q.child_id IS NULL`)
    .bind(job.id)
    .run()
  const top = await researchQueue(env.DB, job.id, 1, 5)
  const counts = await env.DB.prepare(
    'SELECT tier,COUNT(*) AS n FROM job_seen WHERE run_id=? AND tier IS NOT NULL GROUP BY tier',
  )
    .bind(job.id)
    .all<{ tier: number; n: number }>()
  const tiers = s.tiers.map((lower, i) => ({
    lower,
    upper: i ? s.tiers[i - 1] : null,
    count: counts.results.find((t) => t.tier === lower)?.n ?? 0,
  }))
  const unit = 33_000
  const previousChildren = await env.DB.prepare('SELECT COUNT(*) AS n FROM job_runs WHERE parent_id=?')
    .bind(job.id)
    .first<{ n: number }>()
  let reason = blocked,
    submitted = previousChildren?.n ?? 0
  const runCap = Math.min(input.maxAiMicros ?? s.aiDailyMicros, s.aiDailyMicros)
  if (!reason && top.total) {
    if (!s.researchLimit) reason = '自动研究数量上限为 0'
    else if (!(await sourceConfigured(env)).openrouter) reason = 'OpenRouter 密钥待配置'
    else {
      const today = await usage(env.DB),
        remaining = s.aiDailyMicros - today.aiMicros
      // Never authorize children above the parent's worst-case cap. Each child also reserves atomically.
      const max = Math.min(s.researchLimit, Math.floor(runCap / unit))
      let available = remaining
      while (submitted < max) {
        const item =
          await env.DB.prepare(`SELECT product_id AS productId,facts FROM discovery_input_facts
          WHERE run_id=? AND child_id IS NULL ORDER BY tier DESC,total_sold DESC,product_id LIMIT 1`)
            .bind(job.id)
            .first<{ productId: string; facts: string }>()
        if (!item) break
        const owner = await getRun(env.DB, job.id)
        if (owner.status !== 'running' || owner.attempt !== job.attempt) {
          reason = '任务已暂停或取消'
          break
        }
        if (available < unit) {
          reason = '今日 AI 剩余预算不足'
          break
        }
        const child = await createJob(
          env,
          {
            kind: 'research',
            inputs: {
              mode: 'live',
              productId: item.productId,
              platform: s.platform,
              categoryId: s.categoryId,
              goal: '复核本轮达标商品的标品与差异化机会',
              maxDataPoints: 0,
              maxAiMicros: unit,
            },
          },
          job.actor,
          'tier-v2:' + job.strategy_version + ':' + item.productId + ':' + (await hash(item.facts)),
          job,
        )
        await env.DB.prepare(
          'UPDATE job_seen SET child_id=? WHERE run_id=? AND product_id=? AND child_id IS NULL',
        )
          .bind(child.id, job.id, item.productId)
          .run()
        if ((await getRun(env.DB, child.id)).parent_id === job.id) {
          submitted++
          available -= unit
        }
      }
      const untouched = await env.DB.prepare(
        'SELECT 1 AS pending FROM job_seen WHERE run_id=? AND tier IS NOT NULL AND child_id IS NULL LIMIT 1',
      )
        .bind(job.id)
        .first()
      if (!reason && untouched)
        reason = max < s.researchLimit ? '任务 AI 预算不足' : '达到本轮自动研究数量上限'
    }
  }
  const reuse =
    await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN j.status IN ('failed','partial','cancelled') THEN 1 ELSE 0 END) AS review,
    SUM(CASE WHEN j.status='succeeded' AND NOT EXISTS(SELECT 1 FROM job_steps a
      WHERE a.run_id=j.id AND a.step_key='amazon-compare' AND a.status='succeeded') THEN 1 ELSE 0 END) AS pendingComparison
    FROM job_seen q JOIN job_runs j ON j.id=q.child_id WHERE q.run_id=? AND j.parent_id<>?`)
      .bind(job.id, job.id)
      .first<{ n: number; review: number | null; pendingComparison: number | null }>()
  const result = {
    tiers,
    total: top.total,
    submitted,
    reused: reuse?.n ?? 0,
    reusedNeedsReview: reuse?.review ?? 0,
    legacyComparisonsPending: reuse?.pendingComparison ?? 0,
    reason,
    examples: (await researchQueue(env.DB, job.id, 1, 5)).items,
  }
  await saveStep(env.DB, job.id, 'research-queue', '本轮达标商品 · 分层研究清单', 'succeeded', {
    summary:
      '本轮 ' +
      top.total +
      ' 件进入分层清单，已关联 ' +
      submitted +
      ' 个本轮研究任务，另有 ' +
      (reuse?.n ?? 0) +
      ' 件关联相同输入的既有研究' +
      (result.legacyComparisonsPending
        ? '，其中 ' + result.legacyComparisonsPending + ' 件尚缺 Amazon 对照，可进入原研究补查'
        : '') +
      (reason ? '；' + reason : '。'),
    result,
  })
  return { submitted, total: top.total, legacyComparisonsPending: result.legacyComparisonsPending }
}
