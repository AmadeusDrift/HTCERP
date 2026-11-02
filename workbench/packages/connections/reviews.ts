import { Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { AmazonUS } from '../amazon/adapter'
import { PublicError } from '../contracts/errors'
import { dispatch } from '../operations/service-queue'
import { providerCredentials } from './credentials'
import { summarizeComments, summarizeTemuReviews } from './temu-reviews'

export const reviewRoutes = new Hono<AppEnv>()
const path = '/reviews/:platform/:id'
function reportKey(platform: string, id: string) {
  if (
    !(
      (platform === 'amazon' && /^[A-Z0-9]{10}$/.test(id)) ||
      (platform === 'temu' && /^\d{1,24}$/.test(id))
    )
  )
    throw new PublicError('INVALID_INPUT', '请输入有效的商品编号。', 400)
  return 'product-reviews/v1/US/' + platform + '/' + id
}
reviewRoutes.get(path, async (c) => {
  const key = reportKey(c.req.param('platform'), c.req.param('id'))
  const row = await c.env.DB.prepare(
    'SELECT report_json FROM product_review_reports WHERE product_key=?',
  )
    .bind(key)
    .first<{ report_json: string | null }>()
  return c.json({ report: row?.report_json ? JSON.parse(row.report_json) : null })
})
reviewRoutes.post(path, async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可更新评论分析。', 403)
  const { platform, id } = c.req.param(),
    key = reportKey(platform, id),
    db = c.env.DB,
    now = Date.now(),
    lease = crypto.randomUUID()
  const claim = await db
    .prepare(`INSERT INTO product_review_reports(product_key,lease_id,lease_until) VALUES(?,?,?)
 ON CONFLICT(product_key) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until
 WHERE lease_until<=? AND (updated_at<? OR json_extract(report_json,'$.data.modelIssue') IS NOT NULL)`)
    .bind(key, lease, now + 300000, now, now - 86400000)
    .run()
  if (!claim.meta.changes) {
    const cached = await db
      .prepare('SELECT report_json FROM product_review_reports WHERE product_key=? AND updated_at>=?')
      .bind(key, now - 86400000)
      .first<{ report_json: string }>()
    if (cached?.report_json) return c.json(JSON.parse(cached.report_json))
    throw new PublicError('CONFLICT', '这件商品正在分析，请稍后查看。', 409)
  }
  try {
    const identity = {
      owner: c.var.actor.email,
      authorize: async () => {
        const allowed = await db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .bind(c.var.actor.id)
          .first()
        const local =
          c.var.actor.local &&
          c.env.LOCAL_DEVELOPMENT === '1' &&
          !(await db.prepare('SELECT 1 FROM accounts LIMIT 1').first())
        if (!allowed && !local) throw new PublicError('FORBIDDEN', '当前账号不能更新评论分析。', 403)
      },
    }
    const prior =
      platform === 'temu'
        ? await db
            .prepare('SELECT report_json,updated_at FROM product_review_reports WHERE product_key=?')
            .bind(key)
            .first<{ report_json: string | null; updated_at: number }>()
        : null
    const sample =
      prior?.report_json && prior.updated_at >= now - 86400000
        ? JSON.parse(prior.report_json).data
        : null
    const data =
      platform === 'temu'
        ? sample?.modelIssue
          ? await summarizeComments(c.env, sample, { ...identity, retryKnownFailure: true })
          : await summarizeTemuReviews(c.env, id, prior?.updated_at ?? 0, identity)
        : await dispatch(
            db,
            'catalog',
            {
              owner: identity.owner,
              shouldContinue: async () => {
                await identity.authorize()
                return true
              },
            },
            async () =>
              new AmazonUS((await providerCredentials(c.env, 'amazon')).credentials, undefined, db, {
                owner: identity.owner,
                shouldContinue: async () => {
                  await identity.authorize()
                  return true
                },
              }).reviewTopics(id),
          )
    const report = { platform, id, updatedAt: new Date().toISOString(), data }
    const saved = await db
      .prepare(
        'UPDATE product_review_reports SET report_json=?,updated_at=?,lease_id=NULL,lease_until=0 WHERE product_key=? AND lease_id=?',
      )
      .bind(JSON.stringify(report), Date.now(), key, lease)
      .run()
    if (!saved.meta.changes) throw new PublicError('CONFLICT', '分析已由其他请求接手，请刷新查看。', 409)
    return c.json(report)
  } finally {
    await db
      .prepare(
        'UPDATE product_review_reports SET lease_id=NULL,lease_until=0 WHERE product_key=? AND lease_id=?',
      )
      .bind(key, lease)
      .run()
  }
})
