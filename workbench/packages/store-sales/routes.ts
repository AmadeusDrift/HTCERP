import { Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import {
  daysBefore,
  type Listing,
  type SaleLine,
  type SalesDay,
  type StoreSales,
  saleCents,
  salesDay,
  summarize,
} from './report'

// Server-only fixtures. Each synthetic day represents one US Haul store.
// The first order has both JIT and standard lines. Issued units and proceeds are
// retained even if a line is later refunded or cancelled.
function simulatedDay(date: string, offset: number): SalesDay {
  const firstOperator = '模拟运营 A',
    secondOperator = '模拟运营 B'
  const hooks = {
    title: '无痕收纳挂钩',
    sku: 'DEMO-jit-01',
    operator: firstOperator,
    unitCents: 290,
    shippingCents: 150,
  }
  const organizers = {
    title: '抽屉分隔盒',
    sku: 'DEMO-02',
    operator: secondOperator,
    unitCents: 790,
    shippingCents: 0,
  }
  const orders: SaleLine[][] = [
    [
      { ...hooks, units: 7 + (offset % 4) },
      { ...organizers, units: 2 },
    ],
    [{ ...hooks, units: 3 + (offset % 2), shippingCents: 0 }],
    [{ ...organizers, units: 4 + (offset % 3), shippingCents: 100 }],
    [
      {
        title: '硅胶杯垫',
        sku: 'DEMO-JIT-03',
        operator: null,
        units: 3,
        unitCents: 399,
        shippingCents: 0,
      },
    ],
    [{ title: '待核对商品', sku: null, operator: null, units: 2, unitCents: 190, shippingCents: 0 }],
    [
      {
        title: '折叠收纳袋',
        sku: 'DEMO-04',
        operator: firstOperator,
        units: 1,
        unitCents: null,
        shippingCents: null,
      },
    ],
  ]
  const lines = orders.flat()
  const listings: Listing[] = [
    { sku: 'DEMO-01-P', relation: 'parent', operator: firstOperator },
    { sku: 'DEMO-jit-01', relation: 'child', operator: firstOperator },
    { sku: 'DEMO-02', relation: 'standalone', operator: secondOperator },
    { sku: 'DEMO-04', relation: 'unknown', operator: firstOperator },
  ]
  const operators = [...new Set([...lines, ...listings].map((row) => row.operator))].map((name) => ({
    name,
    summary: summarize(
      lines.filter((row) => row.operator === name),
      listings.filter((row) => row.operator === name),
    ),
  }))
  const products = new Map<string, SalesDay['products'][number]>()
  for (const line of lines) {
    if (!line.sku) continue
    const row = products.get(line.sku) ?? {
      sku: line.sku,
      title: line.title,
      operator: line.operator,
      units: 0,
      cents: 0,
    }
    row.units += line.units
    const cents = saleCents(line)
    row.cents = cents === null || row.cents === null ? null : row.cents + cents
    products.set(line.sku, row)
  }
  return { date, team: summarize(lines, listings), operators, products: [...products.values()] }
}

export const storeSalesRoutes = new Hono<AppEnv>()
storeSalesRoutes.get('/store-sales', (c) => {
  const yesterday = daysBefore(salesDay(new Date()), 1)
  const report: StoreSales = { source: 'pending', yesterday, days: [] }
  if (c.req.query('view') === 'preview') {
    if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可查看模拟样张。', 403)
    report.source = 'simulation'
    report.days = Array.from({ length: 7 }, (_, offset) =>
      simulatedDay(daysBefore(yesterday, offset), offset),
    )
  }
  return c.json(report)
})
