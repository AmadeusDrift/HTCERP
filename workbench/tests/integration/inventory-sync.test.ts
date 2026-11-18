import { expect, it } from 'vitest'
import { decide, type InventoryObservation } from '../../packages/inventory-sync/rules'

const start = Date.parse('2026-11-16T12:00:00Z')
const day = 86_400_000
const observation = (patch: Partial<InventoryObservation> = {}): InventoryObservation => ({
  sellerAccountId: 'seller',
  marketplaceId: 'ATVPDKIKX0DER',
  warehouseCode: 'A1C5',
  binCode: 'Default',
  inventoryType: 'GOOD',
  sku: 'TEST-JIT-1',
  sellable: 3,
  listingStatus: 'active',
  hasOrdered: false,
  createdAt: start - 30 * day,
  observedAt: start,
  ...patch,
})

it('tops up sellable stock only, for both markers, without ever removing stock', () => {
  for (const sku of ['TEST-JIT-1', 'TEST-j1t-2']) {
    for (const stock of [1, 2, 3, 4, 5, 12]) {
      expect(decide(observation({ sku, sellable: stock, hasOrdered: true }), start).quantity).toBe(
        Math.max(0, 5 - stock),
      )
    }
  }
  expect(decide(observation({ sku: 'HUJM-OTHER' }), start).quantity).toBe(0)
  expect(decide(observation({ sku: 'BOTH-JIT-J1T' }), start).channel).toBe('J1T')
})

it('excludes old unsold zero-stock items but includes previously ordered ones', () => {
  expect(decide(observation({ sellable: 0 }), start)).toMatchObject({
    quantity: 0,
    reason: 'zero_without_eligibility',
  })
  expect(decide(observation({ sellable: 0, hasOrdered: true }), start).quantity).toBe(5)
})

it('uses a fixed seven-day initial cutoff and recognizes later new listings', () => {
  expect(decide(observation({ sellable: 0, createdAt: start - 7 * day }), start).quantity).toBe(2)
  expect(decide(observation({ sellable: 0, createdAt: start - 7 * day - 1 }), start).quantity).toBe(0)
  expect(
    decide(observation({ sellable: 0, createdAt: start + day, observedAt: start + 2 * day }), start)
      .quantity,
  ).toBe(2)
  expect(
    decide(
      observation({ sellable: 0, createdAt: start - 10 * day, observedAt: start + 20 * day }),
      start,
    ).quantity,
  ).toBe(0)
})

it('targets new-only items at two, prioritizes orders, and excludes old unsold positive stock', () => {
  for (const stock of [0, 1, 2, 3, 4, 5, 12]) {
    const row = observation({ sellable: stock, createdAt: start - day })
    expect(decide(row, start).quantity).toBe(Math.max(0, 2 - stock))
    expect(decide({ ...row, hasOrdered: true }, start).quantity).toBe(Math.max(0, 5 - stock))
    expect(decide(row, start, { hasOrdered: true, newListing: true }).quantity).toBe(
      Math.max(0, 5 - stock),
    )
    expect(decide(observation({ sellable: stock }), start).quantity).toBe(0)
    expect(decide(observation({ sellable: stock }), start, { newListing: true }).quantity).toBe(
      Math.max(0, 2 - stock),
    )
  }
})

it('prioritizes Amazon bans and distinguishes out of stock from prohibited listings', () => {
  for (const listingStatus of ['banned', 'stopped', 'closed', 'suppressed'] as const) {
    expect(decide(observation({ listingStatus, sellable: 0, hasOrdered: true }), start).quantity).toBe(0)
  }
  expect(
    decide(observation({ listingStatus: 'out_of_stock', sellable: 0, hasOrdered: true }), start)
      .quantity,
  ).toBe(5)
})

it('does not turn unknown stock or missing zero-stock qualification into replenishment', () => {
  expect(decide(observation({ sellable: null }), start).action).toBe('review')
  expect(decide(observation({ sellable: 0, hasOrdered: null, createdAt: null }), start).action).toBe(
    'review',
  )
  expect(decide(observation({ createdAt: start + day }), start).action).toBe('review')
  expect(() => decide(observation({ sellable: -1 }), start)).toThrow()
  expect(() => decide(observation({ sellable: 2.5 }), start)).toThrow()
})
