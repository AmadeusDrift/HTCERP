import { z } from 'zod'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => s.trim() === s)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const observationSchema = z
  .object({
    sellerAccountId: identity,
    marketplaceId: identity,
    warehouseCode: identity,
    binCode: identity,
    inventoryType: identity,
    sku: identity,
    sellable: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    listingStatus: z.enum([
      'active',
      'out_of_stock',
      'new',
      'banned',
      'stopped',
      'closed',
      'suppressed',
      'unknown',
    ]),
    hasOrdered: z.boolean().nullable(),
    createdAt: time.nullable(),
    observedAt: time,
  })
  .strict()
export type InventoryObservation = z.infer<typeof observationSchema>
export type Decision = {
  channel: 'JIT' | 'J1T' | null
  action: 'receive' | 'skip' | 'review'
  quantity: number
  reason: string
}

export function inventoryKey(row: InventoryObservation) {
  return JSON.stringify([
    row.sellerAccountId,
    row.marketplaceId,
    row.warehouseCode,
    row.binCode,
    row.inventoryType,
    row.sku,
  ])
}

export function scopeKey(
  row: Pick<InventoryObservation, 'sellerAccountId' | 'marketplaceId' | 'warehouseCode'>,
) {
  return JSON.stringify([row.sellerAccountId, row.marketplaceId, row.warehouseCode])
}

export function skuKey(row: InventoryObservation) {
  return JSON.stringify([row.sellerAccountId, row.marketplaceId, row.warehouseCode, row.sku])
}

export function decide(
  input: InventoryObservation,
  enabledAt: number,
  known: {
    hasOrdered?: boolean
    newListing?: boolean
  } = {},
): Decision {
  const row = observationSchema.parse(input)
  time.parse(enabledAt)
  const channel = /j1t/i.test(row.sku) ? 'J1T' : /jit/i.test(row.sku) ? 'JIT' : null
  const result = (action: Decision['action'], reason: string, quantity = 0): Decision => ({
    channel,
    action,
    reason,
    quantity,
  })
  if (!channel) return result('skip', 'outside_scope')
  if (['banned', 'stopped', 'closed'].includes(row.listingStatus))
    return result('skip', 'amazon_stopped')
  if (['suppressed', 'unknown'].includes(row.listingStatus))
    return result('review', 'listing_status_unconfirmed')
  if (row.createdAt !== null && row.createdAt > row.observedAt)
    return result('review', 'future_creation_time')
  if (row.sellable === null) return result('review', 'stock_unknown')
  if (row.sellable >= 5) return result('skip', 'target_met')
  if (row.hasOrdered === true || known.hasOrdered)
    return result(
      'receive',
      row.sellable === 0 ? 'ordered_zero_stock' : 'below_target',
      5 - row.sellable,
    )
  if (known.newListing || (row.createdAt !== null && row.createdAt >= enabledAt - 7 * 86_400_000))
    return row.sellable >= 2
      ? result('skip', 'target_met')
      : result('receive', 'new_listing', 2 - row.sellable)
  if (row.hasOrdered === null || row.createdAt === null) return result('review', 'eligibility_unknown')
  return result('skip', row.sellable === 0 ? 'zero_without_eligibility' : 'without_eligibility')
}
