import { PublicError } from '../contracts/errors'
import type { OpsBindings } from '../operations/model'
import { investigationUsage } from './budget'
import { assistantOnlineView } from './online'
import { privateEvidenceLostSql } from './policy'
import { persistInvestigationReport } from './report'

export interface AssistantBindings extends OpsBindings {
  ASSISTANT_RUNNER?: Workflow<{ runId: string; attempt: number }>
}
export const assistantLimits = {
  modelSteps: 12,
  toolSteps: 24,
  products: 10,
  activeMs: 1200000,
  dataPoints: 0,
  aiMicros: 360000,
}
export type AssistantLimits = typeof assistantLimits
export type AssistantRunRow = {
  id: string
  account_id: string
  conversation_id: string
  origin_turn_id: string
  goal: string
  context_json: string
  scope_version: number
  policy_version: string
  status: string
  limits_json: string
  model_steps: number
  tool_steps: number
  active_ms: number
  attempt: number
  version: number
  workflow_started: number
  wake_requested: number
  lease_token: string | null
  lease_until: number | null
  report_json: string | null
  summary: string
  created_at: string
  updated_at: string
}
export const terminalRun = (status: string) =>
  ['cancelled', 'succeeded', 'partial', 'failed'].includes(status)
const unavailable = () => new PublicError('NOT_FOUND', '找不到这次调查。', 404)
export async function currentRunActor(db: D1Database, accountId: string) {
  const account = await db
    .prepare('SELECT id,username,role,position FROM accounts WHERE id=? AND active=1')
    .bind(accountId)
    .first<{ id: string; username: string; role: 'viewer' | 'operator' | 'admin'; position: null }>()
  if (!account) throw new PublicError('FORBIDDEN', '账号已停用，调查已停止。', 403)
  return { ...account, email: account.username, local: false }
}
export async function assistantRunRow(db: D1Database, id: string) {
  const row = await db
    .prepare('SELECT * FROM assistant_runs WHERE id=?')
    .bind(id)
    .first<AssistantRunRow>()
  if (!row) throw unavailable()
  return row
}
export async function readAssistantRun(
  env: Pick<AssistantBindings, 'DB'>,
  accountId: string,
  id: string,
) {
  await currentRunActor(env.DB, accountId)
  const row = await assistantRunRow(env.DB, id)
  if (row.account_id !== accountId) throw unavailable()
  const turn = await env.DB.prepare(
    'SELECT t.answer FROM assistant_turns t JOIN assistant_conversations c ON c.id=t.conversation_id WHERE c.id=? AND c.account_id=? AND t.id=?',
  )
    .bind(row.conversation_id, accountId, row.origin_turn_id)
    .first<{ answer: string | null }>()
  if (!turn) throw unavailable()
  const [usage, online, messages, versions] = await Promise.all([
    investigationUsage(env.DB, id),
    assistantOnlineView(env.DB, id),
    env.DB.prepare(
      "SELECT id,message,state,created_at createdAt FROM assistant_messages WHERE run_id=? AND intent='continue' ORDER BY seq",
    )
      .bind(id)
      .all(),
    env.DB.prepare(
      'SELECT revision,scope_version scopeVersion,answer,created_at generatedAt FROM assistant_report_versions WHERE run_id=? ORDER BY revision',
    )
      .bind(id)
      .all(),
  ])
  const report = row.report_json ? JSON.parse(row.report_json) : null
  const lost = !!(await env.DB.prepare('SELECT 1 WHERE ' + privateEvidenceLostSql('?1'))
    .bind(id)
    .first())
  const restricted = '任务查看权限已变化，旧报告暂不可展示，请重新调查。'
  return {
    id: row.id,
    status: row.status,
    attempt: row.attempt,
    scopeVersion: row.scope_version,
    goal: row.goal,
    conversationId: row.conversation_id,
    originTurnId: row.origin_turn_id,
    modelSteps: row.model_steps,
    toolSteps: row.tool_steps,
    activeMs: row.active_ms,
    limits: JSON.parse(row.limits_json) as AssistantLimits,
    summary: lost ? restricted : row.summary,
    answer: lost ? restricted : (turn.answer ?? report?.summary ?? null),
    report: lost ? null : report,
    usage,
    ...(lost ? { proposals: online.proposals, linkedJobs: [] } : online),
    messages: messages.results,
    reportVersions: lost ? [] : versions.results,
    updatedAt: row.updated_at,
  }
}
async function startWorkflow(env: AssistantBindings, row: AssistantRunRow) {
  if (row.workflow_started || row.status !== 'queued') return
  // Replaying a submission always targets the same instance; it cannot create another paid attempt.
  if (!env.ASSISTANT_RUNNER) throw new PublicError('UNAVAILABLE', '后台调查尚未配置。', 503)
  const id = 'assistant-' + row.id + '-' + row.attempt
  try {
    await env.ASSISTANT_RUNNER.create({ id, params: { runId: row.id, attempt: row.attempt } })
  } catch (error) {
    // A lost create acknowledgement is recovered using the same Workflow instance.
    try {
      const existing = await (await env.ASSISTANT_RUNNER.get(id)).status()
      if (
        !['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'complete'].includes(
          existing.status,
        )
      )
        throw error
    } catch {
      throw error
    }
  }
  await env.DB.prepare('UPDATE assistant_runs SET workflow_started=1 WHERE id=? AND attempt=?')
    .bind(row.id, row.attempt)
    .run()
}
export async function wakeAssistantRun(env: AssistantBindings, id: string) {
  if (
    !(await env.DB.prepare(
      'SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id JOIN assistant_conversations c ON c.id=r.conversation_id WHERE r.id=? AND a.active=1 AND c.account_id=a.id',
    )
      .bind(id)
      .first())
  )
    return
  let row = await assistantRunRow(env.DB, id)
  if (row.lease_token && (row.lease_until ?? 0) > Date.now()) return
  if (row.wake_requested && row.status === 'queued') {
    await env.DB.prepare(`UPDATE assistant_runs SET attempt=attempt+1,workflow_started=0,wake_requested=0,version=version+1
      WHERE id=? AND version=? AND status='queued' AND wake_requested=1 AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(id, row.version, Date.now())
      .run()
    row = await assistantRunRow(env.DB, id)
  }
  await startWorkflow(env, row)
}
export async function createAssistantRun(
  env: AssistantBindings,
  accountId: string,
  conversationId: string,
  turnId: string,
  goal: string,
  context: unknown,
) {
  await currentRunActor(env.DB, accountId)
  if (!goal.trim() || goal.length > 2000)
    throw new PublicError('INVALID_INPUT', '请提供不超过 2000 字的调查目标。', 400)
  const snapshot = typeof context === 'string' ? context : JSON.stringify(context ?? {})
  if (new TextEncoder().encode(snapshot).length > 16000)
    throw new PublicError('INVALID_INPUT', '调查上下文过长，请缩小范围。', 400)
  const timestamp = new Date().toISOString()
  await env.DB.prepare(`INSERT INTO assistant_runs(id,account_id,conversation_id,origin_turn_id,goal,context_json,status,limits_json,created_at,updated_at)
 SELECT ?1,?2,?3,?4,?5,?6,'queued',?7,?8,?8 WHERE EXISTS(SELECT 1 FROM assistant_conversations c JOIN assistant_turns t ON t.conversation_id=c.id WHERE c.id=?3 AND c.account_id=?2 AND t.id=?4)
 ON CONFLICT(conversation_id,origin_turn_id) DO NOTHING`)
    .bind(
      crypto.randomUUID(),
      accountId,
      conversationId,
      turnId,
      goal.trim(),
      snapshot,
      JSON.stringify(assistantLimits),
      timestamp,
    )
    .run()
  const row = await env.DB.prepare(
    'SELECT * FROM assistant_runs WHERE conversation_id=? AND origin_turn_id=? AND account_id=?',
  )
    .bind(conversationId, turnId, accountId)
    .first<AssistantRunRow>()
  if (!row) throw unavailable()
  if ((JSON.parse(row.context_json).originalGoal ?? row.goal) !== goal.trim())
    throw new PublicError('CONFLICT', '同一条消息的调查目标不能改变。', 409)
  await env.DB.prepare(
    "UPDATE assistant_turns SET context_json=json_set(context_json,'$.runId',?) WHERE conversation_id=? AND id=?",
  )
    .bind(row.id, conversationId, turnId)
    .run()
  await startWorkflow(env, row)
  return readAssistantRun(env, accountId, row.id)
}
export async function controlAssistantRun(
  env: AssistantBindings,
  accountId: string,
  id: string,
  action: 'pause' | 'resume' | 'cancel',
) {
  await readAssistantRun(env, accountId, id)
  const row = await assistantRunRow(env.DB, id)
  if (action === 'resume') {
    if (!['paused', 'queued'].includes(row.status))
      throw new PublicError('CONFLICT', '当前调查不能继续。', 409)
    if (row.status !== 'queued')
      await env.DB.prepare(
        "UPDATE assistant_runs SET status='queued',attempt=attempt+1,workflow_started=0,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND (lease_until IS NULL OR lease_until<=?)",
      )
        .bind(new Date().toISOString(), id, row.version, Date.now())
        .run()
    await startWorkflow(env, await assistantRunRow(env.DB, id))
  } else if (!terminalRun(row.status)) {
    const live = !!row.lease_token && (row.lease_until ?? 0) > Date.now()
    const status = action === 'pause' ? (live ? 'pausing' : 'paused') : live ? 'cancelling' : 'cancelled'
    await env.DB.prepare(
      'UPDATE assistant_runs SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?',
    )
      .bind(status, new Date().toISOString(), id, row.version)
      .run()
    if (!live && action === 'cancel')
      await persistInvestigationReport(env, row, 'cancelled', '调查已取消，已保存此前步骤和费用记录。')
  }
  return readAssistantRun(env, accountId, id)
}
