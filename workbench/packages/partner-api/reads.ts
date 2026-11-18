import { z } from 'zod'
import { AmazonUS } from '../amazon/adapter'
import type { ConnectionBindings } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { sourceConnection } from '../inventory-sync/source'
import { dailySalesWindow } from '../store-sales/daily'
import { salesDay } from '../store-sales/report'
import { isHaulListing } from '../weekly-feedback/owner-rules'
import { cursor, day, marketplace, type Permission, sku, unavailable, validate } from './permissions'
import type { Client, PartnerStore } from './store'

export const range = z
  .object({
    since: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }),
    cursor,
  })
  .strict()
  .refine(({ since, until }) => {
    const from = Date.parse(since),
      to = Date.parse(until)
    return (
      from >= Date.now() - 700 * 86400000 &&
      to > from &&
      to - from <= 7 * 86400000 &&
      to <= Date.now() - 120000
    )
  })

export async function partnerAmazon(
  env: ConnectionBindings,
  client: Client,
  shouldContinue?: () => Promise<boolean>,
) {
  const connection = await boundConnection(env, client)
  return {
    ...connection,
    amazon: new AmazonUS(connection.credentials, undefined, env.DB, {
      owner: 'partner:' + client.id,
      shouldContinue,
    }),
  }
}

export function boundConnection(env: ConnectionBindings, client: Client) {
  return sourceConnection(env, { seller: client.seller, revision: client.amazon_revision }).catch(() => {
    throw new PublicError('CONNECTION_CHANGED', 'Amazon 店铺或凭据已变更，请由管理员重新绑定接入。', 409)
  })
}

export async function verifiedIdentity(env: ConnectionBindings) {
  const { identity, credentials } = await sourceConnection(env).catch(() => {
    throw new PublicError('NOT_CONFIGURED', '请先在数据连接中绑定美国站店铺。', 409)
  })
  await new AmazonUS(credentials, undefined, env.DB, { owner: 'partner:admin' }).searchListingsItems(
    identity.seller,
  )
  await sourceConnection(env, identity)
  return identity
}

export async function sales(
  env: ConnectionBindings,
  client: Client,
  input: unknown,
  canRead?: () => Promise<boolean>,
) {
  const query = validate(z.object({ date: day, sku: sku.optional() }).strict(), input)
  const today = salesDay(new Date())
  if (
    query.date > today ||
    query.date < new Date(Date.now() - 700 * 86400000).toISOString().slice(0, 10)
  )
    throw new PublicError('INVALID_INPUT', '销售日期超出查询范围。', 400)
  const window = dailySalesWindow(query.date)
  const until = Math.min(Date.parse(window.end), Math.floor((Date.now() - 120000) / 300000) * 300000)
  if (until <= Date.parse(window.start)) throw unavailable()
  const { amazon, identity } = await partnerAmazon(env, client, canRead)
  const checkedAt = Date.now()
  const scope = JSON.stringify([query.date, query.sku ?? null])
  const cached =
    await env.DB.prepare(`SELECT result,checked_at FROM partner_sales_cache WHERE seller=? AND scope=?
    AND connection_revision=? AND checked_at>?`)
      .bind(client.seller, scope, identity.revision, checkedAt - 86400000)
      .first<{ result: string; checked_at: number }>()
  const previous = cached ? (JSON.parse(cached.result) as ReturnType<typeof salesValue>) : null
  if (cached && previous && cached.checked_at > checkedAt - (query.date === today ? 300000 : 3600000))
    return previous
  let result: Awaited<ReturnType<AmazonUS['partnerSales']>>
  try {
    result = await amazon.partnerSales(window.start, new Date(until).toISOString(), query.sku)
  } catch (error) {
    if (previous && error instanceof PublicError && error.retryable) return { ...previous, stale: true }
    throw error
  }
  const body = salesValue(query, result, window, until, checkedAt)
  await env.DB.prepare(`INSERT INTO partner_sales_cache VALUES(?,?,?,?,?) ON CONFLICT(seller,scope) DO UPDATE
    SET connection_revision=excluded.connection_revision,result=excluded.result,checked_at=excluded.checked_at
    WHERE partner_sales_cache.checked_at<=excluded.checked_at`)
    .bind(client.seller, scope, identity.revision, JSON.stringify(body), checkedAt)
    .run()
  return body
}

function salesValue(
  query: { date: string; sku?: string },
  result: Awaited<ReturnType<AmazonUS['partnerSales']>>,
  window: { start: string; end: string },
  until: number,
  checkedAt: number,
) {
  return {
    date: query.date,
    sku: query.sku ?? null,
    units: result.unitCount,
    items: result.orderItemCount,
    amount: result.totalSales.amount,
    currency: 'USD',
    from: window.start,
    through: new Date(until).toISOString(),
    complete: until === Date.parse(window.end),
    stale: false,
    checkedAt,
    source: 'amazon-sales',
  }
}

const funds = z.object({
  amount: z.union([z.string(), z.number().finite()]).nullish(),
  currencyCode: z.string().nullish(),
})
const itemSchema = z.object({
  orderItemId: z.string().min(1),
  quantityOrdered: z.number().int().nonnegative(),
  product: z.object({ sellerSku: z.string().nullish() }).nullish(),
  cancellation: z
    .object({ cancellationExecution: z.object({ cancelledBy: z.string().optional() }).nullish() })
    .nullish(),
  proceeds: z
    .object({
      breakdowns: z
        .array(
          z.object({
            type: z.string(),
            subtotal: funds.nullish(),
            detailedBreakdowns: z
              .array(z.object({ subtype: z.string().nullish(), value: funds.nullish() }))
              .nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
})
const orderPage = z.object({
  orders: z.array(
    z.object({
      orderId: z.string().min(1),
      createdTime: z.iso.datetime({ offset: true }),
      lastUpdatedTime: z.iso.datetime({ offset: true }),
      programs: z.array(z.string()).nullish(),
      salesChannel: z.object({ marketplaceId: z.literal(marketplace) }),
      fulfillment: z.object({ fulfillmentStatus: z.string().optional() }).nullish(),
      orderItems: z.array(itemSchema).min(1),
    }),
  ),
  pagination: z.object({ nextToken: z.string().min(1).nullish() }).nullish(),
})

function money(value: z.infer<typeof funds> | undefined | null) {
  if (!value || value.currencyCode !== 'USD' || !/^-?\d{1,9}(?:\.\d{1,2})?$/.test(String(value.amount)))
    return null
  return Math.round(Number(value.amount) * 100)
}

function orderAmounts(item: z.infer<typeof itemSchema>) {
  const parts = item.proceeds?.breakdowns ?? []
  const itemParts = parts.filter((p) => p.type === 'ITEM')
  const amount = itemParts.length === 1 ? money(itemParts[0].subtotal) : null
  const discounts = parts.filter((p) => p.type === 'DISCOUNT')
  let discount = 0
  for (const part of discounts) {
    if (!part.detailedBreakdowns?.length && money(part.subtotal) !== 0) return null
    for (const detail of part.detailedBreakdowns ?? []) {
      if (detail.subtype !== 'ITEM') {
        if (detail.subtype !== 'SHIPPING' && detail.subtype !== 'GIFT_WRAP') return null
        continue
      }
      const cents = money(detail.value)
      if (cents === null) return null
      discount += Math.abs(cents)
    }
  }
  return amount === null || amount < discount
    ? null
    : { amount: (amount / 100).toFixed(2), discount: (discount / 100).toFixed(2) }
}

export async function orderRows(
  raw: unknown,
  client: Client,
  orderKey: string,
  since: string,
  until: string,
) {
  const parsed = orderPage.safeParse(raw)
  if (!parsed.success) throw unavailable()
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(orderKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const pseudonym = async (value: string) =>
    Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  const orders = parsed.data.orders.filter(
    (o) =>
      o.programs?.includes('AMAZON_HAUL') &&
      Date.parse(o.lastUpdatedTime) >= Date.parse(since) &&
      Date.parse(o.lastUpdatedTime) < Date.parse(until),
  )
  const rows = []
  let missingSku = 0
  for (const order of orders) {
    const status = order.fulfillment?.fulfillmentStatus
    const orderId = await pseudonym('order:' + order.orderId)
    for (const item of order.orderItems) {
      const sellerSku = item.product?.sellerSku?.trim()
      if (!sellerSku) {
        missingSku++
        continue
      }
      const amount = orderAmounts(item)
      const state =
        status === 'CANCELLED'
          ? 'cancelled'
          : item.cancellation?.cancellationExecution
            ? 'review'
            : status === 'PENDING' ||
                status === 'PENDING_AVAILABILITY' ||
                status === 'INVOICE_UNCONFIRMED'
              ? 'pending'
              : amount && status && ['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(status)
                ? 'confirmed'
                : 'review'
      rows.push({
        account_id: client.seller,
        marketplace_id: marketplace,
        order_id: orderId,
        item_id: await pseudonym('item:' + order.orderId + ':' + item.orderItemId),
        purchased_at: order.createdTime,
        sku: sellerSku,
        quantity: state === 'cancelled' ? 0 : item.quantityOrdered,
        status: state,
        amount: state === 'cancelled' ? '0.00' : (amount?.amount ?? null),
        currency: amount || state === 'cancelled' ? 'USD' : null,
        discount: state === 'cancelled' ? '0.00' : (amount?.discount ?? '0.00'),
      })
    }
  }
  return { rows, missingSku, upstream: parsed.data.pagination?.nextToken }
}

export async function syncPage(
  store: PartnerStore,
  client: Client,
  amazon: AmazonUS,
  operation: Extract<Permission, 'orders.read' | 'listings.read'>,
  query: z.infer<typeof range>,
) {
  const since = new Date(query.since).toISOString(),
    until = new Date(query.until).toISOString()
  const scope = since + '/' + until
  const token = await store.readCursor(query.cursor, client, operation, scope)
  if (operation === 'orders.read') {
    const orderKey = await store.db
      .prepare('SELECT order_key FROM partner_seller_keys WHERE seller=?')
      .bind(client.seller)
      .first<string>('order_key')
    if (!orderKey) throw unavailable()
    const data = await orderRows(
      await amazon.partnerOrders(since, until, token),
      client,
      orderKey,
      since,
      until,
    )
    if (token && token === data.upstream)
      throw new PublicError(
        'UPSTREAM_CURSOR_LOOP',
        'Amazon 返回重复分页游标，当前范围未完成。',
        502,
        'amazon',
        true,
      )
    return {
      items: data.rows,
      missingSku: data.missingSku,
      complete: data.missingSku === 0,
      next_cursor: await store.saveCursor(data.upstream, client, operation, scope),
    }
  }
  return partnerListingsPage(store, client, amazon, since, until, scope, token)
}

type ListingWindow = { from: string; to: string; token?: string; seen?: string[] }
const listingCursorPrefix = 'listings-v2:'

async function partnerListingsPage(
  store: PartnerStore,
  client: Client,
  amazon: AmazonUS,
  since: string,
  until: string,
  scope: string,
  token?: string,
) {
  const windows: ListingWindow[] = token?.startsWith(listingCursorPrefix)
    ? JSON.parse(token.slice(listingCursorPrefix.length))
    : [{ from: since, to: until, token }]
  const resume = () =>
    store.saveCursor(
      windows.length ? listingCursorPrefix + JSON.stringify(windows) : null,
      client,
      'listings.read',
      scope,
    )
  const deadline = Date.now() + 9000
  for (let attempt = 0; attempt < 4 && (attempt === 0 || Date.now() < deadline); attempt++) {
    const window = windows[0]
    const data = await amazon.partnerListings(client.seller, window.from, window.to, window.token)
    if (data.numberOfResults >= 1000) {
      if (window.token)
        throw new PublicError(
          'LISTING_WINDOW_CHANGED',
          'Listing 查询范围在分页期间超过上限，请用相同时间范围重新开始。',
          409,
          'amazon',
          true,
        )
      const from = Date.parse(window.from),
        to = Date.parse(window.to)
      if (to - from <= 1)
        throw new PublicError(
          'WINDOW_TOO_LARGE',
          '该毫秒内的 Listing 已达查询上限，请用商品报告补齐该范围。',
          422,
          'amazon',
        )
      const middle = new Date(from + Math.floor((to - from) / 2)).toISOString()
      windows.splice(0, 1, { from: window.from, to: middle }, { from: middle, to: window.to })
      continue
    }
    const items = listingRows(data, client, window.from, window.to)
    if (data.nextToken) {
      const seen = [...(window.seen ?? []), ...(window.token ? [window.token] : [])]
      if (seen.includes(data.nextToken) || seen.length >= 100)
        throw new PublicError(
          'UPSTREAM_CURSOR_LOOP',
          'Amazon 返回重复分页游标，当前范围未完成。',
          502,
          'amazon',
          true,
        )
      windows[0] = { ...window, token: data.nextToken, seen }
    } else windows.shift()
    return { items, complete: true, next_cursor: await resume() }
  }
  return { items: [], complete: true, next_cursor: await resume() }
}

function listingRows(
  data: Awaited<ReturnType<AmazonUS['partnerListings']>>,
  client: Client,
  since: string,
  until: string,
) {
  const items = data.items.filter(isHaulListing).flatMap((r) => {
    const summary = r.summaries?.find((s) => s.marketplaceId === marketplace)
    if (
      !summary?.createdDate ||
      !summary.lastUpdatedDate ||
      !z.iso.datetime({ offset: true }).safeParse(summary.createdDate).success ||
      !z.iso.datetime({ offset: true }).safeParse(summary.lastUpdatedDate).success
    )
      throw unavailable()
    if (
      Date.parse(summary.lastUpdatedDate) < Date.parse(since) ||
      Date.parse(summary.lastUpdatedDate) >= Date.parse(until)
    )
      return []
    return [
      {
        account_id: client.seller,
        marketplace_id: marketplace,
        sku: r.sku,
        created_at: summary.createdDate,
        kind: r.kind,
        asin: summary.asin ?? null,
        title: summary.itemName ?? null,
      },
    ]
  })
  return items
}

type InventoryScope = Pick<Client, 'seller' | 'amazon_revision'>
export function inventorySource(db: D1Database, client: InventoryScope) {
  return db
    .prepare(`SELECT c.generation,c.published_at,r.inventory_source_at,r.listings_source_at,
    r.inventory_count,r.listings_count FROM inventory_source_current c JOIN inventory_source_runs r ON r.id=c.generation
    WHERE c.seller=? AND r.seller=c.seller AND r.marketplace=? AND r.state='COMPLETE'
      AND r.connection_revision=?`)
    .bind(client.seller, marketplace, client.amazon_revision)
    .first<{
      generation: string
      published_at: number
      inventory_source_at: string | null
      listings_source_at: string | null
      inventory_count: number
      listings_count: number
    }>()
}

export async function inventory(db: D1Database, client: InventoryScope, code: string) {
  const source = await inventorySource(db, client)
  if (!source) throw unavailable()
  const row = await db
    .prepare(`SELECT sku,channel,sellable,listing_status,stock_source FROM inventory_source_rows
    WHERE generation=? AND sku=? COLLATE BINARY AND inventory_chunk IS NOT NULL`)
    .bind(source.generation, code)
    .first<{
      sku: string
      channel: string
      sellable: number | null
      listing_status: string
      stock_source: string
    }>()
  const labels = row
    ? (
        await db
          .prepare(`SELECT fnsku FROM inventory_source_fnskus
    WHERE generation=? AND sku=? COLLATE BINARY ORDER BY fnsku`)
          .bind(source.generation, code)
          .all<{ fnsku: string }>()
      ).results.map((item) => item.fnsku)
    : []
  return {
    item: row ? { ...row, fnsku: labels.length === 1 ? labels[0] : null, fnskus: labels } : null,
    publishedAt: source.published_at,
    sourceAt: source.inventory_source_at,
    scope: 'HAUL_FBA_REPORT',
  }
}
