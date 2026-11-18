import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { InventoryLive, type LiveDevice } from './live'

export const inventoryLiveAdminRoutes = new Hono<AppEnv>()
inventoryLiveAdminRoutes.use('*', async (c, next) => {
  if (c.var.actor.role !== 'admin')
    throw new PublicError('FORBIDDEN', '仅管理员可以创建真实小批量任务。', 403)
  try {
    await next()
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new PublicError('INVALID_INPUT', '小批量请求无效，请选择 1–2 个 SKU。', 400)
    throw error
  }
})
inventoryLiveAdminRoutes.get('/status', async (c) => c.json(await new InventoryLive(c.env).status()))
inventoryLiveAdminRoutes.post('/trial', async (c) =>
  c.json(await new InventoryLive(c.env).createTrial(c.var.actor.email, await c.req.json())),
)
inventoryLiveAdminRoutes.post('/reconcile', async (c) =>
  c.json(await new InventoryLive(c.env).reconcile()),
)

/** Mount inside the existing HTTPS/CORS guarded device router, after its bearer authenticator. */
export function mountInventoryLiveDeviceRoutes(
  router: Hono<AppEnv>,
  deviceFor: (c: Context<AppEnv>) => Promise<LiveDevice>,
) {
  router.post('/live/claim', async (c) =>
    c.json(await new InventoryLive(c.env).claim(await deviceFor(c), Date.now(), await c.req.json())),
  )
  router.post('/live/prepare', async (c) =>
    c.json(await new InventoryLive(c.env).prepare(await deviceFor(c), await c.req.json())),
  )
  router.post('/live/heartbeat', async (c) =>
    c.json(await new InventoryLive(c.env).heartbeat(await deviceFor(c), await c.req.json())),
  )
  router.post('/live/dispatched', async (c) =>
    c.json(await new InventoryLive(c.env).dispatched(await deviceFor(c), await c.req.json())),
  )
  router.post('/live/results', async (c) =>
    c.json(await new InventoryLive(c.env).results(await deviceFor(c), await c.req.json())),
  )
}
