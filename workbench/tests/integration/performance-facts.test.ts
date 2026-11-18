import { expect, it } from 'vitest'
import { parsePerformancePage, savePerformanceFacts } from '../../packages/store-sales/facts'
import { investigationFixture } from './assistant-run-fixture'

const from = '2026-11-12T08:00:00.000Z'
const through = '2026-11-13T08:00:00.000Z'
const identity = { seller: 'seller-us', revision: 'connection-1' }
const money = (amount: string, currencyCode = 'USD') => ({ amount, currencyCode })
const part = (type: string, amount: string, currencyCode = 'USD') => ({
  type,
  subtotal: money(amount, currencyCode),
})
function item(overrides: Record<string, unknown> = {}) {
  return {
    orderItemId: 'item-1',
    quantityOrdered: 3,
    product: { sellerSku: 'SKU-1', asin: 'B000000001', title: 'Three items' },
    proceeds: { breakdowns: [part('ITEM', '19.99'), part('SHIPPING', '2.01')] },
    ...overrides,
  }
}
function order(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    createdTime: '2026-11-12T01:00:00-08:00',
    lastUpdatedTime: '2026-11-12T11:00:00Z',
    programs: ['AMAZON_HAUL'],
    salesChannel: { marketplaceId: 'ATVPDKIKX0DER' },
    fulfillment: { fulfillmentStatus: 'SHIPPED' },
    orderItems: [item()],
    ...overrides,
  }
}
function parse(orders = [order()]) {
  return parsePerformancePage({ orders }, from, through, 'created')
}

it('keeps line totals once for multi-quantity items and canonicalizes timestamps', () => {
  expect(parse().lines[0]).toMatchObject({
    orderId: 'order-1',
    itemId: 'item-1',
    purchasedAt: '2026-11-12T09:00:00.000Z',
    updatedAt: '2026-11-12T11:00:00.000Z',
    sku: 'SKU-1',
    asin: 'B000000001',
    title: 'Three items',
    quantity: 3,
    status: 'SHIPPED',
    cancelled: false,
    itemCents: 1999,
    shippingCents: 201,
    discountCents: 0,
    taxCents: null,
    knownCents: 2200,
  })
})

it('retains missing SKUs and unknown amounts as source facts', () => {
  const lines = parse([order({ orderItems: [item({ product: null, proceeds: null })] })]).lines
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    sku: null,
    asin: null,
    title: '',
    quantity: 3,
    itemCents: null,
    shippingCents: null,
    discountCents: null,
    taxCents: null,
    knownCents: null,
  })
})

it('preserves ordered quantities and money for order and item cancellations', () => {
  const lines = parse([
    order({ fulfillment: { fulfillmentStatus: 'CANCELLED' } }),
    order({
      orderId: 'executed',
      orderItems: [item({ cancellation: { cancellationExecution: { cancelledBy: 'AMAZON' } } })],
    }),
    order({
      orderId: 'requested',
      orderItems: [item({ cancellation: { cancellationRequest: { requester: 'BUYER' } } })],
    }),
  ]).lines
  expect(lines.map((line) => [line.cancelled, line.quantity, line.knownCents])).toEqual([
    [true, 3, 2200],
    [true, 3, 2200],
    [false, 3, 2200],
  ])
})

it('filters US Haul orders within the requested half-open source window', () => {
  const orders = [
    order({ orderId: 'start', createdTime: from }),
    order({ orderId: 'other-market', salesChannel: { marketplaceId: 'A2EUQ1WTGCTBG2' } }),
    order({ orderId: 'regular', programs: ['PRIME'] }),
    order({ orderId: 'no-program', programs: undefined }),
    order({ orderId: 'before', createdTime: '2026-11-12T07:59:59.999Z' }),
    order({ orderId: 'end', createdTime: through }),
  ]
  expect(
    parsePerformancePage({ orders, pagination: { nextToken: 'page-two' } }, from, through, 'created'),
  ).toMatchObject({ lines: [{ orderId: 'start' }], nextToken: 'page-two', excludedOrders: 5 })
  expect(
    parsePerformancePage(
      { orders: [order({ createdTime: '2026-01-01T00:00:00Z' })] },
      from,
      through,
      'updated',
    ).lines,
  ).toHaveLength(1)
})

it.each([
  {},
  { orders: null },
  { orders: [order({ createdTime: 'invalid' })] },
  { orders: [order({ lastUpdatedTime: null })] },
  { orders: [order({ orderId: '' })] },
  { orders: [order({ salesChannel: {} })] },
  { orders: [order({ orderItems: [] })] },
  { orders: [order({ orderItems: [item({ quantityOrdered: -1 })] })] },
  { orders: [order({ orderItems: [item({ orderItemId: undefined })] })] },
  { orders: [order(), order({ orderId: undefined })], pagination: { nextToken: 'must-not-advance' } },
  { orders: [], pagination: { nextToken: 4 } },
])('rejects malformed essential source data without returning a partial page: %#', (raw) => {
  expect(() => parsePerformancePage(raw, from, through, 'created')).toThrowError(
    expect.objectContaining({ code: 'PERFORMANCE_SOURCE_INVALID' }),
  )
})

it('whitelists source business data and preserves discount and tax detail without buyer data', () => {
  const discount = {
    ...part('DISCOUNT', '3.00'),
    detailedBreakdowns: [
      { subtype: 'ITEM', value: money('2.50') },
      { subtype: 'SHIPPING', value: money('0.50') },
    ],
  }
  const tax = { ...part('TAX', '1.14'), detailedBreakdowns: [{ subtype: 'ITEM', value: money('1.14') }] }
  const source = order({
    buyer: { buyerEmail: 'private@example.com' },
    recipient: { deliveryAddress: { name: 'Private Buyer' } },
    proceeds: { grandTotal: money('20.14') },
    orderItems: [
      item({
        product: { sellerSku: 'SKU-1', title: 'Product', buyerName: 'Private Buyer' },
        proceeds: {
          proceedsTotal: money('20.14'),
          breakdowns: [part('ITEM', '19.99'), part('SHIPPING', '2.01'), discount, tax],
        },
        buyer: { name: 'Private Buyer' },
        arbitrary: { phone: '555-0100' },
      }),
    ],
  })
  const fact = parse([source]).lines[0]
  const raw = JSON.parse(fact.rawJson)
  expect(raw.orderItems[0].proceeds.breakdowns.slice(2)).toEqual([discount, tax])
  expect(raw.orderItems[0].proceeds.proceedsTotal).toEqual(money('20.14'))
  expect(fact).toMatchObject({ discountCents: 300, taxCents: 114, knownCents: 1900 })
  expect(fact.rawJson).not.toMatch(/private|Private|555-0100|buyer|recipient|arbitrary/)
})

it.each(['3.00', '-3.00'])(
  'deducts discount subtotal %s only once after reconciling its details',
  (amount) => {
    const fact = parse([
      order({
        orderItems: [
          item({
            proceeds: {
              breakdowns: [
                part('ITEM', '19.99'),
                part('SHIPPING', '2.01'),
                {
                  ...part('DISCOUNT', amount),
                  detailedBreakdowns: [
                    { subtype: 'ITEM', value: money('-2.50') },
                    { subtype: 'SHIPPING', value: money('-0.50') },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    ]).lines[0]
    expect(fact).toMatchObject({ discountCents: 300, knownCents: 1900 })
  },
)

it.each([
  [part('ITEM', '19.99')],
  [part('ITEM', '19.99', 'CAD'), part('SHIPPING', '0.00')],
  [part('ITEM', '19.999'), part('SHIPPING', '0.00')],
  [part('ITEM', '1e2'), part('SHIPPING', '0.00')],
  [part('ITEM', '90071992547410.00'), part('SHIPPING', '0.00')],
  [part('ITEM', '19.99'), part('ITEM', '19.99'), part('SHIPPING', '0.00')],
  [part('ITEM', '19.99'), part('SHIPPING', '0.00'), part('DISCOUNT', '20.00')],
  [
    part('ITEM', '19.99'),
    part('SHIPPING', '0.00'),
    { ...part('DISCOUNT', '3.00'), detailedBreakdowns: [{ subtype: 'ITEM', value: money('2.00') }] },
  ],
  [
    part('ITEM', '19.99'),
    part('SHIPPING', '0.00'),
    {
      ...part('DISCOUNT', '3.00'),
      detailedBreakdowns: [{ subtype: 'GIFT_WRAP', value: money('3.00') }],
    },
  ],
  [part('ITEM', '19.99'), part('SHIPPING', '0.00'), part('UNRECOGNIZED', '1.00')],
])(
  'leaves provisional money unknown when source amounts are incomplete or ambiguous: %#',
  (...breakdowns) => {
    const fact = parse([order({ orderItems: [item({ proceeds: { breakdowns } })] })]).lines[0]
    expect(fact.knownCents).toBeNull()
  },
)

it('keeps missing and non-USD financial values raw while projecting null', () => {
  const fact = parse([
    order({
      orderItems: [
        item({
          proceeds: {
            breakdowns: [
              { type: 'ITEM', subtotal: { currencyCode: 'USD' } },
              part('SHIPPING', '2.00', 'CAD'),
            ],
          },
        }),
      ],
    }),
  ]).lines[0]
  expect(fact).toMatchObject({ itemCents: null, shippingCents: null, knownCents: null })
  expect(JSON.parse(fact.rawJson).orderItems[0].proceeds.breakdowns).toEqual([
    { type: 'ITEM', subtotal: { currencyCode: 'USD' } },
    part('SHIPPING', '2.00', 'CAD'),
  ])
})

it('keeps cent arithmetic exact when a discount brings a large total into the safe integer range', () => {
  const fact = parse([
    order({
      orderItems: [
        item({
          proceeds: {
            breakdowns: [
              part('ITEM', '90071992547409.91'),
              part('SHIPPING', '0.02'),
              part('DISCOUNT', '0.03'),
            ],
          },
        }),
      ],
    }),
  ]).lines[0]
  expect(fact.knownCents).toBe(9007199254740990)
})

it('retains order financial status and replacement associations for later policy review', () => {
  const proceeds = {
    grandTotal: money('22.00'),
    breakdowns: [{ ...part('DELIVERY_TIP', '0.00'), status: 'PENDING' }],
  }
  const associatedOrders = [{ orderId: 'original-order', associationType: 'REPLACEMENT_ORIGINAL_ID' }]
  const raw = JSON.parse(parse([order({ proceeds, associatedOrders })]).lines[0].rawJson)
  expect(raw.proceeds).toEqual(proceeds)
  expect(raw.associatedOrders).toEqual(associatedOrders)
})

it('deduplicates repeated pages while preserving changed business source versions', async () => {
  const { db, env } = investigationFixture()
  try {
    const lines = parse().lines
    await savePerformanceFacts(env.DB, identity, [...lines, ...lines], '2026-11-13T10:00:00Z')
    await savePerformanceFacts(env.DB, identity, lines, '2026-11-13T11:00:00Z')
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_lines').get()?.count).toBe(1)
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_versions').get()?.count).toBe(1)
    const changed = parse([order({ orderItems: [item({ quantityOrdered: 4 })] })]).lines
    await savePerformanceFacts(env.DB, identity, changed, '2026-11-13T12:00:00Z')
    expect(db.prepare('SELECT quantity, observed_at FROM performance_order_lines').get()).toMatchObject({
      quantity: 4,
      observed_at: '2026-11-13T12:00:00.000Z',
    })
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_versions').get()?.count).toBe(2)
  } finally {
    db.close()
  }
})

it('archives stale source versions without overwriting the latest order facts', async () => {
  const { db, env } = investigationFixture()
  try {
    const latest = parse([
      order({ lastUpdatedTime: '2026-11-12T12:00:00Z', orderItems: [item({ quantityOrdered: 7 })] }),
    ]).lines
    await savePerformanceFacts(env.DB, identity, latest, '2026-11-13T10:00:00Z')
    await savePerformanceFacts(env.DB, identity, parse().lines, '2026-11-13T11:00:00Z')
    expect(
      db.prepare('SELECT quantity, updated_at, observed_at FROM performance_order_lines').get(),
    ).toMatchObject({
      quantity: 7,
      updated_at: '2026-11-12T12:00:00.000Z',
      observed_at: '2026-11-13T10:00:00.000Z',
    })
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_versions').get()?.count).toBe(2)
  } finally {
    db.close()
  }
})

it('isolates seller connection revisions and writes large pages within D1 statement budgets', async () => {
  const { db, env } = investigationFixture()
  const boundedDB = {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql)
      return {
        ...statement,
        bind(...values: unknown[]) {
          expect(values.length).toBeLessThanOrEqual(80)
          return statement.bind(...values)
        },
      }
    },
    batch(statements: D1PreparedStatement[]) {
      expect(statements.length).toBeLessThanOrEqual(80)
      return env.DB.batch(statements)
    },
  } as D1Database
  try {
    const lines = parse(
      Array.from({ length: 125 }, (_, index) => order({ orderId: 'order-' + index })),
    ).lines
    await savePerformanceFacts(boundedDB, identity, lines, through)
    await savePerformanceFacts(
      env.DB,
      { ...identity, revision: 'connection-2' },
      lines.slice(0, 1),
      through,
    )
    await savePerformanceFacts(env.DB, { ...identity, seller: 'another' }, lines.slice(0, 1), through)
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_lines').get()?.count).toBe(127)
    expect(db.prepare('SELECT count(*) AS count FROM performance_order_versions').get()?.count).toBe(127)
  } finally {
    db.close()
  }
})
