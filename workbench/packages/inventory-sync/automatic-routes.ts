import { type Context, Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { InventoryAutomatic } from './automatic'
import type { LiveDevice } from './live'
export const inventoryAutomaticAdminRoutes = new Hono<AppEnv>()
inventoryAutomaticAdminRoutes.use('*', async (c, next) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以管理自动补库。', 403)
  await next()
})
inventoryAutomaticAdminRoutes.get('/status', async (c) =>
  c.json(await new InventoryAutomatic(c.env).status()),
)
inventoryAutomaticAdminRoutes.post('/settings', async (c) =>
  c.json(await new InventoryAutomatic(c.env).configure(c.var.actor.role, await c.req.json())),
)
inventoryAutomaticAdminRoutes.post('/plan', async (c) =>
  c.json(await new InventoryAutomatic(c.env).plan(Date.now(), 500)),
)
inventoryAutomaticAdminRoutes.post('/reconcile', async (c) =>
  c.json(await new InventoryAutomatic(c.env).reconcile()),
)
export function mountInventoryAutomaticDeviceRoutes(
  router: Hono<AppEnv>,
  deviceFor: (c: Context<AppEnv>) => Promise<LiveDevice>,
) {
  router.post('/automatic/claim', async (c) => {
    const service = new InventoryAutomatic(c.env),
      device = await deviceFor(c)
    const result = await service.claim(device, Date.now(), await c.req.json())
    c.executionCtx.waitUntil(service.reconcile().catch(() => {}))
    return c.json(result)
  })
  router.post('/automatic/prepare', async (c) =>
    c.json(await new InventoryAutomatic(c.env).prepare(await deviceFor(c), await c.req.json())),
  )
  router.post('/automatic/heartbeat', async (c) =>
    c.json(await new InventoryAutomatic(c.env).heartbeat(await deviceFor(c), await c.req.json())),
  )
  router.post('/automatic/dispatched', async (c) =>
    c.json(await new InventoryAutomatic(c.env).dispatched(await deviceFor(c), await c.req.json())),
  )
  router.post('/automatic/results', async (c) =>
    c.json(await new InventoryAutomatic(c.env).results(await deviceFor(c), await c.req.json())),
  )
}
