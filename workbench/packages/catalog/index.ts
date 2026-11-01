import { Hono } from 'hono'
import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { lines, listProducts, readProduct, stages, tiers, tierTests } from './service'

export type CatalogEnv = {
  Bindings: { DB: D1Database }
  Variables: { actor: { email: string; role: 'admin' | 'operator' | 'viewer' } }
}
export const catalog = new Hono<CatalogEnv>()
type DatabaseRow = Record<string, string | number | null>

function invalid(message: string): never {
  throw new PublicError('INVALID_INPUT', message, 400, 'catalog')
}
function absent(): never {
  throw new PublicError('NOT_FOUND', '没有找到该平台商品。', 404, 'catalog')
}
catalog.get('/products', async (c) => c.json(await listProducts(c.env.DB, c.req.query())))
catalog.get('/candidates', async (c) => c.json(await listProducts(c.env.DB, c.req.query(), true)))
catalog.get('/catalog/meta', async (c) => {
  const db = c.env.DB
  const [summary, byPlatform, sourceCategories, byTier, mappings] = await db.batch<DatabaseRow>([
    db.prepare(
      'SELECT count(*) AS total,max(updated_at) AS latestUpdatedAt,max(fetched_at) AS latestFetchedAt,' +
        '(SELECT count(DISTINCT product_id) FROM observations) AS historyProducts,(SELECT count(*) FROM candidates) AS candidates FROM products',
    ),
    db.prepare('SELECT platform,count(*) AS count FROM products GROUP BY platform ORDER BY count DESC'),
    db.prepare(
      'SELECT platform,category_id AS id,MIN(category_name) AS label,COUNT(*) AS count FROM products WHERE category_id IS NOT NULL GROUP BY platform,category_id ORDER BY platform,count DESC',
    ),
    db.prepare(
      'SELECT CASE ' +
        tiers.map((t) => 'WHEN ' + tierTests[t] + " THEN '" + t + "'").join(' ') +
        ' END AS tier,COUNT(*) AS count FROM products p GROUP BY tier',
    ),
    db.prepare(
      'SELECT group_key,platform,category_id FROM category_mappings ORDER BY group_key,platform,category_id',
    ),
  ])
  return c.json({
    ...summary.results[0],
    platforms: byPlatform.results,
    categories: [
      { value: 'home', label: '家居（已映射类目）', platform: null },
      ...sourceCategories.results.map((r) => ({
        value: r.platform + ':' + r.id,
        label: r.label,
        platform: r.platform,
        count: r.count,
      })),
    ],
    tiers: tiers.map((tier) => ({
      tier,
      count: byTier.results.find((r) => r.tier === tier)?.count ?? 0,
    })),
    mappings: mappings.results,
  })
})
catalog.get('/products/:id', async (c) => c.json(await readProduct(c.env.DB, c.req.param('id'))))
const change = z
  .object({
    stage: z.enum(stages),
    lines: z.array(z.enum(lines)).max(2),
    note: z.string().trim().max(2000).default(''),
  })
  .strict()
catalog.post('/products/:id/candidate', async (c) => {
  if (!c.var.actor || c.var.actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '当前角色不能保存候选反馈。', 403, 'catalog')
  const parsed = change.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return invalid('请检查候选阶段、机会线与备注。')
  const id = c.req.param('id'),
    db = c.env.DB,
    author = c.var.actor.email
  if (!(await db.prepare('SELECT 1 FROM products WHERE id=?').bind(id).first())) return absent()
  const { stage, note } = parsed.data,
    selected = JSON.stringify(lines.filter((v) => parsed.data.lines.includes(v)))
  // Atomic replay protection and append-only authorship. The migration trigger projects the current stage.
  await db
    .prepare(
      'INSERT INTO feedback(product_id,stage,lines_json,note,author,created_at) SELECT ?,?,?,?,?,? ' +
        'WHERE NOT EXISTS(SELECT 1 FROM candidates WHERE product_id=? AND stage=? AND lines_json=? AND note=? AND updated_by=?)',
    )
    .bind(id, stage, selected, note, author, new Date().toISOString(), id, stage, selected, note, author)
    .run()
  return c.json({ ok: true })
})
