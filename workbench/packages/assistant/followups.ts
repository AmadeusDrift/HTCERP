import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { parse } from '../operations/model'
import {
  type AssistantBindings,
  type AssistantRunRow,
  assistantRunRow,
  createAssistantRun,
  readAssistantRun,
  wakeAssistantRun,
} from './runs'

export const assistantMessageSchema = z
  .object({
    id: z.uuid(),
    message: z.string().trim().min(1).max(2000),
    intent: z.enum(['continue', 'new']).default('continue'),
  })
  .strict()
type Message = z.infer<typeof assistantMessageSchema>
type MessageRow = {
  id: string
  message: string
  intent: string
  state: string
  destination_run_id: string | null
}

export async function ensureMessageWakeup(env: AssistantBindings, accountId: string, id: string) {
  if (
    !(await env.DB.prepare(
      'SELECT 1 FROM accounts a JOIN assistant_runs r ON r.account_id=a.id JOIN assistant_conversations c ON c.id=r.conversation_id WHERE r.id=? AND a.id=? AND a.active=1 AND c.account_id=a.id',
    )
      .bind(id, accountId)
      .first())
  )
    return
  const row = await assistantRunRow(env.DB, id)
  if (!(await hasPendingAssistantMessages(env.DB, id))) return
  if (!['running', 'queued'].includes(row.status)) {
    await env.DB.prepare(`UPDATE assistant_runs SET status='queued',wake_requested=1,version=version+1
      WHERE id=? AND version=? AND status NOT IN ('cancelled','cancelling','pausing')`)
      .bind(id, row.version)
      .run()
  }
  await wakeAssistantRun(env, id)
}

export async function hasPendingAssistantMessages(db: D1Database, id: string) {
  return !!(await db
    .prepare(
      "SELECT 1 FROM assistant_messages WHERE run_id=? AND intent='continue' AND state='pending' LIMIT 1",
    )
    .bind(id)
    .first())
}

// New goals are explicitly routed, so a second goal cannot silently replace running work.
export async function submitAssistantMessage(
  env: AssistantBindings,
  accountId: string,
  id: string,
  value: Message,
) {
  const input = parse(assistantMessageSchema, value)
  await readAssistantRun(env, accountId, id)
  const row = await assistantRunRow(env.DB, id)
  const previous = await env.DB.prepare('SELECT * FROM assistant_messages WHERE run_id=? AND id=?')
    .bind(id, input.id)
    .first<MessageRow>()
  if (previous && (previous.message !== input.message || previous.intent !== input.intent))
    throw new PublicError('CONFLICT', '同一条补充消息不能更改内容。', 409)
  if (previous && !(previous.intent === 'new' && !previous.destination_run_id)) {
    if (previous.intent === 'continue') await ensureMessageWakeup(env, accountId, id)
    return { id: input.id, runId: previous.destination_run_id ?? id, state: previous.state }
  }
  if (input.id === row.origin_turn_id)
    throw new PublicError('CONFLICT', '补充消息需要新的消息编号。', 409)
  if (input.intent === 'new') {
    const time = new Date().toISOString()
    // Claim the immutable intent before starting a second Workflow. A half-finished claim is replayable.
    await env.DB.prepare(`INSERT INTO assistant_messages(run_id,id,message,intent,state,created_at)
      SELECT ?1,?2,?3,'new','pending',?4 WHERE EXISTS(SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id WHERE r.id=?1 AND r.account_id=?5 AND a.active=1)
      ON CONFLICT(run_id,id) DO NOTHING`)
      .bind(id, input.id, input.message, time, accountId)
      .run()
    const claimed = await env.DB.prepare(
      'SELECT message,intent FROM assistant_messages WHERE run_id=? AND id=?',
    )
      .bind(id, input.id)
      .first<MessageRow>()
    if (!claimed || claimed.intent !== 'new' || claimed.message !== input.message)
      throw new PublicError('CONFLICT', '同一条消息不能同时补充和新建调查。', 409)
    const source = JSON.parse(row.context_json)
    const snapshot = JSON.stringify(
      Object.fromEntries(
        ['page', 'filters', 'jobId', 'product']
          .filter((k) => Object.hasOwn(source, k))
          .map((k) => [k, source[k]]),
      ),
    )
    await env.DB.prepare(`INSERT INTO assistant_turns(conversation_id,id,question,context_json,created_at)
      SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM assistant_conversations WHERE id=?1 AND account_id=?6)
      ON CONFLICT(conversation_id,id) DO NOTHING`)
      .bind(row.conversation_id, input.id, input.message, snapshot, time, accountId)
      .run()
    const next = await createAssistantRun(
      env,
      accountId,
      row.conversation_id,
      input.id,
      input.message,
      snapshot,
    )
    await env.DB.prepare(
      "UPDATE assistant_messages SET state='applied',destination_run_id=?,applied_at=? WHERE run_id=? AND id=? AND intent='new'",
    )
      .bind(next.id, time, id, input.id)
      .run()
    return { id: input.id, runId: next.id, state: 'applied' }
  }
  if (['cancelled', 'cancelling', 'pausing'].includes(row.status))
    throw new PublicError('CONFLICT', '这次调查已经停止，请开始新调查。', 409)
  const count = await env.DB.prepare('SELECT COUNT(*) n FROM assistant_messages WHERE run_id=?')
    .bind(id)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= 30)
    throw new PublicError('CONFLICT', '这次调查已接收 30 条补充，请开始新调查。', 409)
  const time = new Date().toISOString()
  const [saved] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_messages(run_id,id,message,intent,state,created_at)
      SELECT ?1,?2,?3,'continue','pending',?4 WHERE EXISTS(SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id
      WHERE r.id=?1 AND r.account_id=?5 AND a.active=1 AND r.status NOT IN ('cancelled','cancelling','pausing'))
      AND (SELECT COUNT(*) FROM assistant_messages WHERE run_id=?1)<30 ON CONFLICT(run_id,id) DO NOTHING`).bind(
      id,
      input.id,
      input.message,
      time,
      accountId,
    ),
    env.DB.prepare(
      'UPDATE assistant_runs SET version=version+1,updated_at=? WHERE changes()=1 AND id=?',
    ).bind(time, id),
  ])
  if (!saved.meta.changes) {
    const replay = await env.DB.prepare(
      'SELECT message,intent,state FROM assistant_messages WHERE run_id=? AND id=?',
    )
      .bind(id, input.id)
      .first<MessageRow>()
    if (!replay || replay.message !== input.message || replay.intent !== input.intent)
      throw new PublicError('CONFLICT', '调查状态或消息内容已变化，请刷新后重试。', 409)
  }
  // Wakeup is also retried after a lost response or a failed Workflow create acknowledgement.
  await ensureMessageWakeup(env, accountId, id)
  return { id: input.id, runId: id, state: 'pending' }
}

// Called while the run lease is held, before selecting a new model/tool action.
export async function applyAssistantMessages(env: Pick<AssistantBindings, 'DB'>, row: AssistantRunRow) {
  const messages = await env.DB.prepare(
    "SELECT seq,id,message,created_at FROM assistant_messages WHERE run_id=? AND intent='continue' AND state='pending' ORDER BY seq",
  )
    .bind(row.id)
    .all<{ seq: number; id: string; message: string; created_at: string }>()
  if (!messages.results.length) return row
  const context = JSON.parse(row.context_json)
  const additions = messages.results.map((m) => ({
    id: m.id,
    message: m.message,
    receivedAt: m.created_at,
  }))
  const instructions = [...(context.followups ?? []), ...additions].slice(-30)
  const baseGoal = context.originalGoal ?? row.goal
  const goal =
    baseGoal +
    '\n用户最新补充（后项优先；只改变调查条件，不增加权限或额度）：\n' +
    instructions.map((v) => v.message).join('\n')
  const time = new Date().toISOString()
  const [saved] = await env.DB.batch([
    env.DB.prepare(`UPDATE assistant_runs SET goal=?,context_json=?,scope_version=scope_version+1,version=version+1,updated_at=?
      WHERE id=? AND attempt=? AND version=? AND scope_version=? AND status NOT IN ('cancelled','cancelling','paused','pausing')`).bind(
      goal,
      JSON.stringify({ ...context, originalGoal: baseGoal, followups: instructions }),
      time,
      row.id,
      row.attempt,
      row.version,
      row.scope_version,
    ),
    env.DB.prepare(
      "UPDATE assistant_messages SET state='applied',applied_at=? WHERE changes()=1 AND run_id=? AND intent='continue' AND state='pending' AND seq<=?",
    ).bind(time, row.id, messages.results.at(-1)!.seq),
  ])
  if (saved.meta.changes) {
    // Confirmation is tied to the old scope even when a prior proposal is still visible.
    await env.DB.prepare(
      "UPDATE assistant_proposals SET status='invalidated' WHERE run_id=? AND scope_version<? AND status='pending'",
    )
      .bind(row.id, row.scope_version + 1)
      .run()
  }
  return assistantRunRow(env.DB, row.id)
}
