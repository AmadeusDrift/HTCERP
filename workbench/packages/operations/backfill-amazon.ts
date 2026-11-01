import { PublicError } from '../contracts/errors'
import { amazonComparisonVersion, needsAmazonLookup } from '../amazon/comparison-policy'
import { runAmazonComparison } from './amazon-comparison'
import { storedResult } from './execution'
import { getRun, now, type OpsBindings } from './model'

const stepKey = 'amazon-compare'
const busy = () => new PublicError('CONFLICT', 'Amazon 对比正在更新，请稍后刷新。', 409)

export async function backfillAmazon(env: OpsBindings, id: string) {
  const db = env.DB,
    job = await getRun(db, id)
  if (
    job.kind !== 'research' ||
    JSON.parse(job.inputs_json).mode !== 'live' ||
    !['succeeded', 'partial'].includes(job.status)
  )
    throw new PublicError('NOT_READY', '请等待在线研究完成后再补查。', 409)
  const [plan, decision] = await Promise.all([
    storedResult(db, id, 'plan'),
    storedResult(db, id, 'decision'),
  ])
  if (!plan || !decision) throw new PublicError('NOT_READY', '这项研究尚未完成 AI 分析。', 409)
  const cached = await storedResult(db, id, stepKey)
  if (
    Array.isArray(cached?.comparisons) &&
    cached.comparisons.length &&
    !cached.comparisons.some(needsAmazonLookup)
  )
    return { runId: id, cached: true }

  // Keep the previous result available while retrying. The timestamp fences late responses.
  const claim = now(),
    expires = new Date(Date.parse(claim) - 5 * 60_000).toISOString()
  const locked = await db
    .prepare(`INSERT INTO job_steps(run_id,step_key,title,status,summary,result_json,updated_at)
      VALUES(?,?,'Amazon 跨平台对比','running','正在查询美国站商品','{}',?)
    ON CONFLICT(run_id,step_key) DO UPDATE SET status='running',summary=excluded.summary,updated_at=excluded.updated_at
    WHERE (job_steps.status<>'running' OR job_steps.updated_at<?)
    AND (job_steps.status<>'succeeded' OR NOT EXISTS(SELECT 1 FROM json_each(job_steps.result_json,'$.comparisons'))
       OR EXISTS(SELECT 1 FROM json_each(job_steps.result_json,'$.comparisons') WHERE json_extract(value,'$.status')='unavailable'
          OR COALESCE(json_extract(value,'$.methodVersion'),1)<?))`)
    .bind(id, stepKey, claim, expires, amazonComparisonVersion)
    .run()
  if (!locked.meta.changes) {
    if (await storedResult(db, id, stepKey)) return { runId: id, cached: true }
    throw busy()
  }
  try {
    const result = await runAmazonComparison(env, job, plan, decision)
    const saved = await db
      .prepare(`UPDATE job_steps SET status='succeeded',summary=?,result_json=?,updated_at=?
       WHERE run_id=? AND step_key=? AND status='running' AND updated_at=?`)
      .bind(result.summary, JSON.stringify(result.result), now(), id, stepKey, claim)
      .run()
    if (!saved.meta.changes) throw busy()
    return { runId: id, cached: false }
  } catch (error) {
    await db
      .prepare(`UPDATE job_steps SET status='failed',summary='Amazon 对比未完成，可稍后补查。',updated_at=?
      WHERE run_id=? AND step_key=? AND status='running' AND updated_at=?`)
      .bind(now(), id, stepKey, claim)
      .run()
    throw error
  }
}
