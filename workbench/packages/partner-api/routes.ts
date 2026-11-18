import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { sourceConnection } from '../inventory-sync/source'
import {
  asin,
  conflict,
  missing,
  type Permission,
  permissionSchema,
  priceInput,
  quantityInput,
  sku,
  stockInput,
  unavailable,
  validate,
  type WritePermission,
} from './permissions'
import {
  boundConnection,
  inventory,
  inventorySource,
  partnerAmazon,
  range,
  sales,
  syncPage,
  verifiedIdentity,
} from './reads'
import { type Client, PartnerStore, requestView } from './store'
import { approveWrite, reconcileWrite } from './writes'

type ContextType = Context<AppEnv>
type ReadResult = { body: unknown; rows?: number; status?: 202 }
type Operation = Permission | 'connection.read'
type Call = {
  c: ContextType
  store: PartnerStore
  client: Client
  scope: (value: string) => void
}
const pathId = (value: string) => validate(z.uuid(), value)
const toggle = z.object({ enabled: z.boolean() }).strict()
const days = z.number().int().min(1).max(90).default(7)
const clientCredentials = z.object({ name: z.string().trim().min(1).max(80), days }).strict()
const requestedSku = z.object({ sku }).strict()

function serve(operation: Operation | 'write.status', action: (input: Call) => Promise<ReadResult>) {
  return async (c: ContextType) => {
    const store = new PartnerStore(c.env.DB)
    const client = await store.authenticate(c.req.raw)
    let scope: string | null = null
    const current = async () => {
      if (operation !== 'connection.read' && operation !== 'write.status')
        await store.allowed(client, operation)
      else if (!(await store.active(client)))
        throw new PublicError('UNAUTHORIZED', '接入凭据已过期或停用。', 401)
      await boundConnection(c.env, client)
    }
    try {
      await store.quota(client.id, 'requests', 60)
      await current()
      const result = await action({
        c,
        store,
        client,
        scope: (value) => {
          scope = value
        },
      })
      await current()
      await store.audit(
        c.var.requestId,
        client.id,
        null,
        operation,
        scope,
        result.status ?? 200,
        result.rows ?? null,
      )
      await current()
      c.header('X-Request-ID', c.var.requestId)
      return c.json(result.body, result.status ?? 200)
    } catch (error) {
      const exposed =
        error instanceof PublicError
          ? error
          : error instanceof SyntaxError
            ? new PublicError('INVALID_INPUT', '请输入有效的 JSON。', 400)
            : unavailable()
      if (exposed.status === 429)
        c.header(
          'Retry-After',
          String(exposed.retryAfterSeconds ?? (exposed.code === 'RATE_LIMIT' ? 60 : 180)),
        )
      if (exposed.code !== 'RATE_LIMIT')
        await store.audit(c.var.requestId, client.id, null, operation, scope, exposed.status, null)
      throw exposed
    }
  }
}

export const partnerRoutes = new Hono<AppEnv>()
partnerRoutes.get(
  '/connection',
  serve('connection.read', async ({ store, client }) => {
    const { results } = await store.db
      .prepare('SELECT permission FROM partner_permissions WHERE client_id=? ORDER BY permission')
      .bind(client.id)
      .all<{ permission: Permission }>()
    return {
      body: {
        seller: client.seller,
        marketplace: client.marketplace,
        expiresAt: client.expires_at,
        permissions: results.map((r) => r.permission),
        writesEnabled: (await store.settings())?.writes === 1,
      },
    }
  }),
)

partnerRoutes.get(
  '/sales',
  serve('sales.read', async ({ c, client, store, scope }) => {
    scope(JSON.stringify({ date: c.req.query('date'), sku: c.req.query('sku') }))
    return {
      body: await sales(c.env, client, c.req.query(), () =>
        store.allowed(client, 'sales.read').then(() => true),
      ),
      rows: 1,
    }
  }),
)

for (const [path, operation] of [
  ['/orders', 'orders.read'],
  ['/listings', 'listings.read'],
] as const) {
  partnerRoutes.get(
    path,
    serve(operation, async ({ c, client, store, scope }) => {
      const query = validate(range, c.req.query())
      scope(query.since + '/' + query.until)
      const { amazon } = await partnerAmazon(c.env, client, () =>
        store.allowed(client, operation).then(() => true),
      )
      const body = await syncPage(store, client, amazon, operation, query)
      return { body, rows: body.items.length }
    }),
  )
}

partnerRoutes.get(
  '/inventory',
  serve('inventory.read', async ({ c, client, scope }) => {
    const input = validate(requestedSku, c.req.query())
    scope(input.sku)
    const body = await inventory(c.env.DB, client, input.sku)
    return { body, rows: body.item ? 1 : 0 }
  }),
)
partnerRoutes.get(
  '/reports',
  serve('reports.read', async ({ c, client }) => {
    validate(z.object({}).strict(), c.req.query())
    const snapshot = await inventorySource(c.env.DB, client)
    if (!snapshot) throw unavailable()
    return {
      body: {
        publishedAt: snapshot.published_at,
        inventorySourceAt: snapshot.inventory_source_at,
        listingsSourceAt: snapshot.listings_source_at,
        inventoryRows: snapshot.inventory_count,
        listingRows: snapshot.listings_count,
        complete: true,
      },
      rows: 1,
    }
  }),
)

partnerRoutes.get(
  '/catalog',
  serve('catalog.read', async ({ c, client, store, scope }) => {
    const { query } = validate(
      z.object({ query: z.string().trim().min(2).max(80) }).strict(),
      c.req.query(),
    )
    scope(query)
    const { amazon } = await partnerAmazon(c.env, client, () =>
      store.allowed(client, 'catalog.read').then(() => true),
    )
    const found = await amazon.search(query, 10)
    return { body: { items: found.items }, rows: found.items.length }
  }),
)
partnerRoutes.get(
  '/offers',
  serve('offers.read', async ({ c, client, store, scope }) => {
    const query = validate(z.object({ asin }).strict(), c.req.query())
    scope(query.asin)
    const { amazon } = await partnerAmazon(c.env, client, () =>
      store.allowed(client, 'offers.read').then(() => true),
    )
    return { body: { asin: query.asin, offer: await amazon.offer(query.asin) }, rows: 1 }
  }),
)
partnerRoutes.get(
  '/feedback',
  serve('feedback.read', async ({ c, client, store, scope }) => {
    const input = validate(z.object({ asin }).strict(), c.req.query())
    scope(input.asin)
    const { amazon } = await partnerAmazon(c.env, client, () =>
      store.allowed(client, 'feedback.read').then(() => true),
    )
    const result = await amazon.reviewTopics(input.asin)
    const topics = result.topics.map(({ name, mentions, occurrence, impact }) => ({
      name,
      mentions,
      occurrence,
      impact,
    }))
    return { body: { asin: result.asin, period: result.period, topics }, rows: topics.length }
  }),
)
partnerRoutes.get(
  '/listing-issues',
  serve('issues.read', async ({ c, client, store, scope }) => {
    const input = validate(requestedSku, c.req.query())
    scope(input.sku)
    const { amazon } = await partnerAmazon(c.env, client, () =>
      store.allowed(client, 'issues.read').then(() => true),
    )
    const result = z
      .object({
        sku: z.literal(input.sku),
        issues: z
          .array(
            z.object({
              code: z.string(),
              severity: z.string(),
              attributeNames: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .safeParse(await amazon.partnerListing(client.seller, input.sku, 'summaries,issues'))
    if (!result.success) throw unavailable()
    const issues = result.data.issues ?? []
    return { body: { sku: input.sku, issues }, rows: issues.length }
  }),
)

const writePaths = [
  ['/inventory/requests', 'inventory.request', stockInput],
  ['/inventory/quantity', 'inventory.quantity.write', quantityInput],
  ['/prices', 'price.write', priceInput],
] as const
for (const [path, operation, schema] of writePaths) {
  partnerRoutes.post(
    path,
    serve(operation as WritePermission, async ({ c, client, store, scope }) => {
      await store.quota(client.id, 'writes', 10)
      const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
      if (type !== 'application/json') throw new PublicError('INVALID_INPUT', '请发送 JSON。', 415)
      const key = validate(z.string().regex(/^[\w.-]{8,100}$/), c.req.header('idempotency-key'))
      const input = validate<z.infer<typeof stockInput> | z.infer<typeof priceInput>>(
        schema,
        await c.req.json(),
      )
      scope(input.sku)
      return { body: await store.submit(client, operation, key, input), rows: 1, status: 202 }
    }),
  )
}
partnerRoutes.get(
  '/requests/:id',
  serve('write.status', async ({ c, client, store, scope }) => {
    const id = pathId(c.req.param('id') ?? '')
    scope(id)
    const row = await store.request(id)
    if (row.client_id !== client.id) throw missing()
    return { body: requestView(row), rows: 1 }
  }),
)

export const partnerAdmin = new Hono<AppEnv>()
partnerAdmin.use('*', async (c, next) => {
  if (c.var.actor?.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可管理业务 API。', 403)
  await next()
})
partnerAdmin.get('/', async (c) => {
  const input = validate(
    z
      .object({ clientId: z.uuid().optional(), before: z.coerce.number().int().positive().optional() })
      .strict(),
    c.req.query(),
  )
  const identity = await sourceConnection(c.env)
    .then((c) => c.identity)
    .catch(() => undefined)
  return c.json(
    await new PartnerStore(c.env.DB).overview(identity?.revision, input.clientId, input.before),
  )
})
function adminChange(
  operation: string,
  action: (
    c: ContextType,
    store: PartnerStore,
  ) => Promise<{ body: unknown; clientId?: string; scope?: string; status?: 201 }>,
) {
  return async (c: ContextType) => {
    const store = new PartnerStore(c.env.DB)
    const result = await action(c, store)
    await store.audit(
      c.var.requestId,
      result.clientId ?? null,
      c.var.actor.id,
      operation,
      result.scope ?? null,
      result.status ?? 200,
      null,
    )
    return c.json(result.body, result.status ?? 200)
  }
}
partnerAdmin.post(
  '/clients',
  adminChange('admin.client.create', async (c, store) => {
    const input = validate(clientCredentials, await c.req.json())
    const body = await store.create(input.name, input.days, await verifiedIdentity(c.env))
    return { body, clientId: body.id, status: 201 }
  }),
)
partnerAdmin.post(
  '/writes',
  adminChange('admin.writes', async (c, store) => {
    const { enabled } = validate(toggle, await c.req.json())
    await store.setWrites(enabled)
    return { body: { enabled }, scope: String(enabled) }
  }),
)
partnerAdmin.post(
  '/clients/:id/active',
  adminChange('admin.client.active', async (c, store) => {
    const id = pathId(c.req.param('id') ?? '')
    const { enabled } = validate(toggle, await c.req.json())
    await store.setActive(id, enabled)
    return { body: { enabled }, clientId: id, scope: String(enabled) }
  }),
)
partnerAdmin.post(
  '/clients/:id/permissions',
  adminChange('admin.client.permission', async (c, store) => {
    const id = pathId(c.req.param('id') ?? '')
    const { permission, enabled } = validate(
      toggle.extend({ permission: permissionSchema }),
      await c.req.json(),
    )
    await store.setPermission(id, permission, enabled)
    return { body: { permission, enabled }, clientId: id, scope: permission + '=' + enabled }
  }),
)
partnerAdmin.post(
  '/clients/:id/rotate',
  adminChange('admin.client.rotate', async (c, store) => {
    const id = pathId(c.req.param('id') ?? '')
    const input = validate(z.object({ days }).strict(), await c.req.json())
    return { body: await store.rotate(id, input.days, await verifiedIdentity(c.env)), clientId: id }
  }),
)
partnerAdmin.post(
  '/requests/:id/:action',
  adminChange('admin.request', async (c, store) => {
    const id = pathId(c.req.param('id') ?? '')
    const action = validate(z.enum(['approve', 'reject', 'reconcile', 'close']), c.req.param('action'))
    const row = await store.request(id)
    const input = await c.req.json()
    let body: ReturnType<typeof requestView>
    if (action === 'close') {
      const { outcome } = validate(
        z.object({ outcome: z.enum(['CONFIRMED', 'REJECTED']) }).strict(),
        input,
      )
      if (
        !['APPROVED', 'ACCEPTED', 'UNKNOWN', 'SENDING'].includes(row.status) ||
        (row.status === 'SENDING' && Date.now() - (row.reviewed_at ?? Date.now()) < 120000)
      )
        throw conflict()
      body = requestView(await store.finish(id, row.status, outcome, 'ADMIN_VERIFIED_' + outcome))
    } else {
      validate(z.object({}).strict(), input)
      if (action === 'approve') body = await approveWrite(c.env, store, row, c.var.actor.id)
      else if (action === 'reject') body = requestView(await store.reject(id, c.var.actor.id))
      else {
        if (row.operation === 'inventory.request' || !['ACCEPTED', 'UNKNOWN'].includes(row.status))
          throw conflict()
        body = await reconcileWrite(c.env, store, row)
      }
    }
    return { body, clientId: row.client_id, scope: id + '/' + action + '/' + body.status }
  }),
)
