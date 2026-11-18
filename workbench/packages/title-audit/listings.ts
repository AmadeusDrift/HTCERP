import { z } from 'zod'
import { listingPage } from '../weekly-feedback/model'
export const market = 'ATVPDKIKX0DER'
export const auditPage = z.object({
  numberOfResults: z.number().int().nonnegative(),
  pagination: z.object({ nextToken: z.string().optional() }).optional(),
  items: z.array(
    z.object({
      sku: z.string().min(1),
      attributes: listingPage.shape.items.element.shape.attributes,
      offers: listingPage.shape.items.element.shape.offers,
      summaries: z
        .array(
          z.object({
            marketplaceId: z.string(),
            asin: z.string().optional(),
            itemName: z.string().nullish(),
            lastUpdatedDate: z.string().nullish(),
            mainImage: z.object({ link: z.string() }).nullish(),
            status: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      issues: z
        .array(
          z.object({
            code: z.string(),
            message: z.string(),
            attributeNames: z.array(z.string()).nullish(),
            marketplaceIds: z.array(z.string()).optional(),
            enforcements: z
              .object({
                actions: z.array(z.object({ action: z.string() })),
                exemption: z
                  .object({ status: z.string(), expiryDate: z.string().optional() })
                  .optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
})
export function listingState(item: z.infer<typeof auditPage>['items'][number]) {
  const summary = item.summaries?.find((s) => s.marketplaceId === market)
  const removed = item.issues?.find((issue) => {
    if (issue.marketplaceIds && !issue.marketplaceIds.includes(market)) return false
    const e = issue.enforcements
    return (
      e?.actions.some((a) => ['LISTING_SUPPRESSED', 'CATALOG_ITEM_REMOVED'].includes(a.action)) &&
      (!e.exemption ||
        e.exemption.status === 'NOT_EXEMPT' ||
        (e.exemption.status === 'EXEMPT_UNTIL_EXPIRY_DATE' &&
          Date.parse(e.exemption.expiryDate ?? '') <= Date.now()))
    )
  })
  return {
    sku: item.sku,
    asin: summary?.asin ?? null,
    title: summary?.itemName ?? '',
    disposition: removed
      ? '官方已限制销售'
      : summary?.status?.includes('BUYABLE')
        ? '仍可购买'
        : '状态待确认',
    evidence: removed
      ? removed.code + ' · ' + removed.message
      : summary?.status?.join(' / ') || '无明确销售状态',
  }
}
