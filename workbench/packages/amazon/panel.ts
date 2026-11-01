import { type ConnectionBindings, connectionStatus } from '../connections/credentials'
import { productAutomation } from './research-links'

export async function readAmazonPanel(env: ConnectionBindings, id: string) {
  const [matches, searches] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT m.asin,m.latest_search AS searchId,m.status,m.note,m.reviewed_at AS reviewedAt,m.reviewer,e.snapshot,
      s.fetched_at AS fetchedAt,s.query, p.price,p.currency,p.shipping,p.status AS priceStatus,p.fetched_at AS priceFetchedAt
      FROM amazon_matches m JOIN amazon_catalog_evidence e ON e.search_id=m.latest_search AND e.asin=m.asin
      JOIN amazon_searches s ON s.id=e.search_id LEFT JOIN amazon_prices p ON p.id=(
      SELECT MAX(ap.id) FROM amazon_prices ap WHERE ap.product_id=m.product_id AND ap.asin=m.asin)
      WHERE m.product_id=? ORDER BY s.fetched_at DESC,m.asin LIMIT 100`).bind(id),
    env.DB.prepare(`SELECT s.id,s.query,s.fetched_at AS fetchedAt,s.returned,
        EXISTS(SELECT 1 FROM amazon_pages p WHERE p.search_id=s.id AND p.next_token IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM amazon_pages child WHERE child.parent_id=p.search_id)) AS hasMore,'succeeded' AS status
        FROM amazon_searches s WHERE s.product_id=? UNION ALL
        SELECT id,query,fetched_at,NULL,0,status FROM amazon_search_failures WHERE product_id=?
        ORDER BY fetchedAt DESC LIMIT 20`).bind(id, id),
  ])
  return {
    matches: matches.results.map(({ snapshot, ...row }) => ({
      ...JSON.parse(String(snapshot)),
      ...row,
    })),
    searches: searches.results.map((row) => ({ ...row, hasMore: Boolean(row.hasMore) })),
    configured: (await connectionStatus(env)).amazon,
    automation: await productAutomation(env.DB, id),
    market: 'Amazon US',
    haul: false,
  }
}
