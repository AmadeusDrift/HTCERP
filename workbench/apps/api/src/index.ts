import { os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { comparisons } from '../../../packages/amazon/routes'
import { investigationRoutes } from '../../../packages/assistant/investigation-routes'
import { assistantRoutes } from '../../../packages/assistant/routes'
import { catalog } from '../../../packages/catalog'
import { reviewRoutes } from '../../../packages/connections/reviews'
import { connections } from '../../../packages/connections/routes'
import { positions } from '../../../packages/contracts/accounts'
import { PublicError } from '../../../packages/contracts/errors'
import { memberDiagnostic } from '../../../packages/contracts/presentation'
import { groupNotificationRoutes } from '../../../packages/group-notifications/routes'
import { inventoryDeviceRoutes } from '../../../packages/inventory-sync/device-routes'
import { inventoryRoutes } from '../../../packages/inventory-sync/routes'
import { orderSortingRoutes } from '../../../packages/order-sorting/routes'
import { adminReportRoutes } from '../../../packages/operations/admin-reports'
import { dailyRoutes } from '../../../packages/operations/daily'
import { operationsRoutes } from '../../../packages/operations/routes'
import { partnerAdmin, partnerRoutes } from '../../../packages/partner-api/routes'
import { personalRoutes } from '../../../packages/personal/routes'
import { images } from '../../../packages/research-images/routes'
import { storeSalesRoutes } from '../../../packages/store-sales/routes'
import { titleAudit } from '../../../packages/title-audit/routes'
import { weeklyFeedbackRoutes } from '../../../packages/weekly-feedback/routes'
import { type Actor, accessRole, requiredRole } from './access'
import { sessionActor } from './account-session'
import { accountRoutes, guardWrite, publicAuth } from './accounts'
import type { AppEnv } from './bindings'

const app = new Hono<AppEnv>()
const session = os
  .$context<{ actor: Actor }>()
  .output(
    z.object({
      id: z.string(),
      username: z.string(),
      email: z.string(),
      role: z.enum(['viewer', 'operator', 'admin']),
      position: z.enum(positions).nullable(),
      local: z.boolean(),
    }),
  )
  .handler(({ context }) => context.actor)
export const rpc = { session }
export type WorkbenchRpc = typeof rpc
const rpcHandler = new RPCHandler(rpc)

app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID())
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  await next()
})
const sizeLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new PublicError('INVALID_INPUT', '输入内容过长。', 413)
    },
  })
const small = sizeLimit(16 * 1024),
  imageLimit = sizeLimit(220_000)
const chatLimit = sizeLimit(244_000)
const sortingLimit = sizeLimit(18_000_000)
app.use('/api/*', (c, next) => {
  if(/^\/api\/order-sorting\/(config|preview|run)$/.test(c.req.path))return sortingLimit(c,next)
  if (/^\/api\/inventory-device\/pack-orders\/(?:import|[a-f\d-]{36}\/labels)$/.test(c.req.path)) return sortingLimit(c,next)
  if (/^\/api\/assistant\/conversations\/[\w-]+\/(?:turns|investigations)$/.test(c.req.path))
    return chatLimit(c, next)
  return (c.req.path === '/api/research-images' ? imageLimit : small)(c, next)
})
app.route('/api', publicAuth)
app.route('/api/inventory-device', inventoryDeviceRoutes)
app.route('/api/partner/v1', partnerRoutes)
app.use('/api/*', async (c, next) => {
  const actor = await sessionActor(c)
  c.set('actor', actor)
  const path = c.req.path
  const method = c.req.method
  const readRpc = path === '/api/rpc/session'
  const sessionAction = readRpc || path === '/api/auth/logout'
  if (!accessRole(actor.role, sessionAction ? 'viewer' : requiredRole(method, path)))
    throw new PublicError('FORBIDDEN', '当前角色没有操作权限。', 403)
  if (method === 'GET' || method === 'HEAD') return next()
  if (method !== 'POST' && !(method === 'PATCH' && /^\/api\/accounts\/[^/]+$/.test(path)))
    throw new PublicError('INVALID_INPUT', '不支持该请求方式。', 405)
  guardWrite(c.req.raw)
  if (sessionAction) return next()
  const minute = Math.floor(Date.now() / 60000)
  const reserved = await c.env.DB.prepare(`INSERT INTO write_limits(actor,window,used) VALUES(?,?,1)
    ON CONFLICT(actor) DO UPDATE SET window=excluded.window,used=CASE WHEN window=excluded.window THEN used+1 ELSE 1 END
    WHERE window<>excluded.window OR used<40 RETURNING used`)
    .bind(actor.email, minute)
    .first()
  if (!reserved)
    throw new PublicError('RATE_LIMIT', '本分钟操作过于频繁，请稍后再试。', 429, 'workbench', true)
  await next()
  await c.env.DB.prepare('INSERT INTO api_audit VALUES(?,?,?,?,?)')
    .bind(
      c.var.requestId,
      actor.email,
      method + ' ' + path.slice(0, 250),
      c.res.status,
      new Date().toISOString(),
    )
    .run()
})
app.route('/api', accountRoutes)
app.route('/api/partner-admin', partnerAdmin)
app.route('/api/assistant', assistantRoutes)
app.route('/api/assistant', investigationRoutes)
app.route('/api/me', personalRoutes)
app.get('/api/session', (c) => c.json(c.var.actor))
app.all('/api/rpc/*', async (c) => {
  const result = await rpcHandler.handle(c.req.raw, {
    prefix: '/api/rpc',
    context: { actor: c.var.actor },
  })
  return result.matched ? result.response : c.notFound()
})
app.route('/api', comparisons)
app.route('/api', connections)
app.route('/api', reviewRoutes)
app.route('/api', images)
app.route('/api', catalog)
app.route('/api', operationsRoutes)
app.route('/api', dailyRoutes)
app.route('/api', adminReportRoutes)
app.route('/api', storeSalesRoutes)
app.route('/api/title-audit',titleAudit)
app.route('/api/weekly-feedback', weeklyFeedbackRoutes)
app.route('/api/group-notifications', groupNotificationRoutes)
app.route('/api/inventory-sync', inventoryRoutes)
app.route('/api/order-sorting', orderSortingRoutes)
app.notFound((c) =>
  c.json(
    {
      code: 'NOT_FOUND',
      message: '找不到这个接口。',
      requestId: c.var.requestId,
      retryable: false,
      source: 'workbench',
    },
    404,
  ),
)
app.onError((e, c) => {
  const err =
    e instanceof PublicError
      ? e
      : e instanceof SyntaxError
        ? new PublicError('INVALID_INPUT', 'JSON 输入无效。', 400)
        : e instanceof HTTPException
          ? new PublicError('REQUEST_FAILED', e.message, e.status)
          : new PublicError('INTERNAL', '工作台暂时无法完成操作。', 500)
  return Response.json(
    {
      code: err.code,
      message: c.var.actor?.role === 'admin' ? err.message : memberDiagnostic(err.message),
      source:
        /geekbi|极鲸云/i.test(err.source) && c.var.actor?.role !== 'admin' ? 'catalog' : err.source,
      retryable: err.retryable,
      requestId: c.var.requestId,
    },
    { status: err.status, headers: { 'Cache-Control': 'no-store', ...(err.status === 429 ? { 'Retry-After': String(err.retryAfterSeconds ?? (c.res.headers.get('Retry-After') || '60')) } : {}) } },
  )
})
export default app
