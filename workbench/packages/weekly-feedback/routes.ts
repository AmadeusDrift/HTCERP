import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { credentialEditing, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { launchWeeklyFeedback } from './jobs'
import { type Feedback, marketplace, states } from './model'
import { weeklyProductNames } from './product-names'
import { type FeedbackRun, feedbackRows, notificationDraft } from './report'
import { sendWeeklyNotifications, testWecom } from './wecom'

export const weeklyFeedbackRoutes = new Hono<AppEnv>()
async function currentRun(db: D1Database, id?: string) {
  const store = await db
    .prepare('SELECT seller FROM title_audit_store WHERE singleton=1')
    .first<{ seller: string }>()
  return db
    .prepare(
      "SELECT * FROM weekly_feedback_runs WHERE seller=? AND marketplace=? AND (?='' OR id=?) ORDER BY started DESC,id DESC LIMIT 1",
    )
    .bind(store?.seller ?? '', marketplace, id ?? '', id ?? '')
    .first<FeedbackRun>()
}
weeklyFeedbackRoutes.get('/', async (c) => {
  const db = c.env.DB,
    query = c.req.query()
  const store = await db
    .prepare('SELECT seller FROM title_audit_store WHERE singleton=1')
    .first<{ seller: string }>()
  const settings = await db
    .prepare('SELECT enabled,notify_enabled FROM weekly_feedback_settings WHERE singleton=1')
    .first<{ enabled: number; notify_enabled: number }>()
  const runs = await db
    .prepare(
      'SELECT * FROM weekly_feedback_runs WHERE seller=? AND marketplace=? ORDER BY started DESC,id DESC LIMIT 26',
    )
    .bind(store?.seller ?? '', marketplace)
    .all<FeedbackRun>()
  const run = await currentRun(db, query.run)
  const page = Math.max(0, Math.min(100000, Number.parseInt(query.page ?? '0', 10) || 0))
  const result = run
    ? await feedbackRows(db, run, {
        q: query.q,
        status: query.status,
        page,
        owner: query.owner === 'mine' ? c.var.actor.id : query.owner,
      })
    : { total: 0, rows: [] }
  const stats = run
    ? await db
        .prepare(
          "SELECT l.*,i.* FROM (SELECT count(*) skus,coalesce(sum(role='parent'),0) parents,coalesce(sum(role='unknown' OR asin IS NULL),0) unresolved FROM weekly_feedback_listings WHERE run=?) l CROSS JOIN (SELECT count(*) asins,coalesce(sum(status='available'),0) issues,coalesce(sum(status='no_data'),0) noData,coalesce(sum(status='failed'),0) failed FROM weekly_feedback_items WHERE run=?) i",
        )
        .bind(run.id, run.id)
        .first()
    : null
  const exclusions = run
    ? await db
        .prepare(
          "SELECT sku,asin,title,role FROM weekly_feedback_listings WHERE run=? AND (role='unknown' OR asin IS NULL) ORDER BY sku LIMIT 30",
        )
        .bind(run.id)
        .all()
    : { results: [] }
  const members = await db
    .prepare(
      "SELECT id,username name FROM accounts WHERE active=1 AND role IN ('admin','operator') ORDER BY username",
    )
    .all()
  const deliveries = run
    ? await db
        .prepare(
          'SELECT d.account_id,a.username name,d.status,d.error,d.updated_at FROM weekly_feedback_deliveries d JOIN accounts a ON a.id=d.account_id WHERE d.run=? ORDER BY a.username',
        )
        .bind(run.id)
        .all()
    : { results: [] }
  return c.json({
    store,
    enabled: !!settings?.enabled,
    notifyEnabled: !!settings?.notify_enabled,
    schedule: '每周三 09:00（北京时间）',
    run,
    runs: runs.results,
    stats,
    exclusions: exclusions.results,
    members: members.results,
    deliveries: deliveries.results,
    ...result,
    page,
  })
})
weeklyFeedbackRoutes.post('/schedule', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可设置周报调度。', 403)
  const parsed = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(await c.req.json())
  if (!parsed.success) throw new PublicError('INVALID_INPUT', '请选择周报调度开关。', 400)
  const store = await c.env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first()
  if (!store) throw new PublicError('NOT_CONFIGURED', '请先在数据连接中保存美国站 Seller ID。', 409)
  await c.env.DB.prepare('UPDATE weekly_feedback_settings SET enabled=? WHERE singleton=1')
    .bind(+parsed.data.enabled)
    .run()
  return c.json({ ok: true })
})
weeklyFeedbackRoutes.post('/run', async (c) => {
  if (c.var.actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '仅运营或管理员可生成差评周报。', 403)
  const store = await c.env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
    seller: string
  }>()
  if (!store) throw new PublicError('NOT_CONFIGURED', '请先在数据连接中保存美国站 Seller ID。', 409)
  return c.json(await launchWeeklyFeedback(c.env, store.seller))
})
weeklyFeedbackRoutes.post('/action', async (c) => {
  if (c.var.actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '仅运营或管理员可更新处理记录。', 403)
  const parsed = z
    .object({
      run: z.string().min(1).max(128),
      asin: z.string().regex(/^[A-Z0-9]{10}$/),
      topic: z.string().min(1).max(300),
      state: z.enum(states),
      note: z.string().trim().max(2000),
    })
    .strict()
    .safeParse(await c.req.json())
  if (!parsed.success) throw new PublicError('INVALID_INPUT', '请检查商品、主题、处理状态及备注。', 400)
  const input = parsed.data,
    db = c.env.DB
  const run = await currentRun(db, input.run)
  if (!run) throw new PublicError('NOT_FOUND', '找不到当前店铺的周报。', 404)
  const item = await db
    .prepare('SELECT data FROM weekly_feedback_items WHERE run=? AND asin=?')
    .bind(run.id, input.asin)
    .first<{ data: string | null }>()
  const data: Feedback | null = item?.data ? JSON.parse(item.data) : null
  if (!data?.topics.some((topic) => topic.name === input.topic))
    throw new PublicError('NOT_FOUND', '该商品没有这个差评主题。', 404)
  const now = new Date().toISOString(),
    actor = c.var.actor.id
  await db.batch([
    db
      .prepare(
        'INSERT INTO weekly_feedback_actions(seller,marketplace,asin,topic,state,note,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(seller,marketplace,asin,topic) DO UPDATE SET state=excluded.state,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      )
      .bind(run.seller, run.marketplace, input.asin, input.topic, input.state, input.note, actor, now),
    db
      .prepare(
        'INSERT INTO weekly_feedback_action_history(id,seller,marketplace,asin,topic,state,note,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        run.seller,
        run.marketplace,
        input.asin,
        input.topic,
        input.state,
        input.note,
        actor,
        now,
      ),
  ])
  return c.json({ ok: true })
})
weeklyFeedbackRoutes.get('/notification', async (c) => {
  const run = await currentRun(c.env.DB, c.req.query('run'))
  if (!run) throw new PublicError('NOT_FOUND', '请先生成差评周报。', 404)
  return c.json(await notificationDraft(c.env.DB, run, { names: weeklyProductNames(c.env) }))
})
weeklyFeedbackRoutes.post('/assign', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可分配负责运营。', 403)
  const input = z
    .object({
      run: z.string().min(1).max(128),
      sku: z.string().min(1).max(256),
      accountId: z.string().min(1).max(128).nullable(),
    })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success) throw new PublicError('INVALID_INPUT', '请选择商品及负责运营。', 400)
  const { run: id, sku, accountId } = input.data,
    db = c.env.DB,
    run = await currentRun(db, id)
  if (
    !run ||
    !(await db
      .prepare('SELECT 1 FROM weekly_feedback_listings WHERE run=? AND sku=?')
      .bind(run.id, sku)
      .first())
  )
    throw new PublicError('NOT_FOUND', '找不到当前店铺的商品。', 404)
  if (accountId) {
    const account = await db
      .prepare("SELECT id FROM accounts WHERE id=? AND active=1 AND role IN ('operator','admin')")
      .bind(accountId)
      .first()
    if (!account) throw new PublicError('INVALID_INPUT', '请选择启用的运营或管理员账号。', 400)
    await db
      .prepare(
        "INSERT INTO weekly_feedback_owners(seller,marketplace,sku,account_id,source,updated_by,updated_at) VALUES(?,?,?,?,'manual',?,?) ON CONFLICT(seller,marketplace,sku) DO UPDATE SET account_id=excluded.account_id,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      )
      .bind(run.seller, run.marketplace, sku, accountId, c.var.actor.id, new Date().toISOString())
      .run()
  } else
    await db
      .prepare('DELETE FROM weekly_feedback_owners WHERE seller=? AND marketplace=? AND sku=?')
      .bind(run.seller, run.marketplace, sku)
      .run()
  return c.json({ ok: true })
})
weeklyFeedbackRoutes.get('/wecom', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可配置企业微信。', 403)
  const { credentials } = await providerCredentials(c.env, 'wecom')
  const members = await c.env.DB.prepare(
    "SELECT a.id,a.username name,m.userid FROM accounts a LEFT JOIN weekly_feedback_members m ON m.account_id=a.id WHERE a.active=1 AND a.role IN ('admin','operator') ORDER BY a.username",
  ).all()
  return c.json({
    configured: !!(credentials.WECOM_CORP_ID && credentials.WECOM_AGENT_ID && credentials.WECOM_SECRET),
    credentialEditing: credentialEditing(c.env),
    members: members.results,
  })
})
weeklyFeedbackRoutes.post('/wecom-member', async (c) => {
  if (c.var.actor.role !== 'admin')
    throw new PublicError('FORBIDDEN', '仅管理员可绑定企业微信成员。', 403)
  const input = z
    .object({
      accountId: z.string().min(1).max(128),
      userid: z
        .string()
        .trim()
        .max(64)
        .regex(/^[A-Za-z0-9_@.-]*$/),
    })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success || input.data.userid === '@all')
    throw new PublicError(
      'INVALID_INPUT',
      '请填写单个企业微信成员的 UserID，不能填写群体或全体成员。',
      400,
    )
  const { accountId, userid } = input.data,
    db = c.env.DB
  if (
    !(await db
      .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role IN ('admin','operator')")
      .bind(accountId)
      .first())
  )
    throw new PublicError('INVALID_INPUT', '运营账号不可用。', 400)
  const duplicate = await db
    .prepare('SELECT account_id FROM weekly_feedback_members WHERE userid=? AND account_id<>?')
    .bind(userid, accountId)
    .first()
  if (userid && duplicate) throw new PublicError('CONFLICT', '该企业微信成员已绑定其他 ERP 账号。', 409)
  if (userid)
    await db
      .prepare(
        'INSERT INTO weekly_feedback_members VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET userid=excluded.userid,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      )
      .bind(accountId, userid, c.var.actor.id, new Date().toISOString())
      .run()
  else await db.prepare('DELETE FROM weekly_feedback_members WHERE account_id=?').bind(accountId).run()
  return c.json({ ok: true })
})
weeklyFeedbackRoutes.post('/wecom-test', async (c) => {
  if (c.var.actor.role !== 'admin')
    throw new PublicError('FORBIDDEN', '仅管理员可验证企业微信连接。', 403)
  return c.json(await testWecom(c.env))
})
weeklyFeedbackRoutes.post('/notify-settings', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可配置自动通知。', 403)
  const input = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success) throw new PublicError('INVALID_INPUT', '请选择通知开关。', 400)
  if (input.data.enabled) await testWecom(c.env)
  await c.env.DB.prepare('UPDATE weekly_feedback_settings SET notify_enabled=? WHERE singleton=1')
    .bind(+input.data.enabled)
    .run()
  return c.json({ ok: true })
})
weeklyFeedbackRoutes.post('/notify', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可发送周报通知。', 403)
  const input = z
    .object({ run: z.string().min(1).max(128), retryFailed: z.boolean().default(false) })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success) throw new PublicError('INVALID_INPUT', '请选择周报。', 400)
  return c.json(await sendWeeklyNotifications(c.env, input.data.run, input.data.retryFailed))
})
