import { z } from 'zod'
import type { ConnectionBindings } from '../connections/credentials'
import { sourceChannel } from '../inventory-sync/source'
import { marketplace, priceInput, quantityInput, type WritePermission } from './permissions'
import { boundConnection, inventory, partnerAmazon } from './reads'
import { type PartnerRequest, type PartnerStore, requestView } from './store'

const listing = z.object({
  sku: z.string(),
  summaries: z.array(z.object({ marketplaceId: z.string(), productType: z.string().min(1) })),
  attributes: z.record(z.string(), z.unknown()).optional(),
  fulfillmentAvailability: z
    .array(
      z.object({
        fulfillmentChannelCode: z.string(),
        quantity: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
})
const liveOffers = z.object({
  sku: z.string(),
  offers: z
    .array(
      z.object({
        marketplaceId: z.string(),
        audience: z.object({ value: z.string() }).nullish(),
        price: z
          .object({ amount: z.union([z.string(), z.number().finite()]), currency: z.string() })
          .nullish(),
      }),
    )
    .optional(),
})

export function livePriceCents(raw: unknown, input: z.infer<typeof priceInput>) {
  const listing = liveOffers.safeParse(raw)
  if (!listing.success || listing.data.sku !== input.sku) return null
  const match = listing.data.offers?.filter(
    (offer) =>
      offer.marketplaceId === marketplace &&
      offer.audience?.value === input.audience &&
      offer.price?.currency === 'USD',
  )
  if (match?.length !== 1) return null
  const price = String(match[0].price?.amount)
  return /^\d{1,9}(?:\.\d{1,2})?$/.test(price) ? Math.round(Number(price) * 100) : null
}
const offer = z
  .object({
    marketplace_id: z.literal(marketplace),
    currency: z.literal('USD'),
    audience: z.enum(['ALL', 'BZR', 'B2B']).optional(),
    our_price: z
      .array(
        z
          .object({
            schedule: z
              .array(
                z
                  .object({
                    value_with_tax: z.number().finite().positive(),
                    start_at: z.string().nullish(),
                    end_at: z.string().nullish(),
                  })
                  .passthrough(),
              )
              .length(1),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough()

type Current = { value: number; patch: { op: 'merge' | 'replace'; path: string; value: unknown[] } }

export function changeFor(
  raw: unknown,
  operation: WritePermission,
  input: unknown,
): { productType: string; change: Current } | null {
  const parsed = listing.safeParse(raw)
  if (!parsed.success) return null
  const matching = parsed.data.summaries.filter((s) => s.marketplaceId === marketplace)
  if (matching.length !== 1) return null
  const productType = matching[0].productType
  if (operation === 'inventory.quantity.write') {
    const requested = quantityInput.parse(input)
    const availability = parsed.data.fulfillmentAvailability
    if (
      parsed.data.sku !== requested.sku ||
      sourceChannel(requested.sku) ||
      availability?.length !== 1 ||
      availability[0].fulfillmentChannelCode !== 'DEFAULT' ||
      availability[0].quantity === undefined
    )
      return null
    return {
      productType,
      change: {
        value: availability[0].quantity,
        patch: {
          op: 'merge',
          path: '/attributes/fulfillment_availability',
          value: [{ fulfillment_channel_code: 'DEFAULT', quantity: requested.quantity }],
        },
      },
    }
  }
  if (operation !== 'price.write') return null
  const requested = priceInput.parse(input)
  if (parsed.data.sku !== requested.sku) return null
  const all = parsed.data.attributes?.purchasable_offer
  if (!Array.isArray(all)) return null
  const selectors = z
    .array(
      z.object({ marketplace_id: z.string(), audience: z.string().optional(), currency: z.string() }),
    )
    .safeParse(all)
  if (!selectors.success) return null
  const indices = selectors.data.flatMap((entry, index) =>
    entry.marketplace_id === marketplace &&
    entry.currency === 'USD' &&
    (entry.audience ?? 'ALL') === requested.audience
      ? [index]
      : [],
  )
  if (indices.length !== 1) return null
  const selected = offer.safeParse(all[indices[0]])
  if (!selected.success) return null
  const current = selected.data.our_price[0]
  const schedule = current.schedule[0]
  if (schedule.start_at || schedule.end_at) return null
  const patched = {
    marketplace_id: marketplace,
    currency: 'USD',
    audience: requested.audience,
    our_price: [{ schedule: [{ value_with_tax: requested.cents / 100 }] }],
  }
  return {
    productType,
    change: {
      value: Math.round(schedule.value_with_tax * 100),
      patch: {
        op: 'merge',
        path: '/attributes/purchasable_offer',
        value: [patched],
      },
    },
  }
}

export async function approveWrite(
  env: ConnectionBindings,
  store: PartnerStore,
  request: PartnerRequest,
  reviewer: string,
) {
  const input: unknown = JSON.parse(request.input_json)
  if (request.operation === 'inventory.request') {
    await partnerAmazon(env, await store.requireClient(request.client_id))
    return requestView(await store.claim(request.id, reviewer, 'APPROVED'))
  }
  const price = request.operation === 'price.write'
  const { sku } = price ? priceInput.parse(input) : quantityInput.parse(input)
  const expected = price
    ? priceInput.parse(input).expectedCents
    : quantityInput.parse(input).expectedQuantity
  const target = price ? priceInput.parse(input).cents : quantityInput.parse(input).quantity
  const row = await store.claim(request.id, reviewer, 'SENDING')
  const client = await store.requireClient(row.client_id)
  let sent = false
  const finish = async (status: PartnerRequest['status'], outcome: string, reference?: string | null) =>
    requestView(await store.finish(row.id, 'SENDING', status, outcome, reference))
  try {
    const canSend = async () => {
      await boundConnection(env, client)
      return store.canSend(row.id)
    }
    const { amazon } = await partnerAmazon(env, client, canSend)
    if (!price && sourceChannel(sku)) {
      const warehouse = await inventory(env.DB, client, sku)
      if (!warehouse.item || warehouse.item.sellable !== expected)
        return finish('REJECTED', 'CURRENT_VALUE_CHANGED')
      if (!(await canSend())) return finish('CANCELLED', 'PERMISSION_CHANGED')
      return finish('APPROVED', 'WAREHOUSE_ACTION_REQUIRED')
    }
    const fetchListing = () =>
      amazon.partnerListing(client.seller, sku, 'summaries,attributes,fulfillmentAvailability,offers')
    const initial = await fetchListing()
    const current = changeFor(initial, row.operation, input)
    if (!current)
      return finish('REJECTED', price ? 'OFFER_NOT_ELIGIBLE' : 'INVENTORY_CHANNEL_NOT_SUPPORTED')
    if (current.change.value !== expected) return finish('REJECTED', 'CURRENT_VALUE_CHANGED')
    if (target === expected)
      return price && livePriceCents(initial, priceInput.parse(input)) !== target
        ? finish('UNKNOWN', 'CHECK_AMAZON_BEFORE_RETRY')
        : finish('CONFIRMED', 'ALREADY_AT_TARGET')
    const patch = { productType: current.productType, patches: [current.change.patch] }
    const preview = await amazon.partnerPatch(client.seller, sku, patch, true)
    if (preview.outcome === 'ACCEPTED')
      return finish('UNKNOWN', 'UNEXPECTED_PREVIEW_ACCEPTED', preview.reference)
    if (!preview.accepted) return finish('REJECTED', 'VALIDATION_' + preview.outcome, preview.reference)
    if (
      JSON.stringify(changeFor(await fetchListing(), row.operation, input)) !== JSON.stringify(current)
    )
      return finish('REJECTED', 'CURRENT_VALUE_CHANGED')
    const result = await amazon.partnerPatch(client.seller, sku, patch, false, () => {
      sent = true
    })
    return finish(
      result.accepted ? 'ACCEPTED' : 'REJECTED',
      'AMAZON_' + result.outcome,
      result.reference,
    )
  } catch {
    return finish(sent ? 'UNKNOWN' : 'REJECTED', sent ? 'CHECK_AMAZON_BEFORE_RETRY' : 'PRECHECK_FAILED')
  }
}

export async function reconcileWrite(env: ConnectionBindings, store: PartnerStore, row: PartnerRequest) {
  const client = await store.requireClient(row.client_id)
  const { amazon } = await partnerAmazon(env, client)
  const input = JSON.parse(row.input_json)
  const price = row.operation === 'price.write'
  const { sku } = price ? priceInput.parse(input) : quantityInput.parse(input)
  const expected = price ? priceInput.parse(input).cents : quantityInput.parse(input).quantity
  const raw = await amazon.partnerListing(
    client.seller,
    sku,
    'summaries,attributes,fulfillmentAvailability,offers',
  )
  const value = price
    ? livePriceCents(raw, priceInput.parse(input))
    : changeFor(raw, row.operation, input)?.change.value
  if (value !== expected) return requestView(row)
  return requestView(await store.finish(row.id, row.status, 'CONFIRMED', 'LIVE_TARGET_OBSERVED'))
}
