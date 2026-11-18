import { marketplace } from '../weekly-feedback/model'
import { feedbackOwnerRules, matchFeedbackOwner } from '../weekly-feedback/owner-rules'
import type { DailySalesGroups } from './daily'

export async function salesTeamMembers(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT t.team,t.account_id FROM daily_sales_team_members t
      JOIN accounts a ON a.id=t.account_id WHERE a.active=1 AND a.role IN ('operator','admin')`)
    .all<{ team: keyof DailySalesGroups; account_id: string }>()
  const groups: DailySalesGroups = { a: [], b: [], c: [] }
  for (const row of results) groups[row.team].push(row.account_id)
  return groups
}

export async function salesSkuOwners(db: D1Database, seller: string, skus: readonly string[]) {
  const rules = await feedbackOwnerRules(db, seller)
  const assignments = new Map<string, { id: string; source: string }>()
  for (let offset = 0; offset < skus.length; offset += 80) {
    const batch = skus.slice(offset, offset + 80)
    const { results } = await db
      .prepare(`SELECT o.sku,a.id,o.source FROM weekly_feedback_owners o JOIN accounts a ON a.id=o.account_id
        WHERE o.seller=? AND o.marketplace=? AND a.active=1 AND a.role IN ('operator','admin')
        AND o.sku IN (${batch.map(() => '?').join(',')})`)
      .bind(seller, marketplace, ...batch)
      .all<{ sku: string; id: string; source: string }>()
    for (const row of results) assignments.set(row.sku, row)
  }
  return (sku: string) => {
    const saved = assignments.get(sku)
    return saved?.source === 'manual'
      ? saved.id
      : matchFeedbackOwner(sku, rules)?.account_id ?? saved?.id ?? null
  }
}
