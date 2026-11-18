import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { inventoryAutomaticAdminRoutes } from './automatic-routes'
import { connectionDigest, InventoryConnection } from './connection'
import { InventoryDevices } from './devices'
import { InventoryExecutor } from './executor'
import { inventoryLiveAdminRoutes } from './live-routes'
import { configureInventorySource, inventorySourceCandidates, inventorySourceStatus } from './source'
import { launchInventoryPatrol } from './source-jobs'

export const inventoryRoutes = new Hono<AppEnv>()
inventoryRoutes.route('/live', inventoryLiveAdminRoutes)
inventoryRoutes.route('/automatic', inventoryAutomaticAdminRoutes)
inventoryRoutes.use('*', async (c, next) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以管理库存联调。', 403)
  await next()
})
inventoryRoutes.get('/', async (c) =>
  c.json({
    ...(await inventorySourceStatus(c.env.DB)),
    devices: await new InventoryDevices(c.env.DB).list(),
    executor: await new InventoryExecutor(c.env.DB).status(),
    ...(await new InventoryExecutor(c.env.DB).activeTrial()),
    deviceMode: 'SIMULATION',
  }),
)
inventoryRoutes.get('/connection/session', async (c) =>
  c.json(await new InventoryConnection(c.env.DB).session(c.var.actor)),
)
inventoryRoutes.post('/connection/authorize', async (c) => {
  const url = new URL(c.req.url)
  const cookie = getCookie(
    c,
    url.protocol === 'https:' ? '__Host-workbench_session' : 'workbench_dev_session',
  )
  const sessionHash = cookie && /^[a-f0-9]{64}$/.test(cookie) ? await connectionDigest(cookie) : null
  return c.json(
    await new InventoryConnection(c.env.DB).authorize(
      c.var.actor,
      sessionHash,
      await c.req.json(),
      Date.now(),
    ),
  )
})
inventoryRoutes.post('/executor', async (c) =>
  c.json(await new InventoryExecutor(c.env.DB).select(c.var.actor.id, await c.req.json(), Date.now())),
)
inventoryRoutes.post('/settings', async (c) =>
  c.json(await configureInventorySource(c.env.DB, c.var.actor.role, await c.req.json())),
)
inventoryRoutes.get('/candidates', async (c) =>
  c.json(await inventorySourceCandidates(c.env.DB, { limit: 20 })),
)
inventoryRoutes.post('/scan', async (c) => c.json({ runId: await launchInventoryPatrol(c.env) }))
inventoryRoutes.post('/pair', async (c) =>
  c.json(await new InventoryDevices(c.env.DB).createPair(c.var.actor.email, Date.now())),
)
inventoryRoutes.post('/test', async (c) => {
  const input = z
    .object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success) throw new PublicError('INVALID_INPUT', '请选择已配对的设备。', 400)
  return c.json(await new InventoryDevices(c.env.DB).createTest(input.data.deviceId, Date.now()))
})
inventoryRoutes.post('/revoke', async (c) => {
  const input = z
    .object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .safeParse(await c.req.json())
  if (!input.success) throw new PublicError('INVALID_INPUT', '请选择已配对的设备。', 400)
  return c.json(await new InventoryDevices(c.env.DB).revoke(input.data.deviceId, Date.now()))
})
