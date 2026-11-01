import { PublicError } from '../contracts/errors'
import { memberDiagnostic } from '../contracts/presentation'
import { instanceId, storedResult } from './execution'
import {
  bad,
  businessClock,
  currentStrategy,
  effective,
  getRun,
  type JobInput,
  type JobRow,
  type NewJob,
  now,
  type OpsBindings,
  saveStep,
  sourceConfigured,
  usage,
} from './model'
import { cachedPlan } from './plan'

export async function hash(s: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}
function summaryRow(row: JobRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: memberDiagnostic(row.summary),
    actor: row.actor,
    strategyVersion: row.strategy_version,
    parentId: row.parent_id,
    inputs: JSON.parse(row.inputs_json) as JobInput,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
async function isTeamSchedule(db: D1Database, row: JobRow) {
  if (row.actor !== 'scheduler') return false
  const root = row.parent_id ? await getRun(db, row.parent_id) : row
  return root.request_key.startsWith('cron:daily:US:')
}
export async function jobView(db: D1Database, id: string) {
  const row = await getRun(db, id)
  const steps = await db
    .prepare(`SELECT step_key AS key,title,status,summary,result_json,evidence_ref AS evidenceRef,updated_at AS updatedAt
    FROM job_steps WHERE run_id=? ORDER BY rowid`)
    .bind(id)
    .all<{
      key: string
      title: string
      summary: string
      status: string
      updatedAt: string
      result_json: string
      evidenceRef: string | null
    }>()
  const ledger = await db
    .prepare(`SELECT logical_key AS stepKey,attempt,unit,business_date AS businessDate,reserved,actual,state,created_at AS createdAt
    FROM usage_reservations WHERE run_id=? ORDER BY rowid`)
    .bind(id)
    .all()
  const ownUsage = await usage(db, id),
    childrenUsage = await usage(db, id, true)
  const familyUsage = {
    dataPoints: ownUsage.dataPoints + childrenUsage.dataPoints,
    aiMicros: ownUsage.aiMicros + childrenUsage.aiMicros,
    unconfirmedDataPoints: ownUsage.unconfirmedDataPoints + childrenUsage.unconfirmedDataPoints,
    unconfirmedAiMicros: ownUsage.unconfirmedAiMicros + childrenUsage.unconfirmedAiMicros,
  }
  return {
    ...summaryRow(row),
    scheduled: await isTeamSchedule(db, row),
    steps: steps.results.map(({ result_json, ...step }) => ({
      ...step,
      result: JSON.parse(result_json),
    })),
    usage: familyUsage,
    ownUsage,
    childrenUsage,
    charges: ledger.results,
  }
}
export async function listJobs(
  db: D1Database,
  kind: string,
  status: string,
  page: number,
  pageSize: number,
) {
  const where = "WHERE (?='' OR kind=?) AND (?='' OR status=?)",
    params = [kind, kind, status, status]
  const [count, rows] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM job_runs ' + where).bind(...params),
    db
      .prepare(
        "SELECT r.*,COALESCE((SELECT SUM(COALESCE(actual,reserved)) FROM usage_reservations u WHERE u.run_id=r.id AND unit='points'),0) AS points," +
          "COALESCE((SELECT SUM(COALESCE(actual,reserved)) FROM usage_reservations u WHERE u.run_id=r.id AND unit='micros'),0) AS micros," +
          "COALESCE((SELECT SUM(COALESCE(actual,reserved)) FROM usage_reservations u JOIN job_runs j ON j.id=u.run_id WHERE j.parent_id=r.id AND unit='points'),0) AS childPoints," +
          "COALESCE((SELECT SUM(COALESCE(actual,reserved)) FROM usage_reservations u JOIN job_runs j ON j.id=u.run_id WHERE j.parent_id=r.id AND unit='micros'),0) AS childMicros FROM job_runs r " +
          where +
          ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      )
      .bind(...params, pageSize, (page - 1) * pageSize),
  ])
  return {
    items: (
      rows.results as (JobRow & {
        points: number
        micros: number
        childPoints: number
        childMicros: number
      })[]
    ).map((r) => ({
      ...summaryRow(r),
      usage: { dataPoints: r.points + r.childPoints, aiMicros: r.micros + r.childMicros },
      ownUsage: { dataPoints: r.points, aiMicros: r.micros },
      childrenUsage: { dataPoints: r.childPoints, aiMicros: r.childMicros },
    })),
    total: Number((count.results[0] as { n: number }).n),
    page,
    pageSize,
  }
}
async function setupRun(env: OpsBindings, job: JobRow) {
  const { settings } = await currentStrategy(env.DB, job.strategy_version)
  const input = JSON.parse(job.inputs_json) as JobInput,
    s = effective(settings, input)
  const mark = async (status: string, message: string) => {
    await env.DB.prepare(
      "UPDATE job_runs SET status=?,summary=?,updated_at=? WHERE id=? AND attempt=? AND status='queued'",
    )
      .bind(status, message, now(), job.id, job.attempt)
      .run()
  }
  try {
    if (input.mode === 'live' && (!['temu','amazon'].includes(s.platform) || (input.productId && !/^(temu|amazon):/.test(input.productId)))) {
      throw bad('当前仅开放 Temu、Amazon 美国站在线选品。')
    }
    let saved = await storedResult(env.DB, job.id, 'plan')
    if (!saved) {
      const plan = await cachedPlan(env.DB, job, input, s)
      await saveStep(env.DB, job.id, 'plan', '缓存证据与执行计划', 'succeeded', plan)
      saved = plan.result
    }
    if (input.mode === 'cache') {
      await mark(
        'succeeded',
        '缓存复核已完成。范围内 ' +
          saved.sampled +
          ' 件，分层达标 ' +
          saved.matched +
          ' 件；本次未调用外部来源或模型。',
      )
      return
    }
    const connect = await sourceConfigured(env)
    const reasons = []
    if (job.kind === 'discovery') {
      if (s.platform !== 'amazon' && !s.categoryId && !s.keyword) reasons.push('需要供应商类目或关键词')
      if (!connect.geekbi) reasons.push('极鲸云待配置')
      if (Math.min(s.dataDailyPoints, input.maxDataPoints ?? Infinity) < 10) reasons.push('积分预算不足')
    } else {
      if (!connect.openrouter) reasons.push('OpenRouter 待配置')
      if (Math.min(s.aiDailyMicros, input.maxAiMicros ?? Infinity) < 3000) reasons.push('AI 预算不足')
    }
    if (reasons.length) {
      await saveStep(env.DB, job.id, 'preflight', '执行条件检查', 'skipped', {
        summary: reasons.join('；'),
        result: { reasons },
      })
      await mark(
        'partial',
        reasons.join('；') + '。已保留缓存复核计划；调整策略预算后请按新版本创建任务。',
      )
      return
    }
    try {
      await env.RUNNER.create({ id: instanceId(job), params: { runId: job.id } })
    } catch {
      // A lost create response can still mean an accepted instance. Inspect the stable ID first.
      const existing = await env.RUNNER.get(instanceId(job))
        .then(async (instance) => instance.status())
        .catch(() => null)
      if (!existing || existing.status === 'unknown')
        await mark('failed', '后台工作流未能确认启动，请补跑')
    }
  } catch (error) {
    await mark('failed', error instanceof PublicError ? error.message : '生成执行计划失败')
    if (error instanceof PublicError) throw error
  }
}
export async function createJob(
  env: OpsBindings,
  spec: NewJob,
  actor: string,
  lease?: string,
  parent?: JobRow,
) {
  const { version } = await currentStrategy(env.DB, parent?.strategy_version)
  const id = crypto.randomUUID(),
    time = now(),
    input = JSON.stringify(spec.inputs)
  const key =
    lease ??
    actor +
      ':' +
      (spec.requestId ?? (await hash(businessClock().slice(0, 10) + version + spec.kind + input)))
  const title = (
    spec.inputs.goal || (spec.kind === 'discovery' ? '条件发现与重点更新' : '指定商品研究')
  ).slice(0, 100)
  await env.DB.prepare(`INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at,parent_id)
    VALUES(?,?,'queued',?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`)
    .bind(id, spec.kind, title, version, input, actor, key, time, time, parent?.id ?? null)
    .run()
  const job = await env.DB.prepare('SELECT * FROM job_runs WHERE request_key=?')
    .bind(key)
    .first<JobRow>()
  if (!job) throw new Error('任务入库失败')
  if (job.inputs_json !== input || job.kind !== spec.kind)
    throw new PublicError('CONFLICT', '同一提交编号已经用于不同输入', 409)
  if (job.status === 'queued') await setupRun(env, job)
  const latest = await getRun(env.DB, job.id)
  return { id: latest.id, status: latest.status }
}
export async function jobAction(
  env: OpsBindings,
  id: string,
  action: string,
  canManageSchedule = false,
) {
  const job = await getRun(env.DB, id)
  if (!canManageSchedule && (await isTeamSchedule(env.DB, job)))
    throw new PublicError('FORBIDDEN', '只有管理员可以操作团队调度任务。', 403)
  const target: Record<string, Record<string, string>> = {
    pause: { queued: 'paused', running: 'pausing' },
    resume: { paused: 'queued' },
    cancel: { queued: 'cancelled', running: 'cancelling', paused: 'cancelled', pausing: 'cancelling' },
    retry: { failed: 'queued', partial: 'queued' },
  }
  if (!Object.hasOwn(target, action)) throw bad('不支持的任务操作')
  const next = target[action][job.status]
  if (!next) throw new PublicError('CONFLICT', '当前任务状态无法执行此操作', 409)
  const msg: Record<string, string> = {
    pause: '已请求暂停，在途请求将完成落账',
    cancel: '已请求取消，在途请求将完成落账',
    resume: '已恢复待处理步骤',
    retry: '已提交补跑，复用已完成步骤',
  }
  const result = await env.DB.prepare(
    'UPDATE job_runs SET status=?,summary=?,attempt=attempt+?,updated_at=? WHERE id=? AND status=? AND attempt=?',
  )
    .bind(next, msg[action], next === 'queued' ? 1 : 0, now(), id, job.status, job.attempt)
    .run()
  if (!result.meta.changes) throw new PublicError('CONFLICT', '任务状态已更新，请刷新', 409)
  if (next === 'queued') await setupRun(env, await getRun(env.DB, id))
  return { id, status: (await getRun(env.DB, id)).status }
}
export async function runSchedule(env: OpsBindings, time: number) {
  const { settings: s } = await currentStrategy(env.DB),
    local = businessClock(time)
  if (!s.scheduleEnabled || !s.scheduleTime || local.slice(11, 16) < s.scheduleTime) return
  if (s.schedulePreset !== 'potential' && !['temu','amazon'].includes(s.platform)) return
  const key = 'cron:daily:US:' + local.slice(0, 10)
  // Catch up a missed minute until the end of the same business day.
  const prior = await env.DB.prepare('SELECT id,status FROM job_runs WHERE request_key=?')
    .bind(key)
    .first<{ id: string; status: string }>()
  if (prior) {
    if (prior.status === 'queued') await setupRun(env, await getRun(env.DB, prior.id))
    return
  }
  const inputs: JobInput = s.schedulePreset === 'potential'
    ? { mode: 'live', preset: 'potential', goal: '团队默认 · 潜力新品' } : { mode: 'live' }
  await createJob(env, { kind: 'discovery', inputs }, 'scheduler', key)
}
