import { z } from 'zod'
import { acquireSlot, observeLimit } from '../amazon/request-pacing'
import { type LiveEnvironment, type LiveReader, liveInventory, liveListing } from './live'
import type { InventoryObservation } from './rules'
import { sourceConnection, sourceMarket } from './source'
/** A single stock request and authentication per bounded batch; every SKU still needs exact scope evidence. */
export function amazonAutomaticReader(
  env: LiveEnvironment,
  request: typeof fetch = (input, init) => fetch(input, init),
): LiveReader {
  return async (identity, skus, now) => {
    z.array(
      z
        .string()
        .min(1)
        .max(512)
        .refine((s) => !s.includes(',')),
    )
      .min(1)
      .max(10)
      .parse(skus)
    const { credentials: c } = await sourceConnection(env, identity)
    if (!c.SP_CLIENT_ID || !c.SP_CLIENT_SECRET || !c.SP_REFRESH_TOKEN)
      throw Error('SOURCE_CONNECTION_INCOMPLETE')
    const auth = await request('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: c.SP_CLIENT_ID,
        client_secret: c.SP_CLIENT_SECRET,
        refresh_token: c.SP_REFRESH_TOKEN,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
    if (!auth.ok) throw Error('SOURCE_AUTH_FAILED')
    const token = z.object({ access_token: z.string().min(1) }).parse(await auth.json()).access_token
    const headers = { 'x-amz-access-token': token }
    const inventoryResponse = await request(
      'https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?' +
        new URLSearchParams({
          granularityType: 'Marketplace',
          granularityId: sourceMarket,
          marketplaceIds: sourceMarket,
          details: 'true',
          sellerSkus: skus.join(','),
        }),
      { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) },
    )
    if (!inventoryResponse.ok) throw Error('SOURCE_STOCK_READ_FAILED')
    const raw = z
      .object({
        payload: z.object({ inventorySummaries: z.array(z.record(z.string(), z.unknown())) }),
        pagination: z.object({ nextToken: z.string().optional() }).optional(),
      })
      .parse(await inventoryResponse.json())
    if (
      raw.pagination?.nextToken ||
      raw.payload.inventorySummaries.some((r) => !skus.includes(String(r.sellerSku)))
    )
      throw Error('SOURCE_STOCK_SCOPE_CHANGED')
    const observations: InventoryObservation[] = [],
      evidence: unknown[] = []
    const updatedAt: Record<string, number | null> = {}
    for (const sku of skus) {
      const row: InventoryObservation = {
        sellerAccountId: identity.seller,
        marketplaceId: sourceMarket,
        warehouseCode: 'A1C5',
        binCode: 'Default',
        inventoryType: 'GOOD',
        sku,
        sellable: null,
        listingStatus: 'unknown',
        createdAt: null,
        hasOrdered: null,
        observedAt: now,
      }
      try {
        const stock = liveInventory(raw.payload.inventorySummaries, sku)
        await acquireSlot(env.DB, 'listings')
        const listingResponse = await request(
          `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${encodeURIComponent(identity.seller)}/${encodeURIComponent(sku)}?` +
            new URLSearchParams({
              marketplaceIds: sourceMarket,
              includedData: 'summaries,issues,attributes',
              issueLocale: 'en_US',
            }),
          { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) },
        )
        await observeLimit(env.DB, 'listings', listingResponse.headers, listingResponse.status === 429)
        if (!listingResponse.ok) throw Error('SOURCE_LISTING_READ_FAILED')
        const listingRaw = await listingResponse.json(),
          listing = liveListing(listingRaw, sku, now)
        const qualification = await env.DB.prepare(
          `SELECT 1 FROM inventory_source_qualifications q JOIN inventory_source_runs r ON r.id=q.ordered_generation AND r.state='COMPLETE' AND r.seller=q.seller WHERE q.seller=? AND q.sku=? UNION ALL SELECT 1 FROM inventory_order_history_qualifications q JOIN inventory_order_history_runs r ON r.id=q.evidence_run AND r.state='COMPLETE' AND r.seller=q.seller WHERE q.seller=? AND q.sku=? LIMIT 1`,
        )
          .bind(identity.seller, sku, identity.seller, sku)
          .first()
        Object.assign(row, {
          sellable: stock.sellable,
          listingStatus: listing.status,
          createdAt: listing.createdAt,
          hasOrdered: qualification ? true : null,
        })
        updatedAt[sku] = stock.updatedAt
        evidence.push({
          sku,
          inventory: raw.payload.inventorySummaries.filter((r) => r.sellerSku === sku),
          listing: listingRaw,
        })
      } catch {
        updatedAt[sku] = null
        evidence.push({ sku, status: 'READ_UNCONFIRMED' })
      }
      observations.push(row)
    }
    await sourceConnection(env, identity)
    return { observations, updatedAt, evidence }
  }
}
