import { type Context, Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { PackApiLabels } from './pack-api-labels'
import { PackOrders } from './pack-service'
import type { PackBatch, PackDevice } from './pack-types'
import { preparePackOutputs, viewPackOutputs } from './pack-prepare'
import { PickingSheets } from './picking-service'
import { PackFactoryPackages } from './pack-factory'

// Mount under the existing session authentication/ERP read permissions.
export const packOrdersRoutes = new Hono<AppEnv>()
packOrdersRoutes.get('/:id/factory-preview', async (c) =>
  c.json(await new PackFactoryPackages(c.env).preview(c.req.param('id'))),
)
packOrdersRoutes.post('/:id/factory-package', async (c) =>
  c.json(await new PackFactoryPackages(c.env).prepare(c.req.param('id'))),
)
packOrdersRoutes.get('/:id/factory-package/:key', async (c) =>
  new PackFactoryPackages(c.env).download(c.req.param('id'), c.req.param('key')),
)
packOrdersRoutes.get('/batches', async (c) => {
  const time = c.req.query('time'),
    id = c.req.query('id')
  const page = await new PackOrders(c.env).list(
    time === undefined && id === undefined ? null : { time: Number(time), id },
  )
  const batches: PackBatch[] = []
  for (const batch of page.batches) batches.push(await viewPackOutputs(c.env, batch))
  return c.json({...page,batches})
})
packOrdersRoutes.get('/:id', async (c) =>
  c.json(await viewPackOutputs(c.env, await new PackOrders(c.env).view(c.req.param('id')))),
)
packOrdersRoutes.post('/:id/prepare-labels', async (c) =>
  streamPackLabelResult(async () => preparePackOutputs(c.env, await new PackOrders(c.env).view(c.req.param('id')))),
)
packOrdersRoutes.get('/:id/group-picking/:group', async (c) =>
  new PickingSheets(c.env).download(await new PackOrders(c.env).view(c.req.param('id')), c.req.param('group')),
)
packOrdersRoutes.get('/:id/group-labels/:group', async (c) =>
  new PackApiLabels(c.env).download(
    await new PackOrders(c.env).view(c.req.param('id')),
    c.req.param('group'),
  ),
)
function download(file: { name: string; object: R2ObjectBody }, type: string) {
  return new Response(file.object.body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
packOrdersRoutes.get('/:id/source', async (c) =>
  download(
    await new PackOrders(c.env).source(c.req.param('id')),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ),
)
// Old Flex PDFs remain archived but cannot be mistaken for corrected product labels.
packOrdersRoutes.get('/:id/labels/:rowIndex', () => {
  throw new PublicError(
    'LABEL_SOURCE_CHANGED',
    '标签已改为 Amazon API，请刷新 ERP 并下载分组标签。',
    409,
  )
})

// Device authentication stays in the existing InventoryDevices implementation.
export function streamPackLabelResult<T>(prepare: () => Promise<T>) {
  // MV3 terminates fetches whose response headers do not arrive within 30 seconds.
  // Send valid JSON whitespace immediately, then the final JSON after generation.
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(' \n'))
      try {
        controller.enqueue(encoder.encode(JSON.stringify(await prepare())))
        controller.close()
      } catch (error) { controller.error(error) }
    },
  }), { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

export function mountPackOrderDeviceRoutes(
  router: Hono<AppEnv>,
  deviceFor: (c: Context<AppEnv>) => Promise<PackDevice>,
) {
  router.post('/pack-orders/import', async (c) => {
    const batch = await new PackOrders(c.env).import(await deviceFor(c), await c.req.json())
    return streamPackLabelResult(() => preparePackOutputs(c.env, batch))
  })
  router.get('/pack-orders/:id', async (c) => {
    const batch = await new PackOrders(c.env).get(await deviceFor(c), c.req.param('id'))
    return streamPackLabelResult(() => preparePackOutputs(c.env, batch))
  })
  router.post('/pack-orders/:id/labels', async (c) => {
    await deviceFor(c)
    throw new PublicError('LABEL_SOURCE_CHANGED', '不再接收 Flex 标签，请重新加载 v0.6.2 插件。', 409)
  })
}
