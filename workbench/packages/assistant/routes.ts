import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { models, parse } from '../operations/model'
import { charged, sendRequest } from '../operations/providers'
import {
  budgetCheck,
  budgetIssue,
  buildMessages,
  type ChatTurn,
  type Conversation,
  missing,
  replyFrom,
  sanitizeImage,
  turnSchema,
  workspaceContext,
} from './model'
import { dailyTasks } from './tasks'

const noModel = '运营助手尚未连接 AI 模型，请联系管理员完成配置。'
const noAccount = '请先创建并登录工作账号，再使用个人对话。'
const pageSize = 25
const projection = `id,question,answer,
  CASE WHEN answer IS NULL AND issue IS NULL AND created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')
    THEN '回复中断，可以重新提问。' ELSE issue END issue,
  image_url IS NOT NULL hasImage,created_at createdAt,json_extract(context_json,'$.page') page`
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
        AND answer IS NULL AND issue IS NULL AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes'))
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
  try {
    const router = await providerCredentials(c.env, 'openrouter')
    const key = router.credentials.OPENROUTER_API_KEY
    if (!key) issue = noModel
    else {
      const messages = await buildMessages(db, id, input, context, image)
      reserved = !!(await budgetCheck(db, directKey))
      if (!reserved) issue = budgetIssue
      else {
        const result = await sendRequest(
          new Request('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(60000),
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: models.research,
              reasoning: { effort: 'minimal' },
              max_tokens: 1000,
              provider: { max_price: { prompt: 1, completion: 5 } },
              messages,
            }),
          }),
          c.env.OPENROUTER_US,
        )
        cost = charged(result, 'micros')
        if (result.status === 200) answer = replyFrom(result.body, key)
        if (!answer) issue = '模型暂时无法回复，请稍后重新提问。'
      }
    }
  } catch (err) {
    issue = err instanceof PublicError ? err.message : '这次未能取得模型回复，请稍后重新提问。'
  }
  const save = db
    .prepare('UPDATE assistant_turns SET answer=?,issue=? WHERE conversation_id=? AND id=?')
    .bind(answer, issue, id, input.id)
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
