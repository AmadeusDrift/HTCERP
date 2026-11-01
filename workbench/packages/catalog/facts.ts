export const sites = { amazon: 1, temu: 48, shein: 2, tiktok: 1, aliexpress: 1 } as const
export type Platform = keyof typeof sites
type Raw = Record<string, unknown>
export interface Origin {
  platform: Platform
  market: 'US'
  evidenceRef: string
  fetchedAt: string | null
  source: string
}

function records(input: unknown): Raw[] {
  return Array.isArray(input)
    ? input.filter((item): item is Raw => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
}
function string(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : null
}
function identifier(input: unknown) {
  return (
    string(input) ?? (typeof input === 'number' && Number.isSafeInteger(input) ? String(input) : null)
  )
}
function numeric(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input) ? input : null
}
function integer(input: unknown) {
  return typeof input === 'number' && Number.isSafeInteger(input) ? input : null
}
export function utc(input: unknown) {
  const value = string(input)
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null
}
function https(input: unknown) {
  const value = string(input)
  if (!value) return null
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}
function metrics(row: Raw, origin: Origin) {
  const field = origin.platform === 'temu' ? 'sold' : 'totalSold'
  return {
    min_price: numeric(row.minPrice),
    currency: 'USD',
    total_sold: integer(row[field]),
    total_sold_field: field,
    day_sold: integer(row.daySold),
    week_sold: integer(row.weekSold),
    month_sold: integer(row.monthSold),
    rating: numeric(row.goodsScore),
    review_count: integer(row.reviewNum),
    source: origin.source,
    fetched_at: origin.fetchedAt,
    evidence_ref: origin.evidenceRef,
  }
}
function variants(input: unknown) {
  let list = input
  if (typeof input === 'string') {
    try {
      list = JSON.parse(input)
    } catch {
      return []
    }
  }
  return records(list).flatMap((item) => {
    const sku_id = identifier(item.skuId)
    if (!sku_id) return []
    const specs = records(item.specs).flatMap((spec) => {
      const specKey = string(spec.specKey),
        specValue = string(spec.specValue)
      return specKey && specValue ? [{ specKey, specValue }] : []
    })
    const stock = integer(item.stock)
    const thumbnail = https(item.thumbUrl)
    return [
      {
        sku_id,
        specs,
        ...(stock != null && stock >= 0 ? { stock } : {}),
        ...(thumbnail && !/geekbi|极鲸云/i.test(thumbnail) ? { thumbnail } : {}),
      },
    ]
  })
}
export function normalizeProduct(row: Raw, origin: Origin) {
  const external_id = identifier(row.goodsId)
  const title = string(row.goodsName) ?? string(row.goodsNameCn) ?? string(row.goodsNameEn)
  const idPattern = origin.platform === 'amazon' ? /^[A-Z0-9]{10}$/ : /^\d+$/
  if (!external_id || !idPattern.test(external_id) || !title) throw new Error('商品 ID 或标题格式错误')
  if (
    !Object.hasOwn(sites, origin.platform) ||
    origin.market !== 'US' ||
    (row.siteId != null && String(row.siteId) !== String(sites[origin.platform]))
  ) {
    throw new Error('商品来源站点不匹配')
  }
  const tree = records(row.catItems).sort((a, b) => Number(a.catLevel) - Number(b.catLevel))
  const root = tree.find((c) => String(c.parentCatId) === '0')
  const label = (cat: Raw) => string(cat.catNameCn) ?? string(cat.catName)
  return {
    id: [origin.platform, origin.market, external_id].join(':'),
    platform: origin.platform,
    market: origin.market,
    external_id,
    title,
    title_cn: string(row.goodsNameCn),
    thumbnail: https(row.thumbnail),
    source_url: origin.platform === 'amazon' ? 'https://www.amazon.com/dp/' + external_id : https(row.linkUrl),
    category_id: root ? identifier(root.catId) : null,
    category_name: root ? label(root) : null,
    category_path: tree.map(label).filter(Boolean).join(' / ') || null,
    max_price: numeric(row.maxPrice),
    shop_id: identifier(row.mallId),
    shop_name: string(row.mallName),
    brand: string(row.brand),
    on_sale_at: utc(row.onSaleTime),
    updated_at: utc(row.updateTime),
    variants_json: JSON.stringify(variants(row.sku)),
    ...metrics(row, origin),
  }
}
export function normalizeHistory(row: Raw, product_id: string, origin: Origin) {
  const observed_at = utc(row.createTime)
  return observed_at ? { product_id, observed_at, ...metrics(row, origin) } : null
}
export const historyColumns = [
  'product_id',
  'observed_at',
  'min_price',
  'currency',
  'total_sold',
  'total_sold_field',
  'day_sold',
  'week_sold',
  'month_sold',
  'rating',
  'review_count',
  'source',
  'fetched_at',
  'evidence_ref',
] as const
