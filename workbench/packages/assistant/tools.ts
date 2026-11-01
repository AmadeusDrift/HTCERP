import { z } from 'zod'
import { readAmazonPanel } from '../amazon/panel'
import { catalogQuerySchema, listProducts, readProduct } from '../catalog/service'
import { PublicError } from '../contracts/errors'
import { jobView, listJobs } from '../operations/jobs'
import { potentialProducts } from '../operations/potential'
import {
  productIdSchema,
  type ReadToolResult,
  readToolResultSchema,
  type ToolEvidence,
} from './contracts'
import {
  type AssistantActor,
  currentActor,
  ownsJob,
  type ReadToolBindings,
  sanitizeToolData,
} from './policy'

const page = z.number().int().min(1).max(100000).default(1)
const pageSize = z.number().int().min(1).max(100).default(20)
const pagination = z.object({ page, pageSize }).strict()
const inventory = catalogQuerySchema
  .extend({
    keyword: z.string().trim().max(300).optional(),
    maxPrice: z.number().finite().min(0).nullable().optional(),
    category: z.union([catalogQuerySchema.shape.category, z.literal('all')]),
  })
  .strict()
const product = z.object({ productId: productIdSchema }).strict()
const potential = pagination.extend({
  category: z.string().max(1000).optional(),
  grade: z.enum(['priority', 'watch', 'hold', 'unknown', 'undated']).optional(),
})
const job = z
  .object({
    jobId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\w-]+$/),
  })
  .strict()
const registry = {
  search_inventory: {
    schema: inventory,
    description:
      '按当前条件分页查询已有商品库，返回可继续读取的商品 ID、资料时间与缺口，不消耗供应商积分。',
  },
  list_potential: {
    schema: potential,
    description: '分页查看已有潜力新品和确定性评级，不触发在线更新。',
  },
  read_product: {
    schema: product,
    description: '按商品 ID 读取已有详情、历史和反馈；连续查看不同商品时分别传入各自 ID。',
  },
  read_reviews: {
    schema: product,
    description: '按商品 ID 读取已保存的评论报告；没有报告时返回缺口，不在线采集或生成。',
  },
  read_amazon_comparison: {
    schema: product,
    description: '按来源商品 ID 读取已有 Amazon 美国站竞品，不是 Amazon Haul，不在线查询。',
  },
  my_jobs: { schema: pagination, description: '分页读取当前用户自己的任务、进度和最近结果。' },
  read_job: { schema: job, description: '读取当前身份有权访问的指定任务和脱敏报告。' },
}
export const readToolDefinitions = Object.entries(registry).map(([name, spec]) => ({
  type: 'function',
  function: {
    name,
    description: spec.description,
    parameters: z.toJSONSchema(spec.schema, { target: 'draft-7' }),
  },
}))
export function normalizeReadToolArgs(name: string, args: unknown): Record<string, unknown> {
  if (!Object.hasOwn(registry, name)) throw new PublicError('INVALID_INPUT', '这项操作暂不支持。', 400)
  const parsed = registry[name as keyof typeof registry].schema.safeParse(args)
  if (!parsed.success)
    throw new PublicError('INVALID_INPUT', '请检查工具参数、商品编号和分页范围。', 400)
  return parsed.data
}
function date(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}
function evidence(
  kind: ToolEvidence['kind'],
  objectId: string,
  observedAt: unknown,
  fetchedAt: unknown,
): ToolEvidence {
  const observed = date(observedAt),
    fetched = date(fetchedAt)
  return {
    id: [kind, objectId, observed ?? 'undated', fetched ?? 'unfetched']
      .map(encodeURIComponent)
      .join(':'),
    kind,
    objectId,
    observedAt: observed,
    fetchedAt: fetched,
  }
}
function result(
  data: Record<string, unknown> | null,
  total = 0,
  returned = 0,
  currentPage = 1,
  items: ToolEvidence[] = [],
  missing: string[] = [],
  warnings: string[] = [],
  status?: ReadToolResult['status'],
): ReadToolResult {
  const gaps = [...missing]
  if (items.some((e) => !e.observedAt || !e.fetchedAt))
    warnings.push('部分证据缺少来源观察时间或保存时间，不能据此断言当前状态。')
  return readToolResultSchema.parse({
    version: 1,
    status: status ?? (returned ? (gaps.length ? 'partial' : 'ok') : 'empty'),
    data,
    coverage: { total, returned, page: currentPage, hasMore: false },
    evidence: items,
    missing: gaps,
    warnings,
  })
}
async function execute(
  env: ReadToolBindings,
  actor: AssistantActor,
  name: keyof typeof registry,
  args: unknown,
): Promise<ReadToolResult> {
  if (name === 'search_inventory') {
    const { keyword, category, maxPrice, minSold, ...query } = inventory.parse(args)
    if (query.platform === 'amazon' && category === 'home')
      throw new PublicError(
        'INVALID_INPUT',
        '请提供 Amazon 商品关键词；Temu 家居类目不能跨平台套用。',
        400,
      )
    const found = await listProducts(
      env.DB,
      {
        ...query,
        market: 'US',
        ...(keyword !== undefined ? { q: keyword } : {}),
        ...(category && category !== 'all' ? { category } : {}),
        ...(maxPrice != null ? { maxPrice } : {}),
        ...(minSold ? { minSold } : {}),
      },
      false,
      maxPrice != null ? 'USD' : undefined,
    )
    const rows = found.items as Record<string, unknown>[]
    const out = result(
      found,
      found.total,
      rows.length,
      found.page,
      rows.map((r) => evidence('product_snapshot', String(r.id), r.updated_at, r.fetched_at)),
    )
    out.coverage.hasMore = found.page * found.pageSize < found.total
    return out
  }
  if (name === 'list_potential') {
    const q = potential.parse(args),
      asOf = new Date().toISOString()
    const found = await potentialProducts(env.DB, asOf, q.page, q.pageSize, q.grade, q.category)
    const ids = found.items.map((r) => r.id)
    const dates = ids.length
      ? await env.DB.prepare(
          'SELECT id,updated_at,fetched_at,platform,market,currency FROM products WHERE id IN (SELECT value FROM json_each(?))',
        )
          .bind(JSON.stringify(ids))
          .all<Record<string, unknown>>()
      : { results: [] }
    const rows = found.items.map((r) => {
      const saved = dates.results.find((d) => d.id === r.id)
      return { ...r, ...saved, updated_at: saved?.updated_at, fetched_at: saved?.fetched_at }
    })
    const out = result(
      { ...found, items: rows },
      found.total,
      rows.length,
      found.page,
      rows.map((r) => evidence('product_snapshot', r.id, r.updated_at, r.fetched_at)),
      [],
      ['潜力池沿用已批准的 Temu 美国站家居、价格和时间窗口条件。'],
    )
    out.coverage.hasMore = found.page * found.pageSize < found.total
    return out
  }
  if (name === 'my_jobs') {
    const q = pagination.parse(args),
      found = await listJobs(env.DB, '', '', q.page, q.pageSize, actor.email)
    const out = result(
      found,
      found.total,
      found.items.length,
      q.page,
      found.items.map((r) => evidence('job_report', r.id, r.updatedAt, r.updatedAt)),
    )
    out.coverage.hasMore = q.page * q.pageSize < found.total
    return out
  }
  if (name === 'read_job') {
    const { jobId } = job.parse(args)
    if (!(await ownsJob(env.DB, actor, jobId)))
      return result(null, 0, 0, 1, [], [], ['未找到可访问的任务。'], 'denied')
    const found = await jobView(env.DB, jobId)
    return result({ job: found }, 1, 1, 1, [
      evidence('job_report', jobId, found.updatedAt, found.updatedAt),
    ])
  }
  const { productId } = product.parse(args)
  const row = await env.DB.prepare(
    'SELECT id,platform,external_id,updated_at,fetched_at FROM products WHERE id=?',
  )
    .bind(productId)
    .first<Record<string, unknown>>()
  if (!row) return result({ productId }, 0, 0, 1, [], ['product'])
  if (name === 'read_product') {
    const found = await readProduct(env.DB, productId)
    const item = found.product as Record<string, unknown>
    const missing = ['min_price', 'currency', 'total_sold', 'updated_at', 'fetched_at'].filter(
      (k) => item[k] == null,
    )
    return result(
      found,
      1,
      1,
      1,
      [evidence('product_snapshot', productId, row.updated_at, row.fetched_at)],
      missing,
      Object.values(found.hasMore).some(Boolean) ? ['详情历史、反馈或快照已按现有接口上限截断。'] : [],
    )
  }
  if (name === 'read_reviews') {
    if (!['temu', 'amazon'].includes(String(row.platform)))
      return result(
        { productId, report: null },
        0,
        0,
        1,
        [],
        ['saved_review_report'],
        ['该平台暂无已接通的评论报告。'],
        'unavailable',
      )
    const saved = await env.DB.prepare(
      'SELECT report_json,updated_at FROM product_review_reports WHERE product_key=?',
    )
      .bind('product-reviews/v1/US/' + row.platform + '/' + row.external_id)
      .first<{ report_json: string | null; updated_at: number }>()
    if (!saved?.report_json)
      return result({ productId, report: null }, 0, 0, 1, [], ['saved_review_report'])
    const report = JSON.parse(saved.report_json) as Record<string, unknown>
    const data = report.data as Record<string, unknown> | undefined
    return result(
      { productId, report },
      1,
      1,
      1,
      [evidence('review_report', productId, report.updatedAt, new Date(saved.updated_at).toISOString())],
      data?.modelIssue ? ['review_summary'] : [],
    )
  }
  const panel = await readAmazonPanel(env, productId)
  const items = panel.matches as Record<string, unknown>[]
  return result(
    { productId, matches: items, searches: panel.searches, market: panel.market, haul: false },
    items.length,
    items.length,
    1,
    items.map((r) =>
      evidence('amazon_comparison', productId + ':' + String(r.asin), r.fetchedAt, r.fetchedAt),
    ),
    items.length ? [] : ['saved_amazon_comparison'],
    [
      '普通 Amazon 美国站目录与已保存价格不代表 Amazon Haul 或当前报价。',
      ...(items.length === 100 || panel.searches.length === 20
        ? ['已有竞品面板已按最多 100 个竞品和 20 次检索截断。']
        : []),
    ],
  )
}
export async function runReadTool(
  env: ReadToolBindings,
  actor: AssistantActor,
  name: string,
  args: unknown,
): Promise<ReadToolResult> {
  if (!Object.hasOwn(registry, name)) throw new PublicError('INVALID_INPUT', '这项操作暂不支持。', 400)
  const spec = registry[name as keyof typeof registry]
  if (!spec.schema.safeParse(args).success)
    throw new PublicError('INVALID_INPUT', '请检查工具参数、商品编号和分页范围。', 400)
  const current = await currentActor(env, actor)
  if (!current) return result(null, 0, 0, 1, [], [], ['当前账号已停用或无访问权限。'], 'denied')
  try {
    const out = await execute(env, current, name as keyof typeof registry, args)
    return { ...out, data: out.data ? sanitizeToolData(env, out.data) : null }
  } catch (error) {
    if (error instanceof SyntaxError)
      return result(
        null,
        0,
        0,
        1,
        [],
        ['saved_data_invalid'],
        ['已保存的资料无法读取，需要核对已有记录。'],
        'unavailable',
      )
    throw error
  }
}
