import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { parse } from '../operations/model'
import { assistantMessageSchema, submitAssistantMessage } from './followups'
import { missing, sanitizeImage, turnSchema, workspaceContext } from './model'
import { confirmAssistantProposal, createAssistantProposal, rejectAssistantProposal } from './online'
import { controlAssistantRun, createAssistantRun, readAssistantRun, wakeAssistantRun } from './runs'

export const investigationRoutes = new Hono<AppEnv>()
investigationRoutes.post('/conversations/:id/investigations', async (c) => {
  const actor = c.var.actor,
    db = c.env.DB
  if (actor.local) throw new PublicError('ACCOUNT_REQUIRED', '请登录工作账号后开始调查。', 403)
  if (!c.env.ASSISTANT_RUNNER) throw new PublicError('NOT_CONFIGURED', '调查功能尚未启用。', 503)
  const id = parse(z.uuid(), c.req.param('id')),
    input = parse(turnSchema, await c.req.json())
  if (input.image)
    throw new PublicError('INVALID_INPUT', '已有资料调查请使用文字目标；图片可以在普通问答中分析。', 400)
  const context = await workspaceContext(db, input),
    time = new Date().toISOString()
  const [, claim] = await db.batch([
    db
      .prepare(
        `INSERT INTO assistant_conversations(id,account_id,title,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(id, actor.id, Array.from(input.question).slice(0, 36).join(''), time),
    db
      .prepare(`INSERT INTO assistant_turns(conversation_id,id,question,context_json,image_url,created_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM assistant_conversations WHERE id=?1 AND account_id=?7)
      AND NOT EXISTS(SELECT 1 FROM assistant_turns WHERE conversation_id=?1 AND answer IS NULL AND issue IS NULL
        AND (json_extract(context_json,'$.runId') IS NOT NULL OR created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')))
      ON CONFLICT(conversation_id,id) DO NOTHING`)
      .bind(id, input.id, input.question, context, sanitizeImage(input.image), time, actor.id),
  ])
  const own = await db
    .prepare('SELECT 1 FROM assistant_conversations WHERE id=? AND account_id=?')
    .bind(id, actor.id)
    .first()
  if (!own) throw missing()
  const turn = await db
    .prepare('SELECT context_json,question FROM assistant_turns WHERE conversation_id=? AND id=?')
    .bind(id, input.id)
    .first<{ context_json: string; question: string }>()
  if (!claim.meta.changes && !turn)
    throw new PublicError('CONFLICT', '上一项工作还在处理，请稍后开始新调查。', 409)
  if (turn && turn.question !== input.question)
    throw new PublicError('CONFLICT', '同一条消息不能更换调查目标。', 409)
  const run = await createAssistantRun(
    c.env,
    actor.id,
    id,
    input.id,
    input.question,
    JSON.parse(turn!.context_json),
  )
  await db
    .prepare(
      "UPDATE assistant_turns SET context_json=json_set(context_json,'$.runId',?) WHERE conversation_id=? AND id=?",
    )
    .bind(run.id, id, input.id)
    .run()
  return c.json({
    id: input.id,
    question: input.question,
    page: input.page,
    hasImage: 0,
    createdAt: time,
    answer: run.answer ?? null,
    issue: null,
    runId: run.id,
    runStatus: run.status,
  })
})
investigationRoutes.get('/investigations/:id', async (c) =>
  c.json(await readAssistantRun(c.env, c.var.actor.id, parse(z.uuid(), c.req.param('id')))),
)
investigationRoutes.post('/investigations/:id/messages', async (c) =>
  c.json(
    await submitAssistantMessage(
      c.env,
      c.var.actor.id,
      parse(z.uuid(), c.req.param('id')),
      parse(assistantMessageSchema, await c.req.json()),
    ),
  ),
)
investigationRoutes.post('/investigations/:id/proposals', async (c) =>
  c.json(
    await createAssistantProposal(
      c.env,
      c.var.actor.id,
      parse(z.uuid(), c.req.param('id')),
      await c.req.json(),
    ),
  ),
)
investigationRoutes.post('/investigations/:id/proposals/:proposalId/:action', async (c) => {
  const id = parse(z.uuid(), c.req.param('id')),
    proposalId = parse(z.uuid(), c.req.param('proposalId')),
    action = parse(z.enum(['confirm', 'reject']), c.req.param('action'))
  if (action === 'confirm') {
    await confirmAssistantProposal(c.env, c.var.actor.id, id, proposalId)
    await wakeAssistantRun(c.env, id)
  } else {
    await rejectAssistantProposal(c.env, c.var.actor.id, id, proposalId)
    await wakeAssistantRun(c.env, id)
  }
  return c.json(await readAssistantRun(c.env, c.var.actor.id, id))
})
investigationRoutes.post('/investigations/:id/:action', async (c) =>
  c.json(
    await controlAssistantRun(
      c.env,
      c.var.actor.id,
      parse(z.uuid(), c.req.param('id')),
      parse(z.enum(['pause', 'resume', 'cancel']), c.req.param('action')),
    ),
  ),
)
