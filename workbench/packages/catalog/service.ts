import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { marketplaceLink } from '../contracts/presentation'

type DatabaseRow = Record<string, string | number | null>

export const stages = ['candidate', 'watch', 'follow', 'hold', 'reject'] as const
export const lines = ['standard', 'pod'] as const
const platforms = ['temu', 'amazon', 'shein', 'tiktok', 'aliexpress'] as const
export const tiers = ['50k', '30k', '10k', 'below', 'missing'] as const
const sortColumns = [
  'total_sold',
  'min_price',
  'day_sold',
  'week_sold',
  'month_sold',
  'updated_at',
] as const
const numericRanges = {
  Price: 'min_price',
  Sold: 'total_sold',
  DaySold: 'day_sold',
  WeekSold: 'week_sold',
  MonthSold: 'month_sold',
} as const
const nonnegative = z.coerce.number().finite().nonnegative()
const units = nonnegative.int().max(Number.MAX_SAFE_INTEGER)
const day = z.iso.date()
export const catalogQuerySchema = z
  .object({
    q: z.string().trim().max(300).optional(),
    platform: z.enum(platforms).optional(),
    market: z.literal('US').optional(),
    category: z
      .string()
      .regex(/^(home|missing|(temu|amazon|shein|tiktok|aliexpress):\d+)$/)
      .optional(),
    minPrice: nonnegative.optional(),
    maxPrice: nonnegative.optional(),
    minSold: units.optional(),
    maxSold: units.optional(),
    minDaySold: units.optional(),
    maxDaySold: units.optional(),
    minWeekSold: units.optional(),
    maxWeekSold: units.optional(),
    minMonthSold: units.optional(),
    maxMonthSold: units.optional(),
    tier: z.enum(tiers).optional(),
    updatedFrom: day.optional(),
    updatedTo: day.optional(),
    completeness: z.enum(['complete', 'partial']).optional(),
    stage: z.enum(stages).optional(),
    line: z.enum(lines).optional(),
    sort: z.enum(sortColumns).default('total_sold'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: units.min(1).max(1_000_000).default(1),
    pageSize: units.min(1).max(100).default(30),
  })
  .strict()
export const tierTests = {
  '50k': 'p.total_sold>=50000',
  '30k': 'p.total_sold>=30000 AND p.total_sold<50000',
  '10k': 'p.total_sold>=10000 AND p.total_sold<30000',
  below: 'p.total_sold<10000',
  missing: 'p.total_sold IS NULL',
}
const complete = ['min_price', 'total_sold', 'day_sold', 'week_sold', 'month_sold', 'updated_at']
  .map((k) => 'p.' + k + ' IS NOT NULL')
  .join(' AND ')
const columns = [
  'id',
  'platform',
  'market',
  'external_id',
  'title',
  'title_cn',
  'thumbnail',
  'source_url',
  'category_id',
  'category_name',
  'category_path',
  'min_price',
  'max_price',
  'currency',
  'total_sold',
  'day_sold',
  'week_sold',
  'month_sold',
  'rating',
  'review_count',
  'shop_id',
  'shop_name',
  'brand',
  'on_sale_at',
  'updated_at',
  'fetched_at',
]
const select =
  columns.map((k) => 'p.' + k).join(',') +
  ',c.stage,c.lines_json,c.note,c.updated_by,c.updated_at AS feedback_at'
const join = ' FROM products p LEFT JOIN candidates c ON c.product_id=p.id'
function withLines({ lines_json, ...row }: Record<string, unknown>) {
  return { ...row, lines: lines_json ? (JSON.parse(String(lines_json)) as string[]) : [] }
}
function asProduct(row: Record<string, unknown>) {
  const automatic = row.updated_by === 'AI · Terra' || row.updated_by === 'AI · Decisions'
  return {
    ...withLines(row),
    note: automatic && typeof row.note === 'string' ? row.note.split('，依据 ')[0] : row.note,
    source_url: marketplaceLink(row.source_url),
    thumbnail:
      typeof row.thumbnail === 'string' && !/geekbi|极鲸云/i.test(row.thumbnail) ? row.thumbnail : null,
  }
}
function invalid(message: string): never {
  throw new PublicError('INVALID_INPUT', message, 400, 'catalog')
}
function absent(): never {
  throw new PublicError('NOT_FOUND', '没有找到该平台商品。', 404, 'catalog')
}

export async function listProducts(
  db: D1Database,
  input: unknown,
  onlyCandidates = false,
  currency?: 'USD',
) {
  const parsed = catalogQuerySchema.safeParse(input)
  if (!parsed.success) return invalid('筛选条件、日期或分页参数无效。')
  const q = parsed.data
  const where: string[] = onlyCandidates ? ['c.product_id IS NOT NULL'] : []
  const args: (string | number)[] = []
  function filter(test: string, ...values: (string | number)[]) {
    where.push(test)
    args.push(...values)
  }
  if (currency) filter('p.currency=?', currency)
  if (q.platform) filter('p.platform=?', q.platform)
  if (q.market) filter('p.market=?', q.market)
  if (q.category === 'home') {
    filter(
      "EXISTS(SELECT 1 FROM category_mappings m WHERE m.group_key='home' AND m.platform=p.platform AND m.category_id=p.category_id)",
    )
  } else if (q.category === 'missing') filter('p.category_id IS NULL')
  else if (q.category) filter('(p.platform=? AND p.category_id=?)', ...q.category.split(':'))
  if (q.q) {
    const needle = '%' + q.q.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_') + '%'
    const search = ['p.title', 'p.title_cn', 'p.external_id', 'p.source_url']
    filter(
      '(' + search.map((k) => k + " LIKE ? ESCAPE '!'").join(' OR ') + ')',
      ...search.map(() => needle),
    )
  }
  for (const key of Object.keys(numericRanges) as (keyof typeof numericRanges)[]) {
    const min = q[`min${key}`],
      max = q[`max${key}`],
      col = 'p.' + numericRanges[key]
    if (min !== undefined && max !== undefined && min > max) return invalid('范围下限不能超过上限。')
    if (min !== undefined) filter(col + '>=?', min)
    if (max !== undefined) filter(col + '<=?', max)
  }
  if (q.tier) filter('(' + tierTests[q.tier] + ')')
  if (q.completeness) filter((q.completeness === 'partial' ? 'NOT ' : '') + '(' + complete + ')')
  if (q.stage) filter('c.stage=?', q.stage)
  if (q.line) filter('EXISTS(SELECT 1 FROM json_each(c.lines_json) WHERE value=?)', q.line)
  if (q.updatedFrom && q.updatedTo && q.updatedFrom > q.updatedTo)
    return invalid('开始日期不能晚于结束日期。')
  if (q.updatedFrom) filter('p.updated_at>=?', new Date(q.updatedFrom + 'T00:00:00+08:00').toISOString())
  if (q.updatedTo)
    filter(
      'p.updated_at<?',
      new Date(Date.parse(q.updatedTo + 'T00:00:00+08:00') + 86400000).toISOString(),
    )
  const from = join + (where.length ? ' WHERE ' + where.join(' AND ') : '')
  const order =
    onlyCandidates && !(input && typeof input === 'object' && 'sort' in input)
      ? 'c.updated_at'
      : 'p.' + q.sort
  const [count, rows] = await db.batch<DatabaseRow>([
    db.prepare('SELECT COUNT(*) AS n' + from).bind(...args),
    db
      .prepare(
        'SELECT ' +
          select +
          from +
          ' ORDER BY ' +
          order +
          ' ' +
          q.order +
          ' NULLS LAST,p.id LIMIT ? OFFSET ?',
      )
      .bind(...args, q.pageSize, (q.page - 1) * q.pageSize),
  ])
  return {
    items: rows.results.map(asProduct),
    total: Number(count.results[0].n),
    page: q.page,
    pageSize: q.pageSize,
  }
}
export async function readProduct(db: D1Database, id: string) {
  const [found, hist, notes, snap] = await db.batch<DatabaseRow>([
    db.prepare('SELECT ' + select + ',p.variants_json' + join + ' WHERE p.id=?').bind(id),
    // Multiple responses may repeat the same dated observation. Keep immutable evidence; show the latest version per instant.
    db
      .prepare(
        'SELECT * FROM (SELECT o.*,row_number() OVER(PARTITION BY observed_at ORDER BY fetched_at DESC,evidence_ref DESC) AS version FROM observations o WHERE product_id=?) WHERE version=1 ORDER BY observed_at DESC LIMIT 366',
      )
      .bind(id),
    db
      .prepare(
        'SELECT stage,lines_json,note,author,created_at FROM feedback WHERE product_id=? ORDER BY id DESC LIMIT 101',
      )
      .bind(id),
    db
      .prepare(
        'SELECT ' +
          [
            'updated_at',
            'fetched_at',
            'min_price',
            'currency',
            'total_sold',
            'day_sold',
            'week_sold',
            'month_sold',
          ]
            .map((k) => "json_extract(snapshot_json,'$." + k + "') AS " + k)
            .join(',') +
          ' FROM product_snapshots WHERE product_id=? ORDER BY fetched_at DESC,updated_at DESC LIMIT 101',
      )
      .bind(id),
  ])
  if (!found.results[0]) return absent()
  const { variants_json, ...row } = found.results[0]
  return {
    product: asProduct(row),
    variants: JSON.parse(String(variants_json)) as Record<string, unknown>[],
    history: hist.results
      .slice(0, 365)
      .reverse()
      .map(
        ({ version, product_id, source, evidence_ref, total_sold_field, ...observation }) => observation,
      ),
    feedback: notes.results.slice(0, 100).map(withLines),
    snapshots: snap.results.slice(0, 100),
    hasMore: {
      history: hist.results.length > 365,
      feedback: notes.results.length > 100,
      snapshots: snap.results.length > 100,
    },
  }
}
