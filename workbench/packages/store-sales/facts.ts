import { z } from 'zod'
import { PublicError } from '../contracts/errors'

export type PerformanceFact = {
  orderId: string
  itemId: string
  purchasedAt: string
  updatedAt: string
  sku: string | null
  asin: string | null
  title: string
  quantity: number
  status: string | null
  cancelled: boolean
  itemCents: number | null
  shippingCents: number | null
  discountCents: number | null
  taxCents: number | null
  knownCents: number | null
  rawJson: string
}

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())
const funds = z.object({ amount: z.string().nullish(), currencyCode: z.string().nullish() })
const breakdown = z.object({
  type: z.string().min(1),
  status: z.string().nullish(),
  subtotal: funds.nullish(),
  detailedBreakdowns: z
    .array(z.object({ subtype: z.string().nullish(), value: funds.nullish() }))
    .nullish(),
})
const proceeds = z.object({
  proceedsTotal: funds.nullish(),
  grandTotal: funds.nullish(),
  breakdowns: z.array(breakdown).nullish(),
})
// Explicit business-field allowlists keep buyer, recipient, delivery addresses,
// gift messages, and arbitrary upstream extensions out of stored source JSON.
const itemSchema = z.object({
  orderItemId: z.string().min(1),
  quantityOrdered: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  product: z
    .object({
      sellerSku: z.string().nullish(),
      asin: z.string().nullish(),
      title: z.string().nullish(),
      price: z.object({ unitPrice: funds.nullish(), priceDesignation: z.string().nullish() }).nullish(),
    })
    .nullish(),
  proceeds: proceeds.nullish(),
  promotion: z
    .object({ breakdowns: z.array(z.object({ promotionId: z.string().nullish() })).nullish() })
    .nullish(),
  cancellation: z
    .object({
      cancellationRequest: z
        .object({ requester: z.string().nullish(), cancelReason: z.string().nullish() })
        .nullish(),
      cancellationExecution: z
        .object({ cancelledBy: z.string().nullish(), cancelReason: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
  fulfillment: z
    .object({
      quantityFulfilled: z.number().int().nonnegative().nullish(),
      quantityUnfulfilled: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
  tax: z
    .object({
      taxCalculationBreakdowns: z.array(z.object({ reportingScheme: z.string().nullish() })).nullish(),
      taxCollections: z
        .array(z.object({ model: z.string().nullish(), responsibleParty: z.string().nullish() }))
        .nullish(),
    })
    .nullish(),
})
const pageSchema = z.object({
  orders: z.array(
    z.object({
      orderId: z.string().min(1),
      createdTime: timestamp,
      lastUpdatedTime: timestamp,
      associatedOrders: z
        .array(z.object({ orderId: z.string().min(1), associationType: z.string().min(1) }))
        .nullish(),
      programs: z.array(z.string()).nullish(),
      salesChannel: z.object({
        marketplaceId: z.string().min(1),
        channelName: z.string().nullish(),
        marketplaceName: z.string().nullish(),
      }),
      fulfillment: z
        .object({ fulfillmentStatus: z.string().nullish(), fulfilledBy: z.string().nullish() })
        .nullish(),
      proceeds: proceeds.nullish(),
      orderItems: z.array(itemSchema).min(1),
    }),
  ),
  pagination: z.object({ nextToken: z.string().min(1).nullish() }).nullish(),
})

function invalidSource() {
  return new PublicError(
    'PERFORMANCE_SOURCE_INVALID',
    '订单源数据结构不完整，本页未同步。',
    502,
    'amazon',
  )
}

function cents(value: z.infer<typeof funds> | null | undefined) {
  if (
    !value ||
    value.currencyCode !== 'USD' ||
    !value.amount ||
    !/^-?\d{1,14}(?:\.\d{1,2})?$/.test(value.amount)
  )
    return null
  const negative = value.amount.startsWith('-')
  const [whole, fraction = ''] = value.amount.replace(/^-/, '').split('.')
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(amount) * (negative ? -1 : 1)
}

function amounts(item: z.infer<typeof itemSchema>) {
  const parts = item.proceeds?.breakdowns
  const matching = (type: string) => parts?.filter((part) => part.type === type) ?? []
  const subtotal = (type: string) => {
    const values = matching(type)
    return values.length === 1 ? cents(values[0].subtotal) : null
  }
  const itemCents = subtotal('ITEM'),
    shippingCents = subtotal('SHIPPING'),
    taxCents = subtotal('TAX')
  const discounts = matching('DISCOUNT')
  const discountValue = discounts.length === 0 && parts ? 0 : subtotal('DISCOUNT')
  const discountCents = discountValue === null ? null : Math.abs(discountValue)
  let unambiguous =
    parts?.every((part) => {
      const amount = cents(part.subtotal)
      if (amount === null) return false
      if (['ITEM', 'SHIPPING', 'DISCOUNT', 'TAX'].includes(part.type)) return true
      return ['GIFT_WRAP', 'COD_FEE', 'OTHER'].includes(part.type) && amount === 0
    }) ?? false
  for (const discount of discounts) {
    if (!discount.detailedBreakdowns?.length) continue
    let total = 0
    for (const detail of discount.detailedBreakdowns) {
      const value = cents(detail.value)
      if (value === null || !['ITEM', 'SHIPPING'].includes(detail.subtype ?? '')) {
        unambiguous = false
      } else total += Math.abs(value)
    }
    if (total !== discountCents || !Number.isSafeInteger(total)) unambiguous = false
  }
  const known =
    unambiguous &&
    itemCents !== null &&
    itemCents >= 0 &&
    shippingCents !== null &&
    shippingCents >= 0 &&
    discountCents !== null
      ? BigInt(itemCents) + BigInt(shippingCents) - BigInt(discountCents)
      : null
  return {
    itemCents,
    shippingCents,
    discountCents,
    taxCents,
    knownCents:
      known !== null && known >= 0n && known <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(known) : null,
  }
}

export function parsePerformancePage(
  raw: unknown,
  from: string,
  through: string,
  basis: 'created' | 'updated',
) {
  const parsed = pageSchema.safeParse(raw)
  const start = timestamp.safeParse(from),
    end = timestamp.safeParse(through)
  if (
    !parsed.success ||
    !start.success ||
    !end.success ||
    start.data >= end.data ||
    !['created', 'updated'].includes(basis)
  )
    throw invalidSource()
  const lines: PerformanceFact[] = []
  let excludedOrders = 0
  for (const order of parsed.data.orders) {
    const date = basis === 'created' ? order.createdTime : order.lastUpdatedTime
    if (
      order.salesChannel.marketplaceId !== 'ATVPDKIKX0DER' ||
      !order.programs?.includes('AMAZON_HAUL') ||
      date < start.data ||
      date >= end.data
    ) {
      excludedOrders++
      continue
    }
    for (const item of order.orderItems) {
      const status = order.fulfillment?.fulfillmentStatus ?? null
      lines.push({
        orderId: order.orderId,
        itemId: item.orderItemId,
        purchasedAt: order.createdTime,
        updatedAt: order.lastUpdatedTime,
        sku: item.product?.sellerSku?.trim() || null,
        asin: item.product?.asin?.trim() || null,
        title: item.product?.title ?? '',
        quantity: item.quantityOrdered,
        status,
        cancelled: status === 'CANCELLED' || Boolean(item.cancellation?.cancellationExecution),
        ...amounts(item),
        rawJson: JSON.stringify({ ...order, orderItems: [item] }),
      })
    }
  }
  return { lines, nextToken: parsed.data.pagination?.nextToken ?? null, excludedOrders }
}

const columns = `seller,connection_revision,order_id,item_id,purchased_at,updated_at,sku,asin,title,quantity,status,cancelled,item_cents,shipping_cents,discount_cents,tax_cents,known_cents,raw_json,observed_at`
const placeholders = Array.from({ length: 19 }, () => '?').join(',')
const updates = columns
  .split(',')
  .slice(4)
  .map((column) => `${column}=excluded.${column}`)
  .join(',')

export async function savePerformanceFacts(
  db: D1Database,
  identity: { seller: string; revision: string },
  lines: PerformanceFact[],
  observedAt: string,
): Promise<void> {
  const observed = timestamp.safeParse(observedAt)
  if (!observed.success || !identity.seller || !identity.revision) throw invalidSource()
  // Each statement uses at most 20 bindings; each transaction holds at most
  // 40 line/version pairs. Replaying a partly completed page is idempotent.
  for (let offset = 0; offset < lines.length; offset += 40) {
    const pairs = await Promise.all(
      lines.slice(offset, offset + 40).map(async (line) => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(line.rawJson))
        const version = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const values = [
          identity.seller,
          identity.revision,
          line.orderId,
          line.itemId,
          line.purchasedAt,
          line.updatedAt,
          line.sku,
          line.asin,
          line.title,
          line.quantity,
          line.status,
          Number(line.cancelled),
          line.itemCents,
          line.shippingCents,
          line.discountCents,
          line.taxCents,
          line.knownCents,
          line.rawJson,
          observed.data,
        ]
        return [
          db
            .prepare(`INSERT INTO performance_order_versions(${columns},version_hash) VALUES(${placeholders},?)
          ON CONFLICT(seller,connection_revision,order_id,item_id,version_hash) DO NOTHING`)
            .bind(...values, version),
          db
            .prepare(`INSERT INTO performance_order_lines(${columns}) VALUES(${placeholders})
          ON CONFLICT(seller,connection_revision,order_id,item_id) DO UPDATE SET ${updates}
          WHERE performance_order_lines.updated_at<excluded.updated_at OR
            (performance_order_lines.updated_at=excluded.updated_at AND performance_order_lines.observed_at<=excluded.observed_at)`)
            .bind(...values),
        ]
      }),
    )
    await db.batch(pairs.flat())
  }
}
