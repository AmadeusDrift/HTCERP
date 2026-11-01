import { expect, it } from 'vitest'
import { daysBefore, type SaleLine, salesDay, summarize } from '../../packages/store-sales/report'

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
