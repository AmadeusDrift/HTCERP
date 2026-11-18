import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { mountInventoryAutomaticDeviceRoutes } from './automatic-routes'
import { InventoryConnection } from './connection'
import { InventoryDevices } from './devices'
import { mountPackOrderDeviceRoutes } from '../order-sorting/pack-routes'
import { mountInventoryLiveDeviceRoutes } from './live-routes'

export const inventoryDeviceRoutes = new Hono<AppEnv>()

// Mounted before session-cookie auth. Only these routes use scoped device bearer credentials.
inventoryDeviceRoutes.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  if (
    url.protocol !== 'https:' &&
    !(c.env.LOCAL_DEVELOPMENT === '1' && ['127.0.0.1', 'localhost'].includes(url.hostname))
  )
    throw new PublicError('FORBIDDEN', '设备连接必须使用 HTTPS。', 403)
  const origin = c.req.header('Origin')
  if (origin && origin !== url.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
    throw new PublicError('FORBIDDEN', '不接受此来源的设备连接。', 403)
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  if (c.req.method === 'POST' && !/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? ''))
    throw new PublicError('INVALID_INPUT', '请使用 JSON 请求。', 400)
  try {
    await next()
  } catch (error) {
    if (error instanceof z.ZodError) throw new PublicError('INVALID_INPUT', '设备请求内容无效。', 400)
    throw error
  }
})
inventoryDeviceRoutes.post('/pair', async (c) =>
  c.json(await new InventoryDevices(c.env.DB).pair(await c.req.json(), Date.now())),
)
inventoryDeviceRoutes.post('/connect', async (c) =>
  c.json(await new InventoryConnection(c.env.DB).connect(await c.req.json(), Date.now())),
)
const deviceFor = (c: Context<AppEnv>) =>
  new InventoryDevices(c.env.DB).authenticate(
    /^Bearer ([a-f0-9]{64})$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '',
    Date.now(),
  )
inventoryDeviceRoutes.post('/heartbeat', async (c) =>
  c.json({ mode: 'SIMULATION', status: 'ACTIVE', deviceId: (await deviceFor(c)).id }),
)
inventoryDeviceRoutes.get('/work', async (c) =>
  c.json(await new InventoryDevices(c.env.DB).work(await deviceFor(c))),
)
inventoryDeviceRoutes.post('/results', async (c) =>
  c.json(
    await new InventoryDevices(c.env.DB).result(await deviceFor(c), await c.req.json(), Date.now()),
  ),
)
inventoryDeviceRoutes.onError((error, c) => {
  const status =
    error instanceof PublicError
      ? error.status
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : 500
  return c.json(
    {
      code: status === 500 ? 'INTERNAL' : 'DEVICE_REQUEST_FAILED',
      message: error instanceof PublicError ? error.message : '设备请求未完成。',
    },
    status as ContentfulStatusCode,
  )
})
mountInventoryLiveDeviceRoutes(inventoryDeviceRoutes, deviceFor)

mountInventoryAutomaticDeviceRoutes(inventoryDeviceRoutes, deviceFor)
mountPackOrderDeviceRoutes(inventoryDeviceRoutes, deviceFor)
