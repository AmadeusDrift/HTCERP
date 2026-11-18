import { Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { OrderSorting } from './service'
import { packOrdersRoutes, streamPackLabelResult } from './pack-routes'
import { PickingSheets, pickingResponse } from './picking-service'
import { inventoryDeviceScope, connectionDigest } from '../inventory-sync/connection'
import { pickingFilename } from './picking-workbook'
import { PublicError } from '../contracts/errors'
import { ManualFactory } from './manual-factory'

export const orderSortingRoutes = new Hono<AppEnv>()
orderSortingRoutes.route('/pack', packOrdersRoutes)
orderSortingRoutes.get('/state', async (c) => c.json(await new OrderSorting(c.env).state()))
orderSortingRoutes.get('/history', async (c) => {
  const time = c.req.query('time'),
    id = c.req.query('id')
  return c.json(
    await new OrderSorting(c.env).history(
      time === undefined && id === undefined ? null : { time: Number(time), id },
    ),
  )
})
orderSortingRoutes.post('/config', async (c) =>
  c.json(
    await new OrderSorting(c.env).configure(c.var.actor.role, await c.req.json(), c.var.actor.email),
  ),
)
orderSortingRoutes.post('/preview', async (c) =>
  c.json(await new OrderSorting(c.env).preview(await c.req.json())),
)
// Preview never writes order history or the deduplication ledger.
orderSortingRoutes.post('/picking-preview', async (c) => {
  const plan = await new OrderSorting(c.env).preview(await c.req.json())
  if (plan.totalRows > 20 || plan.groups.length !== 1) throw new PublicError('INVALID_INPUT', '备货单预览每次最多 20 条、一个分组。', 400)
  const scope = await inventoryDeviceScope(c.env.DB), group = plan.groups[0]
  const id = 'preview-' + await connectionDigest(JSON.stringify(plan))
  return pickingResponse(await new PickingSheets(c.env).generate(scope, id, group, plan.date), pickingFilename(group))
})
orderSortingRoutes.post('/run', async (c) =>
  c.json(await new OrderSorting(c.env).run(await c.req.json(), c.var.actor.email)),
)
orderSortingRoutes.get('/runs/:id', async (c) =>
  c.json(await new OrderSorting(c.env).getRun(c.req.param('id'))),
)
orderSortingRoutes.get('/runs/:id/files', async (c) =>
  c.json(await new ManualFactory(c.env).status(c.req.param('id'))),
)
orderSortingRoutes.post('/runs/:id/files/:group', async (c) =>
  streamPackLabelResult(await new ManualFactory(c.env).prepareGroup(c.req.param('id'), c.req.param('group'))),
)
orderSortingRoutes.post('/runs/:id/group-picking/:group', async (c) =>
  streamPackLabelResult(await new ManualFactory(c.env).prepareGroup(c.req.param('id'), c.req.param('group'), 'picking')),
)
orderSortingRoutes.post('/runs/:id/group-labels/:group', async (c) =>
  streamPackLabelResult(await new ManualFactory(c.env).prepareGroup(c.req.param('id'), c.req.param('group'), 'labels')),
)
orderSortingRoutes.get('/runs/:id/group-picking/:group', async (c) =>
  new ManualFactory(c.env).groupFile(c.req.param('id'), c.req.param('group'), 'picking'),
)
orderSortingRoutes.get('/runs/:id/group-labels/:group', async (c) =>
  new ManualFactory(c.env).groupFile(c.req.param('id'), c.req.param('group'), 'labels'),
)
orderSortingRoutes.get('/assets/:key', async (c) => {
  const asset = await new OrderSorting(c.env).asset(c.req.param('key'))
  return new Response(asset.object.body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="workbook.xlsx"; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
