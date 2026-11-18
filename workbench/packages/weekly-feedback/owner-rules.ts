import { z } from 'zod'
import { marketplace, type listingPage } from './model'

type Listing = z.infer<typeof listingPage>['items'][number]
const haulAttributes = z.object({
  marketplace_id: z.string().nullish(),
  value: z.unknown().optional(),
  audience: z.unknown().optional(),
})

export function isHaulListing(item: Pick<Listing, 'attributes' | 'offers'>) {
  const attributes = item.attributes
  const includes = (key: string, field: 'value' | 'audience', value: boolean | string) => {
    const entries = attributes?.[key]
    return (
      Array.isArray(entries) &&
      entries.some((raw: unknown) => {
        const entry = haulAttributes.safeParse(raw)
        return (
          entry.success &&
          (!entry.data.marketplace_id || entry.data.marketplace_id === marketplace) &&
          entry.data[field] === value
        )
      })
    )
  }
  return (
    includes('is_value_stores_item', 'value', true) ||
    includes('is_value_store_item', 'value', true) ||
    includes('purchasable_offer', 'audience', 'BZR') ||
    item.offers?.some(
      (offer) => offer.marketplaceId === marketplace && offer.audience?.value === 'BZR',
    ) === true
  )
}

type OwnerRule = {
  match_type: 'prefix' | 'prefix_suffix' | 'contains_suffix'
  pattern: string
  priority: number
  account_id: string
  configured_by: string
  active: number
}

export async function feedbackOwnerRules(db: D1Database, seller: string) {
  return (
    await db
      .prepare(`SELECT r.*, a.active AND a.role IN ('operator','admin') active
    FROM weekly_feedback_owner_rules r JOIN accounts a ON a.id=r.account_id
    WHERE r.seller=? AND r.marketplace=? ORDER BY r.priority`)
      .bind(seller, marketplace)
      .all<OwnerRule>()
  ).results
}

export function matchFeedbackOwner(sku: string, rules: OwnerRule[]) {
  const key = sku.toUpperCase()
  const matches = rules.filter((rule) => {
    const index =
      rule.match_type === 'contains_suffix'
        ? key.indexOf(rule.pattern)
        : key.startsWith(rule.pattern)
          ? 0
          : -1
    return index >= 0 && (rule.match_type === 'prefix' || index + rule.pattern.length < key.length)
  })
  const candidates = matches.filter((rule) => rule.priority === matches[0]?.priority)
  const owner = candidates[0]
  if (!owner?.active || candidates.some((rule) => rule.account_id !== owner.account_id)) return null
  return owner
}

export function automaticFeedbackOwner(db: D1Database, seller: string, sku: string, rules: OwnerRule[]) {
  const owner = matchFeedbackOwner(sku, rules)
  if (!owner) return null
  return db
    .prepare(`INSERT INTO weekly_feedback_owners(seller,marketplace,sku,account_id,source,updated_by,updated_at)
    VALUES(?,?,?,?,'haul-owner-rule',?,?) ON CONFLICT(seller,marketplace,sku) DO NOTHING`)
    .bind(seller, marketplace, sku, owner.account_id, owner.configured_by, new Date().toISOString())
}
