import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { createJob } from '../operations/jobs'
import { currentStrategy, models, parse } from '../operations/model'
import { charged, sendRequest } from '../operations/providers'
import { agentTools, planSchema, runAgentTool } from './agent'
import {
  budgetCheck,
  budgetIssue,
  buildMessages,
  type ChatTurn,
  type Conversation,
  checkedChatPayload,
  missing,
  replyFrom,
  sanitizeImage,
  turnSchema,
  workspaceContext,
} from './model'
import { privateEvidenceLostSql } from './policy'
import { dailyTasks } from './tasks'

const noModel = '运营助手尚未连接 AI 模型，请联系管理员完成配置。'
const noAccount = '请先创建并登录工作账号，再使用个人对话。'
const pageSize = 25
const projection = `id,question,CASE WHEN ${privateEvidenceLostSql("json_extract(assistant_turns.context_json,'$.runId')")} THEN '任务查看权限已变化，旧报告暂不可展示，请重新调查。' ELSE answer END answer,
  CASE WHEN answer IS NULL AND issue IS NULL AND json_extract(context_json,'$.runId') IS NULL AND created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')
    THEN '回复中断，可以重新提问。' ELSE issue END issue,
  image_url IS NOT NULL hasImage,created_at createdAt,json_extract(context_json,'$.page') page,
  json_type(context_json,'$.plan') IS NOT NULL hasPlan,json_extract(context_json,'$.jobId') jobId,json_extract(context_json,'$.runId') runId,
  (SELECT status FROM assistant_runs WHERE id=json_extract(assistant_turns.context_json,'$.runId')) runStatus`
async function owner(db: D1Database, id: string, accountId: string) {
  if (
    !(await db
      .prepare('SELECT 1 FROM assistant_conversations WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first())
  )
    throw missing()
}
export const assistantRoutes = new Hono<AppEnv>()
assistantRoutes.get('/daily-tasks', async (c) => c.json(await dailyTasks(c.env.DB, c.req.query('date'))))
assistantRoutes.get('/conversations', async (c) => {
  const actor = c.var.actor,
    db = c.env.DB
  if (actor.local) return c.json({ items: [], more: false, unavailable: noAccount })
  const page = parse(z.coerce.number().int().min(1).max(100000), c.req.query('page') || 1)
  const [rows, router, available] = await Promise.all([
    db
      .prepare(`SELECT id,title,updated_at updatedAt FROM assistant_conversations WHERE account_id=?
      ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
      .bind(actor.id, pageSize + 1, (page - 1) * pageSize)
      .all<Conversation>(),
    providerCredentials(c.env, 'openrouter')
      .then((v) => !!v.credentials.OPENROUTER_API_KEY)
      .catch(() => false),
    budgetCheck(db),
  ])
  return c.json({
    items: rows.results.slice(0, pageSize),
    more: rows.results.length > pageSize,
    unavailable: !router ? noModel : available ? null : budgetIssue,
  })
})
assistantRoutes.get('/conversations/:id', async (c) => {
  const db = c.env.DB,
    id = c.req.param('id')
  await owner(db, id, c.var.actor.id)
  const before = c.req.query('before') || ''
  if (before) parse(z.uuid(), before)
  const rows = await db
    .prepare(`SELECT ${projection} FROM assistant_turns
    WHERE conversation_id=?1 AND (?2='' OR rowid < (SELECT rowid FROM assistant_turns WHERE conversation_id=?1 AND id=?2))
    ORDER BY rowid DESC LIMIT ?3`)
    .bind(id, before, pageSize + 1)
    .all<ChatTurn>()
  return c.json({
    items: rows.results.slice(0, pageSize).reverse(),
    more: rows.results.length > pageSize,
  })
})
assistantRoutes.get('/conversations/:id/images/:turn', async (c) => {
  const { id, turn } = c.req.param()
  const value =
    await c.env.DB.prepare(`SELECT t.image_url FROM assistant_turns t JOIN assistant_conversations s ON s.id=t.conversation_id
    WHERE s.id=? AND s.account_id=? AND t.id=?`)
      .bind(id, c.var.actor.id, turn)
      .first<string>('image_url')
  if (!value) throw missing()
  return new Response(
    Uint8Array.from(atob(value.slice(23)), (char) => char.charCodeAt(0)),
    {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
})
assistantRoutes.post('/conversations/:id/turns', async (c) => {
  const db = c.env.DB,
    actor = c.var.actor
  if (actor.local) throw new PublicError('ACCOUNT_REQUIRED', noAccount, 403)
  const id = parse(z.uuid(), c.req.param('id')),
    input = parse(turnSchema, await c.req.json())
  const time = new Date().toISOString()
  const image = sanitizeImage(input.image)
  const stored = () =>
    db
      .prepare(`SELECT ${projection} FROM assistant_turns WHERE conversation_id=? AND id=?`)
      .bind(id, input.id)
      .first<ChatTurn>()
  const context = await workspaceContext(db, input)
  const [, claim] = await db.batch([
    db
      .prepare(`INSERT INTO assistant_conversations(id,account_id,title,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, actor.id, Array.from(input.question).slice(0, 36).join('') || '图片咨询', time),
    db
      .prepare(`INSERT INTO assistant_turns(conversation_id,id,question,context_json,image_url,created_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM assistant_conversations WHERE id=?1 AND account_id=?7)
        AND NOT EXISTS(SELECT 1 FROM assistant_turns WHERE conversation_id=?1
        AND answer IS NULL AND issue IS NULL AND (created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')
        OR EXISTS(SELECT 1 FROM assistant_runs WHERE id=json_extract(context_json,'$.runId') AND status IN ('queued','running','pausing','cancelling'))))
      ON CONFLICT(conversation_id,id) DO NOTHING`)
      .bind(id, input.id, input.question, context, image, time, actor.id),
  ])
  if (!claim.meta.changes) {
    await owner(db, id, actor.id)
    const duplicate = await stored()
    if (duplicate) return c.json(duplicate)
    throw new PublicError('CONFLICT', '上一条消息正在回复，请稍后发送。', 409)
  }

  const directKey = 'assistant:' + id + ':' + input.id
  let answer: string | null = null,
    issue: string | null = null,
    reserved = false,
    cost: number | null = null
  let toolOutput = ''
  let updatedContext = context
  const applyTool = async (name: string, args: unknown) => {
    const result = await runAgentTool(c.env, actor, name, args)
    answer = result.answer
    toolOutput = result.data ? JSON.stringify(result.data) : result.answer
    updatedContext = JSON.stringify({ ...JSON.parse(context), plan: result.plan, jobId: result.jobId })
  }
  try {
    const simple =
      /^(查|在线找)\s*(Temu|Amazon)\s+(.+?)[，,]\s*(\d+(?:\.\d+)?)\s*美元以内[，,]\s*销量至少\s*(\d+)\s*件(?:[，,]\s*(\d+)\s*页)?[。！]?$/i.exec(
        input.question,
      )
    if (!image && /^(查|查看)我的任务[。！]?$/.test(input.question)) await applyTool('my_jobs', {})
    else if (!image && simple) {
      const [, action, platform, term, price, sold, pages] = simple
      const home = platform.toLowerCase() === 'temu' && term.trim() === '家居'
      const filters = {
        platform: platform.toLowerCase(),
        keyword: home ? '' : term.trim(),
        category: home ? 'home' : 'all',
        maxPrice: Number(price),
        minSold: Number(sold),
      }
      await applyTool(
        action === '查' ? 'search_inventory' : 'prepare_discovery',
        action === '查' ? filters : { ...filters, mode: 'live', pages: Number(pages ?? 1) },
      )
    } else {
      const router = await providerCredentials(c.env, 'openrouter')
      const key = router.credentials.OPENROUTER_API_KEY
      if (!key) issue = noModel
      else {
        const messages: unknown[] = await buildMessages(db, id, input, context, image)
        const payload = () =>
          checkedChatPayload({
            model: models.research,
            reasoning: { effort: 'minimal' },
            max_tokens: 1000,
            provider: { max_price: { prompt: 1, completion: 5 } },
            messages,
            tools: agentTools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
          })
        const firstBody = payload()
        reserved = !!(await budgetCheck(db, directKey))
        if (!reserved) issue = budgetIssue
        else {
          const ask = (body: string) =>
            sendRequest(
              new Request('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                redirect: 'manual',
                signal: AbortSignal.timeout(60000),
                headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
                body,
              }),
              c.env.OPENROUTER_US,
            )
          const result = await ask(firstBody)
          cost = charged(result, 'micros')
          if (result.status === 200) {
            const toolReply = z.object({
              choices: z.array(
                z.object({
                  message: z.object({
                    tool_calls: z
                      .array(
                        z.object({
                          id: z.string(),
                          type: z.literal('function'),
                          function: z.object({ name: z.string(), arguments: z.string() }),
                        }),
                      )
                      .length(1),
                  }),
                }),
              ),
            })
            const call = toolReply.safeParse(result.body)
            if (call.success && call.data.choices[0]) {
              const calls = call.data.choices[0].message.tool_calls,
                fn = calls[0].function
              await applyTool(fn.name, JSON.parse(fn.arguments))
              // One bounded follow-up lets the agent use real findings to propose the next step.
              const followKey = directKey + ':follow'
              if (fn.name !== 'prepare_discovery' && cost !== null) {
                messages.push(
                  { role: 'assistant', content: null, tool_calls: calls },
                  { role: 'tool', tool_call_id: calls[0].id, content: toolOutput },
                )
                let followBody: string | null = null
                try {
                  followBody = payload()
                } catch (error) {
                  if (!(error instanceof PublicError && error.code === 'AI_INPUT_LIMIT')) throw error
                }
                if (followBody && (await budgetCheck(db, followKey))) {
                  let followCost: number | null = null
                  try {
                    const follow = await ask(followBody)
                    followCost = charged(follow, 'micros')
                    if (follow.status === 200) {
                      const more = toolReply.safeParse(follow.body)
                      const next = more.success
                        ? more.data.choices[0]?.message.tool_calls[0].function
                        : undefined
                      const facts = answer
                      if (next) {
                        await applyTool(next.name, JSON.parse(next.arguments))
                        answer = facts + '\n\n' + answer
                      } else if (!next) {
                        const interpretation = replyFrom(follow.body, key)
                        if (interpretation) answer = facts + '\n\n' + interpretation
                      }
                    }
                  } finally {
                    await db
                      .prepare(
                        "UPDATE usage_reservations SET actual=?,state=? WHERE direct_key=? AND step_key='reply'",
                      )
                      .bind(followCost, followCost === null ? 'uncertain' : 'confirmed', followKey)
                      .run()
                  }
                }
              }
            } else answer = replyFrom(result.body, key)
          }
          if (!answer) issue = '模型暂时无法回复，请稍后重新提问。'
        }
      }
    }
  } catch (err) {
    issue = err instanceof PublicError ? err.message : '这次未能取得模型回复，请稍后重新提问。'
  }
  const save = db
    .prepare(
      'UPDATE assistant_turns SET answer=?,issue=?,context_json=? WHERE conversation_id=? AND id=?',
    )
    .bind(answer, issue, updatedContext, id, input.id)
  if (reserved)
    await db.batch([
      save,
      db
        .prepare(
          "UPDATE usage_reservations SET actual=?,state=? WHERE direct_key=? AND step_key='reply'",
        )
        .bind(cost, cost === null ? 'uncertain' : 'confirmed', directKey),
    ])
  else await save.run()
  return c.json(await stored())
})
assistantRoutes.post('/conversations/:id/turns/:turn/run', async (c) => {
  const actor = c.var.actor,
    db = c.env.DB,
    { id, turn } = c.req.param()
  if (actor.local || actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '当前账号不能创建任务。', 403)
  await owner(db, id, actor.id)
  const row = await db
    .prepare('SELECT context_json FROM assistant_turns WHERE conversation_id=? AND id=?')
    .bind(id, turn)
    .first<{ context_json: string }>()
  if (!row) throw missing()
  const ctx = JSON.parse(row.context_json)
  if (ctx.jobId) return c.json({ id: ctx.jobId })
  const p = planSchema.parse(ctx.plan)
  const cap = p.mode === 'live' ? 10 * p.pages : 0
  if (cap > (await currentStrategy(db)).settings.dataDailyPoints)
    throw new PublicError(
      'BUDGET_LIMIT',
      '团队每日数据预算低于本次计划上限，请缩减页数或调整预算。',
      409,
    )
  const job = await createJob(
    c.env,
    {
      kind: 'discovery',
      requestId: 'agent-' + id + '-' + turn,
      inputs: {
        platform: p.platform,
        keyword: p.keyword,
        categoryId: p.category === 'home' ? 'home' : '',
        mode: p.mode,
        maxPrice: p.maxPrice,
        tiers: [p.minSold],
        pageLimit: p.pages,
        maxDataPoints: cap,
        maxAiMicros: 0,
        goal: '助手选品 · ' + (p.keyword || (p.category === 'home' && '家居') || p.platform),
      },
    },
    actor.email,
  )
  await db
    .prepare(
      "UPDATE assistant_turns SET context_json=json_set(context_json,'$.jobId',?) WHERE conversation_id=? AND id=?",
    )
    .bind(job.id, id, turn)
    .run()
  return c.json(job)
})
