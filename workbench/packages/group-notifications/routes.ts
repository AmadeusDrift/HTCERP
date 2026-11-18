import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { type DailySalesReport, dailySalesTeams, dailySalesText, dailySalesWindow, lastSalesDay } from '../store-sales/daily'
import { type DailySalesRun, salesTeamMembers } from '../store-sales/jobs'
import { customTerms } from '../title-audit/catalog'
import { buildInspector } from '../title-audit/rules'
import { marketplace, safeImage } from '../weekly-feedback/model'
import { enqueueDelivery, infringementText, missingRecipient } from './delivery'
import {
  encryptGroupWebhook,
  groupById,
  groupMembers,
  labels,
  type NotificationGroup,
  type NotificationService,
} from './model'

export const groupNotificationRoutes = new Hono<AppEnv>()
const service = z.enum(['feedback', 'infringement', 'daily-sales'])
const memberNotificationService = z.enum(['feedback', 'infringement'])
const id = z.uuid()
const groupInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    webhookKey: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    enabled: z.boolean().default(true),
  })
  .strict()
const newGroupInput = z.union([
  groupInput,
  groupInput.omit({ webhookKey: true }).extend({
    webhookUrl: z.string().trim().min(1).max(512),
    dailySales: z.literal(true).optional(),
  }),
])

function read<T>(schema: z.ZodType<T>, data: unknown) {
  const result = schema.safeParse(data)
  if (!result.success) throw new PublicError('INVALID_INPUT', '请检查企业微信通知配置。', 400)
  return result.data
}

groupNotificationRoutes.get('/', async (c) => {
  const db = c.env.DB
  const [{ results: groups }, { results: routes }] = await Promise.all([
    db.prepare('SELECT * FROM notification_groups ORDER BY name').all<NotificationGroup>(),
    db
      .prepare('SELECT service,group_id FROM notification_routes')
      .all<{ service: NotificationService; group_id: string }>(),
  ])
  return c.json({
    groups: groups.map((group) => {
      const services = routes
        .filter((route) => route.group_id === group.id)
        .map((route) => route.service)
      return {
        id: group.id,
        name: group.name,
        webhookKey: group.webhook_ciphertext ? null : group.webhook_key,
        webhookHint: group.webhook_hint,
        status: !group.enabled ? 'paused' : services.length ? 'active' : 'test',
        services,
      }
    }),
    services: labels,
  })
})

groupNotificationRoutes.post('/groups', async (c) => {
  const input = read(newGroupInput, await c.req.json().catch(() => null))
  const groupId = crypto.randomUUID()
  const webhook = 'webhookUrl' in input
    ? await encryptGroupWebhook(c.env, groupId, input.webhookUrl)
    : { key: input.webhookKey, nonce: null, ciphertext: null, hint: null }
  const db = c.env.DB
  const add = db.prepare(
    `INSERT OR IGNORE INTO notification_groups(
      id,name,webhook_key,enabled,webhook_nonce,webhook_ciphertext,webhook_hint
    ) VALUES(?,?,?,?,?,?,?)`,
  )
    .bind(groupId, input.name, webhook.key, Number(input.enabled), webhook.nonce, webhook.ciphertext, webhook.hint)
  const isDailySales = 'dailySales' in input && input.dailySales
  const [added] = await db.batch([
    add,
    ...(isDailySales ? [db.prepare(`INSERT INTO daily_sales_destination(singleton,group_id)
      SELECT 1,id FROM notification_groups WHERE id=?
      ON CONFLICT(singleton) DO UPDATE SET group_id=excluded.group_id`).bind(groupId)] : []),
  ])
  if (!added.meta.changes) throw new PublicError('CONFLICT', '群名称或 Webhook 已经登记。', 409)
  return c.json({ id: groupId }, 201)
})

groupNotificationRoutes.post('/groups/:id', async (c) => {
  const groupId = read(id, c.req.param('id'))
  const input = read(groupInput, await c.req.json().catch(() => null))
  const group = await groupById(c.env.DB, groupId)
  if (group.webhook_ciphertext)
    throw new PublicError('CONFLICT', '这个群已使用 ERP 保存的 Webhook。', 409)
  const saved =
    await c.env.DB.prepare(`UPDATE OR IGNORE notification_groups SET name=?,webhook_key=?,enabled=?,
    webhook_hint=CASE WHEN webhook_key=? THEN webhook_hint ELSE NULL END WHERE id=?`)
      .bind(input.name, input.webhookKey, Number(input.enabled), input.webhookKey, group.id)
      .run()
  if (!saved.meta.changes) throw new PublicError('CONFLICT', '群名称或 Webhook 配置名称已经存在。', 409)
  return c.json({ ok: true })
})

groupNotificationRoutes.get('/groups/:id/members', async (c) => {
  const group = await groupById(c.env.DB, read(id, c.req.param('id')))
  const { results } = await groupMembers(c.env.DB, group.id)
  return c.json({ members: results.map((row) => ({ ...row, enabled: !!row.enabled })) })
})

groupNotificationRoutes.post('/groups/:id/members', async (c) => {
  const db = c.env.DB
  const group = await groupById(db, read(id, c.req.param('id')))
  const input = read(
    z.object({ accountId: z.string().min(1).max(120), enabled: z.boolean() }).strict(),
    await c.req.json().catch(() => null),
  )
  const member = (await groupMembers(db, group.id)).results.find(
    (row) => row.accountId === input.accountId,
  )
  if (!member) throw new PublicError('NOT_FOUND', '找不到启用的运营账号。', 404)
  if (input.enabled && !member.userid) throw missingRecipient()
  await db
    .prepare(`INSERT INTO notification_group_members VALUES(?,?,?)
    ON CONFLICT(group_id,account_id) DO UPDATE SET enabled=excluded.enabled`)
    .bind(group.id, input.accountId, Number(input.enabled))
    .run()
  return c.json({ ok: true })
})

groupNotificationRoutes.post('/services/:service', async (c) => {
  const name = read(service, c.req.param('service'))
  const { groupId } = read(
    z.object({ groupId: id.nullable() }).strict(),
    await c.req.json().catch(() => null),
  )
  const db = c.env.DB
  if (!groupId) {
    await db.batch([
      db.prepare('DELETE FROM notification_routes WHERE service=?').bind(name),
      db
        .prepare(
          "UPDATE notification_deliveries SET status='cancelled' WHERE service=? AND trial=0 AND status='queued'",
        )
        .bind(name),
    ])
    return c.json({ ok: true })
  }
  const group = await groupById(db, groupId)
  if (name === 'daily-sales' && !(await dailySalesDestination(db, group)))
    throw new PublicError('CONFLICT', '请为销量日报启用使用独立 Webhook 的群机器人。', 409)
  if (name === 'daily-sales' && !(await db.prepare(`SELECT 1 FROM notification_deliveries
    WHERE service='daily-sales' AND group_id=? AND trial=1 AND status='sent' LIMIT 1`).bind(groupId).first()))
    throw new PublicError('CONFLICT', '请先完成该群的销量日报试发。', 409)
  if (name !== 'daily-sales' && await db.prepare(
    "SELECT 1 FROM notification_routes WHERE service='daily-sales' AND group_id=?",
  ).bind(groupId).first())
    throw new PublicError('CONFLICT', '这个机器人已用于销量日报，请选择其他群配置。', 409)
  await db.batch([
    db
      .prepare(`INSERT INTO notification_routes VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET group_id=excluded.group_id
      WHERE group_id<>excluded.group_id`)
      .bind(name, groupId, new Date().toISOString()),
    db
      .prepare(`UPDATE notification_deliveries SET group_id=?,updated_at=? WHERE service=? AND trial=0
      AND status='queued' AND phase='text' AND group_id<>?`)
      .bind(groupId, new Date().toISOString(), name, groupId),
    db
      .prepare(`UPDATE notification_deliveries SET status='cancelled',error='文字已发到切换前的群，图片已停止发送。'
      WHERE service=? AND trial=0 AND status='queued' AND phase='image' AND group_id<>?`)
      .bind(name, groupId),
  ])
  return c.json({ ok: true })
})

async function dailySalesDestination(db: D1Database, group: NotificationGroup) {
  return group.enabled && group.webhook_ciphertext && !(await db.prepare(
    "SELECT 1 FROM notification_routes WHERE group_id=? AND service<>'daily-sales'",
  ).bind(group.id).first())
}

function latestDailySales(db: D1Database) {
  return db.prepare("SELECT report_json FROM daily_sales_runs WHERE status='ready' AND id NOT LIKE 'daily-sales-slot-%' ORDER BY report_date DESC,updated_at DESC LIMIT 1")
    .first<{ report_json: string }>()
}

groupNotificationRoutes.get('/daily-sales', async (c) => {
  const db = c.env.DB
  const [run, ready, groups, accounts, delivery, target, trial] = await Promise.all([
    db.prepare("SELECT id,report_date,status,error,updated_at FROM daily_sales_runs WHERE id NOT LIKE 'daily-sales-slot-%' ORDER BY updated_at DESC LIMIT 1")
      .first<Omit<DailySalesRun, 'report_json'>>(),
    latestDailySales(db),
    salesTeamMembers(db),
    db.prepare("SELECT id,username FROM accounts WHERE active=1 AND role IN ('operator','admin') ORDER BY username").all(),
    db.prepare("SELECT status,error FROM notification_deliveries WHERE service='daily-sales' AND trial=0 ORDER BY created_at DESC LIMIT 1")
      .first<{ status: string; error: string | null }>(),
    db.prepare(`SELECT g.id,g.name,g.webhook_hint AS webhookHint,
      EXISTS(SELECT 1 FROM notification_routes r WHERE r.service='daily-sales' AND r.group_id=g.id) AS scheduled
      FROM daily_sales_destination d JOIN notification_groups g ON g.id=d.group_id WHERE d.singleton=1`).first(),
    db.prepare(`SELECT n.status,n.error FROM notification_deliveries n
      JOIN daily_sales_destination d ON d.group_id=n.group_id
      WHERE n.service='daily-sales' AND n.trial=1 ORDER BY n.created_at DESC LIMIT 1`).first(),
  ])
  const report = ready && JSON.parse(ready.report_json) as DailySalesReport
  return c.json({ run, preview: report ? dailySalesText(report) : null, groups, accounts: accounts.results, delivery, target, trial })
})

groupNotificationRoutes.post('/daily-sales/teams', async (c) => {
  const { team, accountIds } = read(z.object({
    team: z.enum(dailySalesTeams), accountIds: z.array(z.string().min(1).max(120)).max(50),
  }).strict(), await c.req.json().catch(() => null))
  const db = c.env.DB
  const ids = [...new Set(accountIds)]
  const { results } = await db.prepare(`SELECT a.id,t.team FROM accounts a
    LEFT JOIN daily_sales_team_members t ON t.account_id=a.id
    WHERE a.active=1 AND a.role IN ('operator','admin')`)
    .all<{ id: string; team: string | null }>()
  if (ids.some((id) => !results.some((row) => row.id === id)))
    throw new PublicError('INVALID_INPUT', '请选择已启用的运营账号。', 400)
  if (results.some((row) => row.team && row.team !== team && ids.includes(row.id)))
    throw new PublicError('CONFLICT', '请先从原分组移除该运营账号。', 409)
  await db.batch([
    db.prepare('DELETE FROM daily_sales_team_members WHERE team=?').bind(team),
    ...ids.map((id) => db.prepare('INSERT INTO daily_sales_team_members VALUES(?,?)').bind(team, id)),
  ])
  return c.json({ ok: true })
})

groupNotificationRoutes.post('/daily-sales/preview', async (c) => {
  const now = Date.now()
  const date = lastSalesDay(now)
  if (Date.parse(dailySalesWindow(date).end) > now - 120000)
    throw new PublicError('CONFLICT', '美西日期刚切换，请两分钟后再生成日报。', 409)
  const runId = 'daily-sales-preview-' + date + '-' + crypto.randomUUID()
  const cutoff = new Date(now - 3600000).toISOString()
  const launch = await c.env.DB.prepare(`INSERT INTO daily_sales_runs(id,report_date,status,updated_at)
    SELECT ?,?,'running',? WHERE NOT EXISTS(
      SELECT 1 FROM daily_sales_runs WHERE status='running' AND report_date=? AND updated_at>?
      AND id NOT LIKE 'daily-sales-slot-%') RETURNING id`)
    .bind(runId, date, new Date(now).toISOString(), date, cutoff).first()
  if (!launch) {
    const active = await c.env.DB.prepare(`SELECT id FROM daily_sales_runs WHERE report_date=? AND id NOT LIKE 'daily-sales-slot-%'
      ORDER BY updated_at DESC LIMIT 1`).bind(date).first<{ id: string }>()
    return c.json({ id: active?.id }, 202)
  }
  try {
    await c.env.RUNNER.create({ id: runId, params: { runId } })
  } catch {
    await c.env.DB.prepare("UPDATE daily_sales_runs SET status='failed',error=? WHERE id=?")
      .bind('日报任务启动失败，请稍后重试。', runId).run()
    throw new PublicError('SOURCE_UNAVAILABLE', '日报任务启动失败，请稍后重试。', 503)
  }
  return c.json({ id: runId }, 202)
})

groupNotificationRoutes.post('/groups/:id/trial', async (c) => {
  const db = c.env.DB
  const group = await groupById(db, read(id, c.req.param('id')))
  if (!group.enabled) throw new PublicError('CONFLICT', '请先启用该群。', 409)
  const input = read(
    z.union([z.object({ service: z.literal('daily-sales') }).strict(), z
      .object({
        service: memberNotificationService,
        accountId: z.string().min(1).max(120),
        sku: z.string().min(1).max(120).optional(),
      })
      .strict()]),
    await c.req.json().catch(() => null),
  )
  const runId = 'group-notification-trial-' + crypto.randomUUID()
  const message = input.service === 'daily-sales' ? await dailySalesTrial(db, group) : await memberTrial(db, group, input)
  await enqueueDelivery(db, {
    id: runId,
    service: input.service,
    groupId: group.id,
    ...message,
    trial: true,
  }).run()
  try {
    await c.env.RUNNER.create({ id: runId, params: { runId } })
  } catch {
    await db
      .prepare(
        "UPDATE notification_deliveries SET status='failed',error=? WHERE id=? AND status='queued'",
      )
      .bind('试发工作流启动失败，请重试。', runId)
      .run()
    throw new PublicError('SOURCE_UNAVAILABLE', '试发工作流启动失败，请重试。', 503)
  }
  return c.json({ id: runId }, 202)
})

async function dailySalesTrial(db: D1Database, group: NotificationGroup) {
  if (!(await dailySalesDestination(db, group)))
    throw new PublicError('CONFLICT', '请为销量日报启用使用独立 Webhook 的群机器人。', 409)
  const ready = await latestDailySales(db)
  if (!ready) throw new PublicError('CONFLICT', '请先生成销量日报预览。', 409)
  return { accountId: null, content: '【测试】' + dailySalesText(JSON.parse(ready.report_json)) }
}

async function memberTrial(
  db: D1Database,
  group: NotificationGroup,
  input: { service: 'feedback' | 'infringement'; accountId: string; sku?: string },
) {
  const member = (await groupMembers(db, group.id)).results.find(
    (row) => row.accountId === input.accountId,
  )
  if (!member?.userid || !member.enabled) throw missingRecipient()
  let content = `【测试】差评周报\n涉及运营：${member.name}\n查看周报：https://htcerp.app/feedback`
  let image: string | null = null
  if (input.service === 'infringement') {
    const sample = await db
      .prepare(`SELECT sku,asin,title,image,fingerprint,issue_details FROM (
      SELECT i.sku,i.asin,i.title,i.image,i.fingerprint,i.issue_details,0 source,i.changed_at recent FROM notification_infringements i
      WHERE i.seller=(SELECT seller FROM title_audit_store WHERE singleton=1) AND i.fingerprint<>'[]'
      UNION ALL SELECT l.sku,l.asin,l.title,l.image,NULL,NULL,1 source,r.started recent FROM weekly_feedback_listings l
      JOIN weekly_feedback_runs r ON r.id=l.run WHERE r.seller=(SELECT seller FROM title_audit_store WHERE singleton=1)
      AND r.marketplace=? AND l.role IN ('child','standalone'))
      WHERE image IS NOT NULL AND asin IS NOT NULL AND (? IS NULL OR sku=?) ORDER BY source,recent DESC LIMIT 1`)
      .bind(marketplace, input.sku ?? null, input.sku ?? null)
      .first<{
        sku: string
        asin: string
        title: string | null
        image: string
        fingerprint: string | null
        issue_details: string | null
      }>()
    image = safeImage(sample?.image)
    if (!sample || !image)
      throw new PublicError(
        'NOT_FOUND',
        '没有找到带主图的样例 SKU，请先生成差评周报或选择其他 SKU。',
        404,
      )
    const inspect = buildInspector(await customTerms(db))
    content = '【测试】' + infringementText(
      { ...sample, observed_at: new Date().toISOString(), name: member.name },
      inspect,
    )
  }
  return { accountId: input.accountId, content, image }
}

groupNotificationRoutes.get('/groups/:id/deliveries', async (c) => {
  const group = await groupById(c.env.DB, read(id, c.req.param('id')))
  const { results } = await c.env.DB.prepare(`SELECT d.id,d.service,d.trial,d.phase,d.status,d.error,
    d.created_at,d.updated_at,COALESCE(a.username,'所有人') name FROM notification_deliveries d LEFT JOIN accounts a ON a.id=d.account_id
    WHERE d.group_id=? ORDER BY d.created_at DESC LIMIT 50`)
    .bind(group.id)
    .all()
  return c.json({ deliveries: results })
})

groupNotificationRoutes.get('/infringements', async (c) => {
  const db = c.env.DB
  const page = read(z.coerce.number().int().min(0).max(100000), c.req.query('page') ?? 0)
  const [{ results }, scan] = await Promise.all([
    db
      .prepare(`SELECT i.changed_at time,i.sku,i.asin,i.image,a.username operator FROM notification_infringements i
      LEFT JOIN weekly_feedback_owners o ON o.seller=i.seller AND o.marketplace=? AND o.sku=i.sku
      LEFT JOIN accounts a ON a.id=o.account_id AND a.active=1 AND a.role IN ('admin','operator')
      WHERE i.seller=(SELECT seller FROM title_audit_store WHERE singleton=1) AND i.fingerprint<>'[]'
      ORDER BY i.changed_at DESC,i.sku LIMIT 50 OFFSET ?`)
      .bind(marketplace, page * 50)
      .all(),
    db
      .prepare(`SELECT through_ms,error FROM notification_infringement_scan
      WHERE seller=(SELECT seller FROM title_audit_store WHERE singleton=1)`)
      .first(),
  ])
  return c.json({ rows: results, scan, timeSource: 'ERP 检出时间' })
})
