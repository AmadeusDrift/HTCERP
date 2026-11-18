import { expect, it, vi } from 'vitest'
import { daysBefore, type SaleLine, salesDay, summarize } from '../../packages/store-sales/report'
import { aggregateDailySales, dailySalesWindow, dailySalesText, scheduledSalesWindow } from '../../packages/store-sales/daily'
import { scheduleDailySales } from '../../packages/store-sales/jobs'
import { investigationFixture } from './assistant-run-fixture'

it('uses reviewed exact SKUs only when ERP ownership is absent', () => {
  const report = aggregateDailySales('2026-11-12', [{ id: 'o', items: [
    { id: '1', sku: 'LAFA-DX-XCAR', units: 1 },
    { id: '2', sku: 'HUCZBD-AB-057', units: 2 },
    { id: '3', sku: 'HUCZBD-AB-OTHER', units: 3 },
  ] }], (sku) => sku === 'HUCZBD-AB-057' ? 'peter' : null,
  { a: ['abby'], b: [], c: ['peter'] },
  (sku) => ['LAFA-DX-XCAR', 'HUCZBD-AB-057'].includes(sku) ? 'a' : undefined)
  expect(report).toMatchObject({ a: { units: 1 }, c: { units: 2 }, unassignedUnits: 3 })
})

it('assigns unclassified SKUs containing JA to B while honoring existing assignments and J1T', () => {
  const report = aggregateDailySales('2026-11-15', [{ id: 'o', items: [
    { id: '1', sku: 'JAHX-0047-3045', units: 10 },
    { id: '2', sku: 'U2-ja-JIT-1', units: 2 },
    { id: '3', sku: 'U2-JA', units: 3 },
    { id: '4', sku: 'C-JA-1', units: 4 },
    { id: '5', sku: 'U2-JA-J1T-JIT-2', units: 5 },
    { id: '6', sku: 'U2-JIT-OTHER', units: 6 },
  ] }], (sku) => sku === 'C-JA-1' ? 'peter' : null,
  { a: ['nick'], b: ['jack'], c: ['peter'] })
  expect(report).toMatchObject({
    haul: { units: 30 }, jit: { units: 13 }, b: { units: 15 }, c: { units: 4 },
    teamJit: { b: { units: 2 } }, jimei: { units: 5 }, unassignedUnits: 6,
  })
})

it('uses a full LA day for manual reports, including both DST transitions', () => {
  expect(dailySalesWindow('2026-11-01')).toEqual({
    start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z',
  })
  expect(dailySalesWindow('2026-03-08')).toEqual({
    start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z',
  })
})

it('starts the four Beijing slots only when a destination is enabled', async () => {
  const { db, env } = investigationFixture()
  const create = vi.fn()
  const bindings = { ...env, RUNNER: { create } as unknown as typeof env.RUNNER }
  const tick = Date.parse('2026-11-14T08:00:00Z')
  try {
    await scheduleDailySales(bindings, tick)
    expect(create).not.toHaveBeenCalled()
    db.exec(`INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('sales','销量日报','fixture',1);
      INSERT INTO notification_routes VALUES('daily-sales','sales','2026-11-14T00:00:00Z')`)
    await scheduleDailySales(bindings, tick - 1800000)
    await scheduleDailySales(bindings, tick + 1800000)
    expect(create).not.toHaveBeenCalled()
    const slots = [tick - 9 * 3600000, tick - 4 * 3600000, tick, tick + 7 * 3600000]
    for (const time of slots) await scheduleDailySales(bindings, time + 34564)
    expect(create.mock.calls.map(([argument]) => argument)).toEqual(slots.map((time, index) => {
      const id = index === 2 ? 'daily-sales-auto-2026-11-13' : 'daily-sales-slot-' + time
      return { id, params: { runId: id, salesTick: time } }
    }))
  } finally {
    db.close()
  }
})

it('uses one Beijing 16:00 start for all four windows and compares exactly 24 hours earlier', () => {
  const slot = (value: string) => scheduledSalesWindow(Date.parse(value))
  for (const [end, yesterdayEnd, includeDaily] of [
    ['2026-11-13T15:00:00.000Z', '2026-11-12T15:00:00.000Z', false],
    ['2026-11-13T23:00:00.000Z', '2026-11-12T23:00:00.000Z', false],
    ['2026-11-14T04:00:00.000Z', '2026-11-13T04:00:00.000Z', false],
    ['2026-11-14T08:00:00.000Z', '2026-11-13T08:00:00.000Z', true],
  ] as const) {
    expect(slot(end)).toEqual({
      start: '2026-11-13T08:00:00.000Z', end, includeDaily,
      previous: { start: '2026-11-12T08:00:00.000Z', end: yesterdayEnd },
    })
  }
  expect(slot('2026-11-14T00:00:00Z')).toBeNull()
  expect(slot('2026-11-14T09:00:00Z')).toBeNull()
  expect(slot('2026-11-13T23:30:00Z')).toBeNull()
})

it('adds yesterday comparison only to the Haul total and handles a zero baseline', () => {
  const report = aggregateDailySales('2026-11-13', [{ id: '1', items: [{ id: '1', sku: null, units: 1182 }] }],
    () => null, { a: [], b: [], c: [] })
  const window = { start: '2026-11-13T08:00:00.000Z', end: '2026-11-13T15:00:00.000Z' }
  for (const [previousUnits, suffix] of [
    [1124, '比昨天同期增加 5.2%'], [1250, '比昨天同期减少 5.4%'],
    [1182, '与昨天同期持平'], [0, '昨天同期 0 件'],
  ] as const) {
    const lines = dailySalesText({ ...report, window, previousUnits }).split('\n')
    expect(lines[1]).toBe('2026-11-13 16:00 至 2026-11-13 23:00（北京时间）')
    expect(lines[2]).toBe(`Haul U2 总计｜1,182 件（${suffix}）`)
    expect(lines.filter((line) => line.includes('昨天同期'))).toHaveLength(1)
  }
})

it('compares the JIT line with its own previous JIT units and keeps the Haul share', () => {
  const report = aggregateDailySales('2026-11-15', [{ id: '1', items: [
    { id: '1', sku: 'STOCK-01', units: 2487 },
    { id: '2', sku: 'ABC-JIT-01', units: 199 },
    { id: '3', sku: 'COLLECTION-J1T-01', units: 5 },
  ] }], () => null, { a: [], b: [], c: [] })
  const text = dailySalesText({ ...report, previousUnits: 2567, previousJitUnits: 229 })
  expect(text).toContain('Haul U2 总计｜2,691 件（比昨天同期增加 4.8%）')
  expect(dailySalesText({ ...report, previousUnits: 2567, previousYearUnits: 2143 }))
    .toContain('Haul U2 总计｜2,691 件（比昨天同期增加 4.8%，比去年同期增加 25.6%）')
  expect(dailySalesText({ ...report, previousYearUnits: 0 })).toContain('2,691 件（去年同期 0 件）')
  expect(dailySalesText({ ...report, previousYearUnits: null })).toContain('2,691 件（去年同期暂无数据）')
  expect(text).toContain('　└ 其中 JIT｜204 件（7.6%）（比昨天同期减少 10.9%）')
  expect(text).toContain('　　集美｜5 件（0.2%）｜占总 JIT 2.5%')
  expect(dailySalesText({ ...report, previousJitUnits: 0 })).toContain('其中 JIT｜204 件（7.6%）（昨天同期 0 件）')
})

it('includes J1T in total JIT while keeping Jimei separate from A/B/C', () => {
  const first = { id: 'a', items: [
    { id: 'i1', sku: 'C-jit-1', units: 4 },
    { id: 'i2', sku: 'A-2', units: 1 },
    { id: 'i3', sku: 'A-jit-3', units: 2 },
    { id: 'i4', sku: 'OTHER-j1t-1', units: 3 },
    { id: 'i5', sku: 'B-2', units: 1 },
  ] }
  const owners = { C: 'peter', A: 'nick', B: 'jack', HUJM: 'jack' }
  const report = aggregateDailySales(
    '2026-11-13',
    [first, first, { id: 'b', items: [
      { id: 'i1', sku: 'HUJM.01', units: 4 },
      { id: 'i2', sku: null, units: 5 },
    ] }],
    (sku) => owners[sku.split(/[.-]/)[0] as keyof typeof owners] ?? null,
    { a: ['nick', 'abby', 'vita', 'wesker', 'miya'], b: ['jack'], c: ['peter'] },
  )
  expect(report).toEqual({
    date: '2026-11-13', haul: { units: 20 },
    jit: { units: 9 },
    a: { units: 3 }, b: { units: 5 }, c: { units: 4 },
    teamJit: { a: { units: 2 }, b: { units: 0 }, c: { units: 4 } },
    jimei: { units: 3, marker: 'J1T', includedInJit: true }, unassignedUnits: 5,
  })
  expect(dailySalesText(report)).toBe([
    '【美国站 Haul U2 销量日报】2026-11-13（美西）',
    'Haul U2 总计｜20 件',
    '　└ 其中 JIT｜9 件（45.0%）',
    '',
    '　按运营组',
    '　　A 组｜3 件（15.0%）｜含 JIT 2 件（组内 66.7%，占总 JIT 22.2%）',
    '　　B 组｜5 件（25.0%）｜含 JIT 0 件（组内 0.0%，占总 JIT 0.0%）',
    '　　C 组｜4 件（20.0%）｜含 JIT 4 件（组内 100.0%，占总 JIT 44.4%）',
    '　　集美｜3 件（15.0%）｜占总 JIT 33.3%',
    '　　未归类｜5 件（25.0%）',
    '',
    '占比按件数计算，分母分别为 Haul U2 总件数、各组总件数、JIT 总件数。',
  ].join('\n'))
})

it('uses the previous LA calendar date across DST and year boundaries', () => {
  expect(salesDay(new Date('2026-11-02T07:59:59Z'))).toBe('2026-11-01')
  expect(daysBefore(salesDay(new Date('2026-11-02T08:00:00Z')), 1)).toBe('2026-11-01')
  expect(daysBefore(salesDay(new Date('2026-03-09T07:00:00Z')), 1)).toBe('2026-03-08')
  expect(daysBefore('2026-01-01', 1)).toBe('2025-12-31')
})

it('preserves issued units, includes shipping once, and excludes incomplete lines from both ratio bases', () => {
  const line: SaleLine = {
    title: 'Sample',
    sku: 'one-JiT',
    operator: null,
    units: 2,
    unitCents: 199,
    shippingCents: 91,
  }
  const summary = summarize(
    [
      line,
      { ...line, sku: 'two', unitCents: 0, shippingCents: 0 },
      { ...line, sku: 'third', shippingCents: null },
      { ...line, sku: ' ' },
    ],
    [
      { sku: 'one', relation: 'child', operator: null },
      { sku: 'one', relation: 'child', operator: null },
      { sku: 'two', relation: 'standalone', operator: null },
      { sku: 'three', relation: 'parent', operator: null },
      { sku: 'four', relation: 'unknown', operator: null },
    ],
  )
  expect(summary).toEqual({
    units: 8,
    cents: 978,
    jit: { units: 2, cents: 489 },
    standard: { units: 2, cents: 0 },
    review: { lines: 2, units: 4, cents: 489, missingAmount: 1 },
    newListings: 2,
    unknownListings: 1,
  })
})
