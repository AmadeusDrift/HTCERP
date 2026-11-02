import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { createJob, hash, jobAction } from '../operations/jobs'
import { businessClock, type JobInput, type NewJob } from '../operations/model'
import { investigationSpentSql } from './budget'
import { productIdSchema } from './contracts'
import { type AssistantBindings, type AssistantRunRow, assistantRunRow, currentRunActor } from './runs'
import { runReadTool } from './tools'

const integer = (n: number) => z.number().int().min(0).max(n)
export const onlineActionSchema = z
  .object({
    operation: z.enum([
      'discovery',
      'product_refresh',
      'research',
      'amazon_backfill',
      'reviews_refresh',
    ]),
    productId: productIdSchema.optional(),
    platform: z.enum(['temu', 'amazon']).optional(),
    keyword: z.string().trim().max(150).default(''),
    categoryId: z
      .string()
      .regex(/^(?:home|\d{1,20})?$/)
      .default(''),
    maxPrice: z.number().nonnegative().max(1000000).nullable().default(null),
    minSold: integer(1000000000).default(0),
    pages: integer(20).min(1).default(1),
    calls: integer(200).min(1),
    childResearch: integer(3).default(0),
    maxDataPoints: integer(100000),
    maxAiMicros: integer(100000000),
    writeWatchPool: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.productId && v.platform && v.productId.split(':')[0] !== v.platform)
      ctx.addIssue({ code: 'custom', message: '商品编号与平台不一致。' })
    if (v.operation === 'discovery' && v.productId)
      ctx.addIssue({ code: 'custom', message: '在线发现使用明确检索范围，请将指定商品更新另列为动作。' })
    if (v.operation === 'discovery' && v.platform === 'amazon' && v.categoryId === 'home')
      ctx.addIssue({ code: 'custom', message: 'Temu 家居类目不能用于 Amazon 发现。' })
    if (v.operation !== 'discovery' && !v.productId)
      ctx.addIssue({ code: 'custom', message: '该动作需要指定商品。' })
    if (v.productId && !/^(temu|amazon):/.test(v.productId))
      ctx.addIssue({ code: 'custom', message: '当前在线动作仅支持 Temu、Amazon 美国站。' })
    if (v.operation === 'discovery' && !(v.keyword || v.categoryId))
      ctx.addIssue({ code: 'custom', message: '在线发现需要明确关键词或类目。' })
    if (v.operation !== 'discovery' && (v.pages !== 1 || v.childResearch !== 0))
      ctx.addIssue({ code: 'custom', message: '该动作只执行指定商品，不额外发现或派生研究。' })
    const points =
      v.operation === 'discovery'
        ? v.pages * 10
        : v.operation === 'product_refresh' ||
            (v.operation === 'reviews_refresh' && v.productId?.startsWith('temu:'))
          ? 10
          : 0
    const micros =
      v.operation === 'research'
        ? 33000
        : v.operation === 'reviews_refresh' && v.productId?.startsWith('temu:')
          ? 30000
          : v.childResearch * 33000
    if (v.maxDataPoints < points || v.maxAiMicros < micros)
      ctx.addIssue({ code: 'custom', message: '动作额度低于已声明操作的最坏情况上限。' })
    if (!['research', 'discovery'].includes(v.operation) && v.writeWatchPool)
      ctx.addIssue({ code: 'custom', message: '此动作不会写入观察池。' })
  })
export const proposalSchema = z
  .object({
    actions: z.array(onlineActionSchema).min(1).max(10),
    maxDataPoints: integer(100000),
    maxAiMicros: integer(100000000),
    expiresInMinutes: integer(60).min(1).default(30),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.actions.reduce((n, a) => n + a.maxDataPoints, 0) > v.maxDataPoints ||
      v.actions.reduce((n, a) => n + a.maxAiMicros, 0) > v.maxAiMicros
    )
      ctx.addIssue({ code: 'custom', message: '子任务额度超过整次调查上限。' })
  })
export type OnlineProposal = z.infer<typeof proposalSchema>
export type OnlineAction = z.infer<typeof onlineActionSchema>
type ProposalRow = {
  id: string
  run_id: string
  scope_version: number
  action_key: string
  spec_json: string
  status: string
  expires_at: string
  confirmed_at: string | null
}
export type AssistantJobLink = {
  id: string
  run_id: string
  proposal_id: string
  scope_version: number
  action_key: string
  request_id: string
  job_id: string | null
  operation: string
  input_json: string
  allocated_points: number
  allocated_micros: number
  calls_limit: number
  calls_used: number
  state: string
  wait_until: string
  result_json: string | null
}
const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
async function owner(
  env: Pick<AssistantBindings, 'DB'>,
  accountId: string,
  id: string,
  writable = false,
) {
  const row = await assistantRunRow(env.DB, id)
  if (
    row.account_id !== accountId ||
    !(await env.DB.prepare('SELECT 1 FROM assistant_conversations WHERE id=? AND account_id=?')
      .bind(row.conversation_id, accountId)
      .first())
  )
    throw new PublicError('NOT_FOUND', '找不到这次调查。', 404)
  const actor = await currentRunActor(env.DB, accountId)
  if (writable && actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '当前账号仅可查询，不能确认在线动作。', 403)
  return { row, actor }
}
export async function assistantOnlineView(db: D1Database, id: string) {
  const proposals = await db
    .prepare('SELECT * FROM assistant_proposals WHERE run_id=? ORDER BY created_at,id')
    .bind(id)
    .all<ProposalRow>()
  const links = await db
    .prepare('SELECT * FROM assistant_job_links WHERE run_id=? ORDER BY created_at,id')
    .bind(id)
    .all<AssistantJobLink>()
  return {
    proposals: proposals.results.map((p) => ({
      id: p.id,
      scopeVersion: p.scope_version,
      actionKey: p.action_key,
      status: p.status,
      expiresAt: p.expires_at,
      ...JSON.parse(p.spec_json),
    })),
    linkedJobs: links.results.map((l) => ({
      id: l.id,
      jobId: l.job_id,
      scopeVersion: l.scope_version,
      operation: l.operation,
      status: l.state,
      allocatedDataPoints: l.allocated_points,
      allocatedAiMicros: l.allocated_micros,
      calls: l.calls_limit,
      callsUsed: l.calls_used,
      waitUntil: l.wait_until,
      summary: (l as AssistantJobLink & { summary: string }).summary,
    })),
  }
}
export async function createAssistantProposal(
  env: AssistantBindings,
  accountId: string,
  id: string,
  value: unknown,
) {
  const { row } = await owner(env, accountId, id),
    spec = proposalSchema.parse(value),
    serialized = JSON.stringify(spec),
    key = 'online-' + (await hash(serialized))
  if (
    await env.DB.prepare(
      "SELECT 1 FROM assistant_job_links l LEFT JOIN job_runs j ON j.id=l.job_id WHERE l.run_id=? AND l.state IN ('pending','submitted','uncertain') AND (l.job_id IS NULL OR j.status NOT IN ('succeeded','partial','failed','cancelled')) LIMIT 1",
    )
      .bind(id)
      .first()
  )
    throw conflict('后台子任务尚在执行，请等待完成或发送补充条件。')
  if (['cancelled', 'cancelling', 'paused', 'pausing', 'failed'].includes(row.status))
    throw conflict('这次调查不能新增在线提案。')
  const time = new Date().toISOString(),
    expires = new Date(Date.now() + spec.expiresInMinutes * 60000).toISOString()
  await env.DB.prepare(
    "INSERT INTO assistant_proposals(id,run_id,scope_version,action_key,spec_json,status,expires_at,created_at) SELECT ?,?,?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM assistant_runs WHERE id=? AND scope_version=?) ON CONFLICT(run_id,scope_version,action_key) DO NOTHING",
  )
    .bind(
      crypto.randomUUID(),
      id,
      row.scope_version,
      key,
      serialized,
      expires,
      time,
      id,
      row.scope_version,
    )
    .run()
  const proposal = await env.DB.prepare(
    'SELECT * FROM assistant_proposals WHERE run_id=? AND scope_version=? AND action_key=?',
  )
    .bind(id, row.scope_version, key)
    .first<ProposalRow>()
  if (!proposal) throw conflict('调查范围已变化，请重新生成提案。')
  let status = proposal.status
  if (status === 'pending' && proposal.expires_at <= time) {
    status = 'expired'
    await env.DB.prepare(
      "UPDATE assistant_proposals SET status='expired' WHERE id=? AND status='pending'",
    )
      .bind(proposal.id)
      .run()
  }
  if (status === 'pending')
    await env.DB.prepare(
      "UPDATE assistant_runs SET status='awaiting_confirmation',version=version+1 WHERE id=? AND scope_version=? AND status IN ('running','queued','awaiting_confirmation','succeeded','partial')",
    )
      .bind(id, row.scope_version)
      .run()
  return {
    id: proposal.id,
    scopeVersion: proposal.scope_version,
    status,
    expiresAt: proposal.expires_at,
    ...spec,
  }
}
export async function confirmAssistantProposal(
  env: AssistantBindings,
  accountId: string,
  id: string,
  proposalId: string,
) {
  const { row, actor } = await owner(env, accountId, id, true),
    p = await env.DB.prepare('SELECT * FROM assistant_proposals WHERE id=? AND run_id=?')
      .bind(proposalId, id)
      .first<ProposalRow>()
  if (!p) throw conflict('找不到这项提案。')
  if (p.status === 'confirmed') return assistantOnlineView(env.DB, id)
  if (
    p.status !== 'pending' ||
    p.scope_version !== row.scope_version ||
    p.expires_at <= new Date().toISOString()
  )
    throw conflict('提案已拒绝、过期或调查范围已变化，请重新生成。')
  const spec = proposalSchema.parse(JSON.parse(p.spec_json)),
    points = spec.actions.reduce((n, a) => n + a.maxDataPoints, 0),
    micros = spec.actions.reduce((n, a) => n + a.maxAiMicros, 0),
    time = new Date().toISOString(),
    day = businessClock().slice(0, 10),
    token = crypto.randomUUID()
  if (spec.actions.some((a) => a.operation === 'reviews_refresh') && actor.role !== 'admin')
    throw new PublicError('FORBIDDEN', '仅管理员可确认评论更新。', 403)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE assistant_proposals SET status='confirmed',confirmed_at=?1,confirmation_token=?12 WHERE id=?2 AND run_id=?3 AND status='pending' AND scope_version=?4 AND expires_at>?1
 AND EXISTS(SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id WHERE r.id=?3 AND r.account_id=?5 AND a.active=1 AND a.role IN ('operator','admin') AND EXISTS(SELECT 1 FROM assistant_conversations WHERE id=r.conversation_id AND account_id=r.account_id) AND r.scope_version=?4 AND r.status IN ('running','queued','awaiting_confirmation')
 AND (NOT EXISTS(SELECT 1 FROM json_each(?11,'$.actions') WHERE json_extract(value,'$.operation')='reviews_refresh') OR a.role='admin')
 AND NOT EXISTS(SELECT 1 FROM assistant_messages WHERE run_id=r.id AND state='pending' AND intent='continue')
 AND ?6+${investigationSpentSql('points', 'r.id')}<=?8 AND ?7+${investigationSpentSql('micros', 'r.id')}<=?9)
 AND ?6+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='points' AND business_date=?10)+(SELECT COALESCE(SUM(MAX(0,l.allocated_points-(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE assistant_link_id=l.id AND unit='points'))),0) FROM assistant_job_links l WHERE l.business_date=?10 AND l.state IN ('pending','submitted','uncertain'))<=(SELECT json_extract(settings_json,'$.dataDailyPoints') FROM strategy_versions ORDER BY version DESC LIMIT 1)
 AND ?7+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='micros' AND business_date=?10)+(SELECT COALESCE(SUM(MAX(0,l.allocated_micros-(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE assistant_link_id=l.id AND unit='micros'))),0) FROM assistant_job_links l WHERE l.business_date=?10 AND l.state IN ('pending','submitted','uncertain'))<=(SELECT json_extract(settings_json,'$.aiDailyMicros') FROM strategy_versions ORDER BY version DESC LIMIT 1)`).bind(
      time,
      proposalId,
      id,
      row.scope_version,
      accountId,
      points,
      micros,
      spec.maxDataPoints,
      spec.maxAiMicros,
      day,
      JSON.stringify(spec),
      token,
    ),
    env.DB.prepare(
      "UPDATE assistant_runs SET limits_json=json_set(limits_json,'$.dataPoints',?,'$.aiMicros',?),wake_requested=CASE WHEN status IN ('awaiting_confirmation','awaiting_input','succeeded','partial','failed') THEN 1 ELSE wake_requested END,status='queued',version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM assistant_proposals WHERE id=? AND status='confirmed' AND confirmation_token=?)",
    ).bind(spec.maxDataPoints, spec.maxAiMicros, id, proposalId, token),
  ]
  for (let index = 0; index < spec.actions.length; index++) {
    const action = spec.actions[index],
      linkId = await hash(proposalId + ':' + index),
      requestId = 'assistant-' + linkId
    statements.push(
      env.DB.prepare(
        "INSERT INTO assistant_job_links(id,run_id,proposal_id,scope_version,action_key,request_id,operation,input_json,allocated_points,allocated_micros,calls_limit,state,business_date,created_at,updated_at,wait_until) SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_proposals WHERE id=? AND status='confirmed' AND confirmation_token=?) ON CONFLICT(run_id,scope_version,action_key) DO NOTHING",
      ).bind(
        linkId,
        id,
        proposalId,
        row.scope_version,
        p.action_key + ':' + index,
        requestId,
        action.operation,
        JSON.stringify(action),
        action.maxDataPoints,
        action.maxAiMicros,
        action.calls,
        day,
        time,
        time,
        new Date(Date.now() + 3600000).toISOString(),
        proposalId,
        token,
      ),
    )
  }
  const [confirmed] = await env.DB.batch(statements)
  if (!confirmed.meta.changes) {
    const latest = await env.DB.prepare('SELECT status FROM assistant_proposals WHERE id=?')
      .bind(proposalId)
      .first<{ status: string }>()
    if (latest?.status !== 'confirmed')
      throw conflict('提案已变化、预算不足或有待处理补充，未提交任何在线请求。')
  }
  return assistantOnlineView(env.DB, id)
}
export async function rejectAssistantProposal(
  env: AssistantBindings,
  accountId: string,
  id: string,
  proposalId: string,
) {
  await owner(env, accountId, id)
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE assistant_proposals SET status='rejected' WHERE id=? AND run_id=? AND status='pending'",
    ).bind(proposalId, id),
    env.DB.prepare(
      "UPDATE assistant_runs SET status='queued',wake_requested=1,version=version+1 WHERE changes()=1 AND id=? AND status='awaiting_confirmation' AND NOT EXISTS(SELECT 1 FROM assistant_proposals WHERE run_id=? AND status='pending')",
    ).bind(id, id),
  ])
  return assistantOnlineView(env.DB, id)
}
function jobSpec(action: OnlineAction, goal: string): NewJob {
  const inputs: JobInput = {
    mode: 'live',
    goal: goal.slice(0, 1500),
    platform: (action.productId?.split(':')[0] ?? action.platform ?? 'temu') as 'temu' | 'amazon',
    productId: action.productId,
    keyword: action.keyword,
    categoryId: action.categoryId,
    maxPrice: action.maxPrice,
    tiers: [action.minSold],
    pageLimit: action.pages,
    maxDataPoints: action.maxDataPoints,
    maxAiMicros: action.operation === 'discovery' ? 0 : action.maxAiMicros,
    writeWatchPool: action.writeWatchPool,
    ...(['product_refresh', 'amazon_backfill', 'reviews_refresh'].includes(action.operation)
      ? { operation: action.operation as JobInput['operation'] }
      : {}),
  }
  return { kind: action.operation === 'discovery' ? 'discovery' : 'research', inputs }
}
export async function submitAssistantJobs(env: AssistantBindings, row: AssistantRunRow) {
  const links = await env.DB.prepare(
    "SELECT * FROM assistant_job_links WHERE run_id=? AND scope_version=? AND state IN ('pending','uncertain','submitted') ORDER BY created_at,id",
  )
    .bind(row.id, row.scope_version)
    .all<AssistantJobLink>()
  if (!links.results.length) return 0
  const actor = await currentRunActor(env.DB, row.account_id)
  if (actor.role === 'viewer') throw new PublicError('FORBIDDEN', '当前角色不能提交在线动作。', 403)
  let count = 0
  for (const link of links.results) {
    const valid = await env.DB.prepare(
      "SELECT 1 FROM assistant_job_links l JOIN assistant_proposals p ON p.id=l.proposal_id JOIN assistant_runs r ON r.id=l.run_id JOIN accounts a ON a.id=r.account_id JOIN assistant_conversations c ON c.id=r.conversation_id AND c.account_id=r.account_id WHERE l.id=? AND p.status='confirmed' AND p.expires_at>? AND l.scope_version=r.scope_version AND a.active=1 AND a.role IN ('operator','admin') AND (l.operation!='reviews_refresh' OR a.role='admin') AND r.status IN ('queued','running','waiting_jobs') AND NOT EXISTS(SELECT 1 FROM assistant_messages WHERE run_id=r.id AND state='pending' AND intent='continue')",
    )
      .bind(link.id, new Date().toISOString())
      .first()
    if (!valid) continue
    if (link.job_id) {
      const child = await env.DB.prepare('SELECT status FROM job_runs WHERE id=?')
        .bind(link.job_id)
        .first<{ status: string }>()
      if (child?.status === 'paused') {
        await jobAction(env, link.job_id, 'resume')
        count++
      }
      continue
    }
    const action = onlineActionSchema.parse(JSON.parse(link.input_json))
    if (action.operation === 'reviews_refresh' && actor.role !== 'admin')
      throw new PublicError('FORBIDDEN', '仅管理员可更新评论分析。', 403)
    try {
      await createJob(
        env,
        { ...jobSpec(action, row.goal), requestId: link.request_id },
        actor.email,
        undefined,
        undefined,
        link.id,
      )
      count++
    } catch {
      await env.DB.prepare(
        "UPDATE assistant_job_links SET state='uncertain',summary=?,updated_at=? WHERE id=? AND job_id IS NULL",
      )
        .bind('提交未能确认，保留分配额度并使用相同提交编号恢复。', new Date().toISOString(), link.id)
        .run()
    }
  }
  return count
}
async function discoveryChildren(env: AssistantBindings, row: AssistantRunRow, link: AssistantJobLink) {
  const action = onlineActionSchema.parse(JSON.parse(link.input_json))
  if (
    link.operation !== 'discovery' ||
    !action.childResearch ||
    link.scope_version !== row.scope_version ||
    (link as AssistantJobLink & { children_materialized: number }).children_materialized
  )
    return
  const count = Math.min(action.childResearch, Math.floor((link.calls_limit - link.calls_used) / 8))
  const products = await env.DB.prepare(
    'SELECT product_id FROM job_seen WHERE run_id=? AND tier IS NOT NULL ORDER BY tier DESC,total_sold DESC,product_id LIMIT ?',
  )
    .bind(link.job_id, count)
    .all<{ product_id: string }>()
  const time = new Date().toISOString(),
    statements: D1PreparedStatement[] = []
  for (const product of products.results) {
    const child: OnlineAction = {
      ...action,
      operation: 'research',
      productId: product.product_id,
      pages: 1,
      calls: 8,
      childResearch: 0,
      maxDataPoints: 0,
      maxAiMicros: 33000,
    }
    const childId = await hash(link.id + ':research:' + product.product_id)
    statements.push(
      env.DB.prepare(
        "INSERT INTO assistant_job_links(id,run_id,proposal_id,scope_version,action_key,request_id,operation,input_json,allocated_points,allocated_micros,calls_limit,state,business_date,created_at,updated_at,wait_until) SELECT ?,?,?,?,?,?,'research',?,0,33000,8,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_job_links l JOIN assistant_runs r ON r.id=l.run_id JOIN assistant_proposals p ON p.id=l.proposal_id JOIN accounts a ON a.id=r.account_id JOIN assistant_conversations c ON c.id=r.conversation_id AND c.account_id=r.account_id WHERE l.id=? AND l.state='submitted' AND l.children_materialized=0 AND r.scope_version=l.scope_version AND p.status='confirmed' AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.active=1 AND a.role IN ('operator','admin') AND NOT EXISTS(SELECT 1 FROM assistant_messages WHERE run_id=r.id AND state='pending' AND intent='continue')) ON CONFLICT(run_id,scope_version,action_key) DO NOTHING",
      ).bind(
        childId,
        row.id,
        link.proposal_id,
        link.scope_version,
        link.action_key + ':research:' + product.product_id,
        'assistant-' + childId,
        JSON.stringify(child),
        businessClock().slice(0, 10),
        time,
        time,
        link.wait_until,
        link.id,
      ),
    )
  }
  // All allocations were authorized in the discovery proposal. Split the existing AI hold atomically.
  statements.push(
    env.DB.prepare(
      "UPDATE assistant_job_links SET allocated_micros=0,calls_limit=calls_limit-?,children_materialized=1 WHERE id=? AND state='submitted' AND children_materialized=0",
    ).bind(products.results.length * 8, link.id),
  )
  await env.DB.batch(statements)
}
export async function collectAssistantJobs(env: AssistantBindings, row: AssistantRunRow) {
  const links = await env.DB.prepare(
    "SELECT l.*,j.status job_status,j.summary job_summary FROM assistant_job_links l LEFT JOIN job_runs j ON j.id=l.job_id WHERE l.run_id=? AND l.state IN ('pending','submitted','uncertain') ORDER BY l.created_at,l.id",
  )
    .bind(row.id)
    .all<AssistantJobLink & { job_status: string | null; job_summary: string | null }>()
  let waiting = false,
    collected = 0,
    timedOut = false
  for (const link of links.results) {
    if (!link.job_id) {
      const stillValid = await env.DB.prepare(
        "SELECT 1 FROM assistant_proposals p JOIN assistant_runs r ON r.id=p.run_id WHERE p.id=? AND p.status='confirmed' AND p.scope_version=r.scope_version AND p.expires_at>?",
      )
        .bind(link.proposal_id, new Date().toISOString())
        .first()
      if (!stillValid)
        await env.DB.prepare(
          "UPDATE assistant_job_links SET state='settled',summary='未提交动作的授权已失效，释放未使用分配。' WHERE id=? AND job_id IS NULL",
        )
          .bind(link.id)
          .run()
      else waiting = true
      continue
    }
    const authorized = await env.DB.prepare(
      "SELECT 1 FROM assistant_job_links l JOIN assistant_proposals p ON p.id=l.proposal_id JOIN assistant_runs r ON r.id=l.run_id JOIN accounts a ON a.id=r.account_id JOIN assistant_conversations c ON c.id=r.conversation_id AND c.account_id=r.account_id WHERE l.id=? AND p.status='confirmed' AND p.expires_at>? AND l.scope_version=r.scope_version AND a.active=1 AND a.role IN ('operator','admin') AND (l.operation!='reviews_refresh' OR a.role='admin')",
    )
      .bind(link.id, new Date().toISOString())
      .first()
    if (
      (!authorized || link.scope_version !== row.scope_version) &&
      !['succeeded', 'partial', 'failed', 'cancelled'].includes(link.job_status ?? '')
    ) {
      await env.DB.prepare(
        "UPDATE job_runs SET status=CASE WHEN status IN ('running','pausing') THEN 'cancelling' ELSE 'cancelled' END,summary='调查范围已变化，停止旧授权的新请求，在途请求继续结算。' WHERE id=? AND status IN ('queued','running','paused','pausing')",
      )
        .bind(link.job_id)
        .run()
      const latest = await env.DB.prepare('SELECT status FROM job_runs WHERE id=?')
        .bind(link.job_id)
        .first<{ status: string }>()
      link.job_status = latest?.status ?? link.job_status
    }
    if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(link.job_status ?? '')) {
      if (link.wait_until <= new Date().toISOString()) {
        await env.DB.prepare(
          "UPDATE job_runs SET status=CASE WHEN status='running' THEN 'cancelling' ELSE 'cancelled' END,summary='调查等待超时，已停止新请求。' WHERE id=? AND status IN ('queued','running','paused')",
        )
          .bind(link.job_id)
          .run()
        await env.DB.prepare(
          "UPDATE assistant_job_links SET state='uncertain',summary='子任务等待超时，保留在途及未知费用。' WHERE id=?",
        )
          .bind(link.id)
          .run()
        timedOut = true
      } else waiting = true
      continue
    }
    await discoveryChildren(env, row, link)
    const actor = await currentRunActor(env.DB, row.account_id),
      result = await runReadTool(env, actor, 'read_job', { jobId: link.job_id })
    const key = 'scope-' + link.scope_version + ':collect:' + link.id
    const seq = await env.DB.prepare(
      'SELECT COALESCE(MAX(seq),0)+1 seq FROM assistant_steps WHERE run_id=?',
    )
      .bind(row.id)
      .first<{ seq: number }>()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,result_json,created_at,updated_at,scope_version) SELECT ?,?,?,'tool','read_job',?,'completed',?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_runs WHERE id=? AND tool_steps<json_extract(limits_json,'$.toolSteps')) ON CONFLICT(run_id,action_key) DO NOTHING",
      ).bind(
        row.id,
        seq!.seq,
        key,
        JSON.stringify({ jobId: link.job_id }),
        JSON.stringify({ ...result, originatingScopeVersion: link.scope_version }),
        new Date().toISOString(),
        new Date().toISOString(),
        row.scope_version,
        row.id,
      ),
      env.DB.prepare(
        'UPDATE assistant_runs SET tool_steps=tool_steps+CASE WHEN changes()=1 THEN 1 ELSE 0 END WHERE id=?',
      ).bind(row.id),
      env.DB.prepare(
        "UPDATE assistant_job_links SET state='settled',result_json=?,summary=?,updated_at=? WHERE id=?",
      ).bind(JSON.stringify(result), link.job_summary ?? '', new Date().toISOString(), link.id),
    ])
    collected++
  }
  const pending = await env.DB.prepare(
    "SELECT 1 FROM assistant_job_links WHERE run_id=? AND state='pending' LIMIT 1",
  )
    .bind(row.id)
    .first()
  return { waiting: waiting || !!pending, collected, timedOut }
}
