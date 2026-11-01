import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { initialPreferences, type Preferences, pageSizes, presetLimit } from './model'

const preferences = z.strictObject({ view: z.enum(['table', 'grid']), pageSize: z.literal(pageSizes) })
const name = z.string().trim().min(1).max(40)
const price = z
  .string()
  .max(30)
  .regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine((v) => Number.isFinite(Number(v)))
const count = z
  .string()
  .max(20)
  .regex(/^\d+$/)
  .refine((v) => Number.isSafeInteger(Number(v)))
const filters = z
  .strictObject({
    q: z.string().trim().min(1).max(300),
    platform: z.enum(['temu', 'amazon', 'shein', 'tiktok', 'aliexpress']),
    market: z.literal('US'),
    category: z
      .string()
      .max(80)
      .regex(/^(home|missing|(temu|amazon|shein|tiktok|aliexpress):\d+)$/),
    minPrice: price,
    maxPrice: price,
    minSold: count,
    maxSold: count,
    minDaySold: count,
    maxDaySold: count,
    minWeekSold: count,
    maxWeekSold: count,
    minMonthSold: count,
    maxMonthSold: count,
    tier: z.enum(['50k', '30k', '10k', 'below', 'missing']),
    updatedFrom: z.iso.date(),
    updatedTo: z.iso.date(),
    completeness: z.enum(['complete', 'partial']),
    stage: z.enum(['candidate', 'watch', 'follow', 'hold', 'reject']),
    line: z.enum(['standard', 'pod']),
    sort: z.enum(['total_sold', 'min_price', 'day_sold', 'week_sold', 'month_sold', 'updated_at']),
    order: z.enum(['asc', 'desc']),
  })
  .partial()
  .refine((v) => {
    for (const key of ['Price', 'Sold', 'DaySold', 'WeekSold', 'MonthSold'] as const) {
      if (Number(v[`min${key}`]) > Number(v[`max${key}`])) return false
    }
    return !v.updatedFrom || !v.updatedTo || v.updatedFrom <= v.updatedTo
  })
const newPreset = z.strictObject({ name, filters })
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new PublicError('INVALID_INPUT', '预设名称、筛选条件或显示设置无效。', 400)
  return result.data
}
const missing = () => new PublicError('NOT_FOUND', '没有找到这个个人预设。', 404)
export const personalRoutes = new Hono<AppEnv>()

personalRoutes.get('/preferences', async (c) => {
  const db = c.env.DB,
    owner = c.var.actor.id
  const [pref, presets] = await Promise.all([
    db
      .prepare('SELECT view, page_size AS pageSize FROM personal_preferences WHERE actor_id=?')
      .bind(owner)
      .first<Preferences>(),
    db
      .prepare(
        'SELECT id, name, filters_json FROM personal_presets WHERE actor_id=? ORDER BY created_at, id',
      )
      .bind(owner)
      .all<{ id: string; name: string; filters_json: string }>(),
  ])
  return c.json({
    ...(pref ?? initialPreferences),
    presets: presets.results.map(({ id, name, filters_json }) => ({
      id,
      name,
      filters: JSON.parse(filters_json) as Record<string, string>,
    })),
  })
})

personalRoutes.post('/preferences', async (c) => {
  const pref = parse(preferences, await c.req.json())
  await c.env.DB.prepare(`INSERT INTO personal_preferences(actor_id,view,page_size) VALUES(?,?,?)
    ON CONFLICT(actor_id) DO UPDATE SET view=excluded.view,page_size=excluded.page_size`)
    .bind(c.var.actor.id, pref.view, pref.pageSize)
    .run()
  return c.json(pref)
})

personalRoutes.post('/presets', async (c) => {
  const data = parse(newPreset, await c.req.json()),
    owner = c.var.actor.id,
    id = crypto.randomUUID()
  // Enforce capacity and uniqueness in the insertion itself, including concurrent requests.
  const created =
    await c.env.DB.prepare(`INSERT INTO personal_presets(actor_id,id,name,filters_json,created_at)
    SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM personal_presets WHERE actor_id=?) < ?
    ON CONFLICT(actor_id,name) DO NOTHING RETURNING id`)
      .bind(
        owner,
        id,
        data.name,
        JSON.stringify(data.filters),
        new Date().toISOString(),
        owner,
        presetLimit,
      )
      .first()
  if (!created) throw new PublicError('CONFLICT', '预设名称已存在，或已达到 20 个预设上限。', 409)
  return c.json({ id, ...data }, 201)
})

personalRoutes.post('/presets/:id/rename', async (c) => {
  const data = parse(z.strictObject({ name }), await c.req.json()),
    owner = c.var.actor.id,
    id = c.req.param('id')
  const row = await c.env.DB.prepare(`UPDATE OR IGNORE personal_presets SET name=?
    WHERE actor_id=? AND id=? RETURNING id`)
    .bind(data.name, owner, id)
    .first()
  if (!row) {
    if (
      !(await c.env.DB.prepare('SELECT id FROM personal_presets WHERE actor_id=? AND id=?')
        .bind(owner, id)
        .first())
    )
      throw missing()
    throw new PublicError('CONFLICT', '预设名称已存在。', 409)
  }
  return c.json({ id, name: data.name })
})

personalRoutes.post('/presets/:id/delete', async (c) => {
  parse(z.strictObject({}), await c.req.json())
  const row = await c.env.DB.prepare(
    'DELETE FROM personal_presets WHERE actor_id=? AND id=? RETURNING id',
  )
    .bind(c.var.actor.id, c.req.param('id'))
    .first()
  if (!row) throw missing()
  return c.json({ ok: true })
})
