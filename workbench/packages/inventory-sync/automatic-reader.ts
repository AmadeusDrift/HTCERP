import { z } from 'zod'
import { acquireSlot, observeLimit } from '../amazon/request-pacing'
import { type LiveEnvironment, type LiveReader, liveInventory, liveListing } from './live'
import type { InventoryObservation } from './rules'
import { sourceConnection, sourceMarket } from './source'

export const automaticReadGroupSize = 40
const defaultRequest: typeof fetch = (input, init) => fetch(input, init)
let cachedToken: { revision: string; value: string; expiresAt: number } | undefined

/** Every SKU still needs exact scope evidence, even when submitted in a larger file. */
export function amazonAutomaticReader(
  env: LiveEnvironment,
  request: typeof fetch = defaultRequest,
): LiveReader {
  return async (identity, skus, now, bulk) => {
    z.array(
      z
        .string()
        .min(1)
        .max(512)
        .refine((s) => !s.includes(',')),
    )
      .min(1)
      .max(bulk ? automaticReadGroupSize : 10)
      .parse(skus)
    const { credentials: c } = await sourceConnection(env, identity)
    if (!c.SP_CLIENT_ID || !c.SP_CLIENT_SECRET || !c.SP_REFRESH_TOKEN)
      throw Error('SOURCE_CONNECTION_INCOMPLETE')
    async function authenticate(credentials: typeof c & {
      SP_CLIENT_ID: string; SP_CLIENT_SECRET: string; SP_REFRESH_TOKEN: string
    }) {
      if (bulk && request === defaultRequest && cachedToken?.revision === identity.revision
        && Date.now() < cachedToken.expiresAt) return cachedToken.value
      const auth = await request('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.SP_CLIENT_ID,
        client_secret: credentials.SP_CLIENT_SECRET,
        refresh_token: credentials.SP_REFRESH_TOKEN,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
      if (!auth.ok) throw Error('SOURCE_AUTH_FAILED')
      const { access_token, expires_in } = z.object({
        access_token: z.string().min(1), expires_in: z.number().positive().optional(),
      }).parse(await auth.json())
      if (bulk && request === defaultRequest)
        cachedToken = { revision: identity.revision, value: access_token,
          expiresAt: Date.now() + Math.max(0, (expires_in ?? 300) - 60) * 1000 }
      return access_token
    }
    const token = await authenticate({ ...c, SP_CLIENT_ID: c.SP_CLIENT_ID,
      SP_CLIENT_SECRET: c.SP_CLIENT_SECRET, SP_REFRESH_TOKEN: c.SP_REFRESH_TOKEN })
    const headers = { 'x-amz-access-token': token }
    const signal = bulk ? AbortSignal.timeout(20_000) : undefined
    const inventoryPath = 'https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?'
    const listingsPath = 'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/' +
      encodeURIComponent(identity.seller)
    const inventoryResult = z.object({
      payload: z.object({ inventorySummaries: z.array(z.record(z.string(), z.unknown())) }),
      pagination: z.object({ nextToken: z.string().optional() }).optional(),
    })
    async function stockRows() {
      const rows: Record<string, unknown>[] = []
      const pages = new Set<string>()
      let next: string | undefined
      do {
        const query = new URLSearchParams({
          granularityType: 'Marketplace',
          granularityId: sourceMarket,
          marketplaceIds: sourceMarket,
          details: 'true',
          sellerSkus: skus.join(','),
        })
        if (next) query.set('nextToken', next)
        if (bulk) await acquireSlot(env.DB, 'inventory-read', 2500)
        const response = await request(inventoryPath + query, {
          headers, redirect: 'manual', signal: signal ?? AbortSignal.timeout(20000),
        })
        if (bulk) await observeLimit(env.DB, 'inventory-read', response.headers, response.status === 429)
        if (response.status === 401) cachedToken = undefined
        if (!response.ok) throw Error('SOURCE_STOCK_READ_FAILED')
        const page = inventoryResult.parse(await response.json())
        rows.push(...page.payload.inventorySummaries)
        next = page.pagination?.nextToken
        if (next && (!bulk || pages.has(next) || pages.size >= 8))
          throw Error('SOURCE_STOCK_SCOPE_CHANGED')
        if (next) pages.add(next)
      } while (next)
      if (rows.some((r) => !skus.includes(String(r.sellerSku))))
        throw Error('SOURCE_STOCK_SCOPE_CHANGED')
      return rows
    }
    async function listingGroup(group: string[]) {
      const query = new URLSearchParams({
        marketplaceIds: sourceMarket, includedData: 'summaries,issues,attributes',
        issueLocale: 'en_US', identifiersType: 'SKU', identifiers: group.join(','), pageSize: '20',
      })
      const records = new Map<string, Record<string, unknown>>()
      const pages = new Set<string>()
      for (;;) {
        await acquireSlot(env.DB, 'listings', 4500)
        const response = await request(listingsPath + '?' + query, { headers, redirect: 'manual', signal })
        await observeLimit(env.DB, 'listings', response.headers, response.status === 429)
        if (response.status === 401) cachedToken = undefined
        if (!response.ok) throw Error('SOURCE_LISTING_READ_FAILED')
        const page = z.object({
          items: z.array(z.object({ sku: z.string() }).passthrough()),
          pagination: z.object({ nextToken: z.string().optional() }).optional(),
        }).parse(await response.json())
        for (const item of page.items) {
          if (!group.includes(item.sku) || records.has(item.sku))
            throw Error('SOURCE_LISTING_SCOPE_CHANGED')
          records.set(item.sku, item)
        }
        const next = page.pagination?.nextToken
        if (!next) return records
        if (pages.has(next) || pages.size >= 8) throw Error('SOURCE_LISTING_SCOPE_CHANGED')
        pages.add(next)
        query.set('pageToken', next)
      }
    }
    const [inventory, firstListings, secondListings] = await Promise.all([
      stockRows(), bulk ? listingGroup(skus.slice(0, 20)) : null,
      bulk && skus.length > 20 ? listingGroup(skus.slice(20)) : null,
    ])
    const packet = JSON.stringify(skus)
    const ordered = new Set((await env.DB.prepare(`SELECT q.sku FROM inventory_source_qualifications q
      JOIN inventory_source_runs r ON r.id=q.ordered_generation AND r.state='COMPLETE' AND r.seller=q.seller
      WHERE q.seller=? AND q.sku IN(SELECT value FROM json_each(?))
      UNION SELECT q.sku FROM inventory_order_history_qualifications q
      JOIN inventory_order_history_runs r ON r.id=q.evidence_run AND r.state='COMPLETE' AND r.seller=q.seller
      WHERE q.seller=? AND q.sku IN(SELECT value FROM json_each(?))`)
      .bind(identity.seller, packet, identity.seller, packet).all<{ sku: string }>()).results.map(r=>r.sku))
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
        const stock = liveInventory(inventory, sku)
        let listingRaw = firstListings?.get(sku) ?? secondListings?.get(sku)
        if (!bulk) {
          await acquireSlot(env.DB, 'listings')
          const listingResponse = await request(
          listingsPath + '/' + encodeURIComponent(sku) + '?' +
            new URLSearchParams({
              marketplaceIds: sourceMarket,
              includedData: 'summaries,issues,attributes',
              issueLocale: 'en_US',
            }),
          { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) },
        )
          await observeLimit(env.DB, 'listings', listingResponse.headers, listingResponse.status === 429)
          if (!listingResponse.ok) throw Error('SOURCE_LISTING_READ_FAILED')
          listingRaw = await listingResponse.json() as Record<string, unknown>
        }
        const listing = liveListing(listingRaw, sku, now)
        Object.assign(row, {
          sellable: stock.sellable,
          listingStatus: listing.status,
          createdAt: listing.createdAt,
          hasOrdered: ordered.has(sku) ? true : null,
        })
        updatedAt[sku] = stock.updatedAt
        evidence.push({
          sku,
          inventory: inventory.filter((r) => r.sellerSku === sku),
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
