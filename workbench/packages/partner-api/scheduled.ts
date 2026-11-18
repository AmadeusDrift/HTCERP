import type { ConnectionBindings } from '../connections/credentials'
import { daysBefore, salesDay } from '../store-sales/report'
import { sales } from './reads'
import type { Client } from './store'

export async function schedulePartnerSales(env: ConnectionBindings, tick: number) {
  const client =
    await env.DB.prepare(`SELECT c.id,c.name,c.seller,c.marketplace,c.active,c.revision,c.expires_at,c.created_at,c.amazon_revision
    FROM partner_clients c JOIN partner_permissions p ON p.client_id=c.id AND p.permission='sales.read'
    JOIN title_audit_store a ON a.singleton=1 AND a.seller=c.seller
    WHERE c.active=1 AND c.expires_at>? ORDER BY c.created_at LIMIT 1`)
      .bind(tick)
      .first<Client>()
  if (!client) return
  const currentDay = salesDay(new Date(tick))
  for (const date of [currentDay, daysBefore(currentDay, 1)]) {
    try {
      await sales(env, client, { date })
    } catch {
      // The last complete snapshot stays available with its original timestamp.
      console.warn(JSON.stringify({ event: 'partner_sales_refresh_unavailable', date }))
    }
  }
  await env.DB.prepare('DELETE FROM partner_sales_cache WHERE checked_at<?')
    .bind(tick - 7 * 86400000)
    .run()
}
