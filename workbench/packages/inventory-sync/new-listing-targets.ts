import { salesSkuOwners, salesTeamMembers } from '../store-sales/assignments'
import {
  type DailySalesGroups,
  dailySalesSkuTeam,
  dailySalesTeams,
  skuIsJimei,
} from '../store-sales/daily'

export async function fiveUnitNewListings(db: D1Database, seller: string, skus: string[]) {
  const candidates = skus.filter((sku) => !skuIsJimei(sku))
  if (!candidates.length) return new Set<string>()
  const [ownerOf, groups, { results }] = await Promise.all([
    salesSkuOwners(db, seller, candidates),
    salesTeamMembers(db),
    db
      .prepare('SELECT sku,team FROM daily_sales_sku_teams WHERE sku IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(candidates))
      .all<{ sku: string; team: keyof DailySalesGroups }>(),
  ])
  const confirmed = new Map(results.map(({ sku, team }) => [sku, team]))
  return new Set(
    candidates.filter((sku) => {
      const owner = ownerOf(sku)
      const assigned = owner
        ? dailySalesTeams.find((team) => groups[team].includes(owner))
        : confirmed.get(sku)
      const team = dailySalesSkuTeam(sku, assigned)
      return team === 'a' || team === 'b'
    }),
  )
}
