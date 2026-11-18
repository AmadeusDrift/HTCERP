import { z } from 'zod'

export const marketplace = 'ATVPDKIKX0DER'
export const states = ['pending', 'working', 'verified', 'closed'] as const
export const stateNames = { pending: '待确认', working: '处理中', verified: '待验证', closed: '已关闭' }
export type Topic = {
  name: string
  mentions: number | null
  snippets: string[]
  occurrence?: number | null
  impact?: number | null
}
export type Feedback = {
  asin: string
  period: { startDate: string; endDate: string } | null
  topics: Topic[]
  lowRatingCount?: number
}
export const listingPage = z.object({
  numberOfResults: z.number().int().nonnegative(),
  pagination: z.object({ nextToken: z.string().optional() }).optional(),
  items: z.array(
    z.object({
      sku: z.string().min(1),
      attributes: z
        .object({
          parentage_level: z
            .array(z.object({ marketplace_id: z.string().optional(), value: z.string() }))
            .optional(),
        })
        .catchall(z.unknown())
        .optional(),
      offers: z
        .array(
          z.object({
            marketplaceId: z.string().optional(),
            audience: z.object({ value: z.string().nullish() }).nullish(),
          }),
        )
        .nullish(),
      summaries: z
        .array(
          z.object({
            marketplaceId: z.string(),
            asin: z
              .string()
              .regex(/^[A-Z0-9]{10}$/)
              .optional(),
            itemName: z.string().nullish(),
            mainImage: z.object({ link: z.string() }).nullish(),
          }),
        )
        .optional(),
      relationships: z
        .array(
          z.object({
            marketplaceId: z.string(),
            relationships: z
              .array(
                z.object({
                  type: z.string().nullish(),
                  parentSkus: z.array(z.string()).nullish(),
                  childSkus: z.array(z.string()).nullish(),
                }),
              )
              .nullish(),
          }),
        )
        .optional(),
    }),
  ),
})
export function safeImage(value?: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images.amazon.com'].includes(
        url.hostname,
      )
      ? url.href
      : null
  } catch {
    return null
  }
}
export function listingProduct(item: z.infer<typeof listingPage>['items'][number]) {
  const summary = item.summaries?.find((s) => s.marketplaceId === marketplace)
  const groups = item.relationships?.filter((g) => g.marketplaceId === marketplace)
  let role: 'child' | 'parent' | 'standalone' | 'unknown' = 'unknown'
  if (groups?.length === 1 && groups[0].relationships) {
    const relations = groups[0].relationships
    if (!relations.length) role = 'standalone'
    else {
      const variations = relations.filter((r) => r.type === 'VARIATION')
      if (
        variations.length &&
        relations.every((r) => ['VARIATION', 'PACKAGE_HIERARCHY'].includes(r.type ?? ''))
      ) {
        if (variations.every((r) => r.parentSkus?.length && !r.childSkus?.length)) role = 'child'
        else if (variations.every((r) => r.childSkus?.length && !r.parentSkus?.length)) role = 'parent'
      }
    }
  }
  const parentage = new Set(
    item.attributes?.parentage_level
      ?.filter((entry) => !entry.marketplace_id || entry.marketplace_id === marketplace)
      .map((entry) => entry.value),
  )
  const variation = groups?.some((group) => group.relationships?.some((r) => r.type === 'VARIATION'))
  if (parentage.size === 1 && !variation && (parentage.has('parent') || parentage.has('child')))
    role = parentage.has('parent') ? 'parent' : 'child'
  else if (
    parentage.size > 0 &&
    (role === 'parent' || role === 'child') &&
    (parentage.size !== 1 || !parentage.has(role))
  )
    role = 'unknown'
  else if (summary && item.relationships?.length === 0 && parentage.size === 0) role = 'standalone'
  return {
    sku: item.sku,
    asin: summary?.asin ?? null,
    title: summary?.itemName ?? '',
    image: safeImage(summary?.mainImage?.link),
    role,
  }
}
export function feedbackWeek(now: number) {
  const day = new Date(now + 8 * 3600000)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}
export function mergeTopics(...rankings: Topic[][]): Topic[] {
  const found = new Map<string, Topic>()
  for (const topic of rankings.flat()) {
    const key = topic.name.trim().toLowerCase()
    const prior = found.get(key)
    found.set(key, {
      ...topic,
      mentions: prior?.mentions ?? topic.mentions,
      snippets: [...new Set([...(prior?.snippets ?? []), ...topic.snippets])],
    })
  }
  return [...found.values()].sort((a, b) => (b.mentions ?? -1) - (a.mentions ?? -1))
}
// These are topic labels and investigation suggestions, never a diagnosis of the underlying cause.
const reasons: [RegExp, string, string][] = [
  [/print|ink|printing/i, '印刷质量', '核对印刷文件、成品清晰度及近期生产批次。'],
  [/size|sizing|fit|dimension/i, '尺寸与适配', '核对尺寸表、变体规格及页面适配说明。'],
  [/packag|broken|damag/i, '包装与破损', '核对包装防护、运输破损和近期退货记录。'],
  [/missing|parts|accessor/i, '缺件与配件', '核对装箱清单、配件数量及出库复核。'],
  [/durab|quality|sturd|material/i, '材质与耐用性', '核对实物材质、使用场景及近期质量记录。'],
  [/assembl|install|instruction|ease of use/i, '安装与使用', '核对安装步骤、说明书及页面使用指引。'],
  [/color|colour|appearance/i, '颜色与外观', '核对实物颜色、展示图片及变体对应关系。'],
  [/smell|odor/i, '气味', '核对材料、包装存储与相关质量记录。'],
  [/deliver|shipping/i, '配送体验', '核对配送履约及相关物流记录。'],
  [/description|advertis/i, '描述与实物差异', '对照商品页面与实物，确认是否需要补充说明。'],
]
export function reasonFor(topic: string) {
  const match = reasons.find(([pattern]) => pattern.test(topic))
  return {
    label: match?.[1] ?? '待人工归类',
    action: match?.[2] ?? '结合原始主题与摘录核实问题，再确定处理动作。',
  }
}
