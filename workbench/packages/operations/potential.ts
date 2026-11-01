import { potentialScope, potentialWindow, dayMs } from './potential-scope'

export const gradeLabels = {
  priority: '优先研究',
  watch: '继续观察',
  hold: '暂缓',
  unknown: '待补数据',
  undated: '新发现 · 上架时间待核',
}
export type PotentialGrade = keyof typeof gradeLabels
export interface PotentialItem {
  id: string
  title: string
  category: string
  price: number
  listed: string | null
  observed: string | null
  daySold: number | null
  weekSold: number | null
  grade: PotentialGrade
}
export interface PotentialResult {
  items: PotentialItem[]
  total: number
  page: number
  pageSize: number
  asOf: string
  categories: string[]
}
export async function potentialProducts(
  db: D1Database,
  asOf: string,
  page: number,
  pageSize: number,
  grade?: PotentialGrade,
  category?: string,
): Promise<PotentialResult> {
  const cutoff = potentialWindow(asOf)
  const sinceWeek = new Date(Date.parse(asOf) - 7 * dayMs).toISOString()
  // Each dated candidate has a comparable daily pace only after one full week on sale.
  const sql = `WITH scoped AS (
    SELECT id,coalesce(nullif(title_cn,''),title) title,coalesce(nullif(category_path,''),category_name,'未分类') category,
      min_price price,on_sale_at listed,coalesce(updated_at,fetched_at) observed,day_sold daySold,week_sold weekSold
    FROM products p WHERE platform=? AND market='US' AND currency='USD' AND min_price BETWEEN 0 AND ?
      AND category_id IN (SELECT category_id FROM category_mappings WHERE group_key=? AND platform=p.platform)
      AND (on_sale_at BETWEEN ? AND ? OR (on_sale_at IS NULL AND
        (SELECT json_extract(snapshot_json,'$.fetched_at') FROM product_snapshots
         WHERE product_id=p.id ORDER BY rowid LIMIT 1) BETWEEN ? AND ?))
  ), graded AS (SELECT *, CASE
    WHEN listed IS NULL THEN 'undated'
    WHEN observed IS NULL OR observed NOT BETWEEN ? AND ? OR julianday(observed)-julianday(listed)<7
      OR daySold IS NULL OR weekSold IS NULL OR daySold<0 OR weekSold<daySold THEN 'unknown'
    WHEN weekSold=0 THEN 'hold'
    WHEN 7*daySold>weekSold THEN 'priority' ELSE 'watch' END AS grade FROM scoped)`
  const args = [
    potentialScope.platform,
    potentialScope.maxPrice,
    potentialScope.categoryId,
    cutoff,
    asOf,
    cutoff,
    asOf,
    sinceWeek,
    asOf,
  ]
  const scopeArgs = [...args]
  const conditions = []
  if (grade) {
    conditions.push('grade=?')
    args.push(grade)
  }
  if (category) {
    conditions.push('category=?')
    args.push(category)
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
  const query = sql + ', filtered AS (SELECT * FROM graded' + where + ')'
  const from = ' FROM filtered'
  const [counts, rows, categories] = await db.batch<Record<string, unknown>>([
    db.prepare(query + ' SELECT COUNT(*) AS total' + from).bind(...args),
    db
      .prepare(
        query +
          ' SELECT *' +
          from +
          ` ORDER BY CASE grade WHEN 'priority' THEN 0 WHEN 'watch' THEN 1
      WHEN 'unknown' THEN 2 WHEN 'hold' THEN 3 ELSE 4 END, weekSold DESC, daySold DESC, id
      LIMIT ? OFFSET min(?, max(0,(SELECT (count(*)-1)/?` +
          from +
          ')))*?',
      )
      .bind(...args, pageSize, page - 1, pageSize, pageSize),
    db.prepare(sql + ' SELECT DISTINCT category FROM scoped ORDER BY category').bind(...scopeArgs),
  ])
  const total = Number(counts.results[0].total)
  return {
    asOf,
    total,
    categories: categories.results.map((row) => String(row.category)),
    page: Math.min(page, Math.max(1, Math.ceil(total / pageSize))),
    pageSize,
    items: rows.results as unknown as PotentialItem[],
  }
}
