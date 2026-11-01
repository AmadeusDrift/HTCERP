import { AmazonUS } from '../../../packages/amazon/adapter'
import { haulPriceTier } from '../../../packages/amazon/haul-price-tier'
import { providerCredentials, type ConnectionBindings } from '../../../packages/connections/credentials'

// Only screen a product present in the selected archived report.
export async function screenReportProduct(env: ConnectionBindings, runId: string, productId: string, query: string) {
  const member = await env.DB.prepare(`SELECT 1 FROM admin_daily_reports, json_each(report_json,'$.items') i
    WHERE run_id=? AND json_extract(i.value,'$.id')=? LIMIT 1`).bind(runId, productId).first()
  if (!member || !query.trim() || query.length > 160) throw new Error('Invalid report item or query')
  const { credentials } = await providerCredentials(env, 'amazon')
  const api = new AmazonUS(credentials, undefined, env.DB)
  const page = await api.search(query, 6)
  const candidates = []
  const prices = await api.batchOffers(page.items.map(item => item.asin))
  for (const item of page.items.slice(0, 6)) {
    const offer = prices.get(item.asin) ?? { price: null, currency: null, shipping: null }
    candidates.push({ asin: item.asin, title: item.title, ...offer, tier: haulPriceTier(offer.price) })
  }
  return { productId, query, checkedAt: new Date().toISOString(), candidates }
}
