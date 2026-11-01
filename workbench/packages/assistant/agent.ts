import { z } from 'zod'
import type { Bindings } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { currentStrategy } from '../operations/model'
import type { ReadToolResult } from './contracts'
import { type AssistantActor, currentActor, requireWritable } from './policy'
import { readToolDefinitions, runReadTool } from './tools'

export { runReadTool } from './tools'

const filters = z
  .object({
    platform: z.enum(['temu', 'amazon']),
    keyword: z.string().trim().max(150),
    maxPrice: z.number().min(0).max(1_000_000).nullable(),
    minSold: z.number().int().min(0).max(1_000_000_000),
    category: z.enum(['all', 'home']),
  })
  .strict()
export const planSchema = filters.extend({
  pages: z.number().int().min(1).max(20),
  mode: z.enum(['cache', 'live']),
})
export type AgentPlan = z.infer<typeof planSchema>
type Result = { answer: string; plan?: AgentPlan; jobId?: string; data?: ReadToolResult }
const properties = {
  platform: { type: 'string', enum: ['temu', 'amazon'] },
  keyword: { type: 'string', description: '未指定时为空字符串' },
  maxPrice: { type: ['number', 'null'], description: '来源平台美元价格上限，未指定时为 null' },
  minSold: { type: 'integer', description: '累计销量下限，未指定为 0' },
  category: { type: 'string', enum: ['all', 'home'], description: 'home 仅用于 Temu 家居' },
}
function tool(name: string, description: string, fields: Record<string, unknown>) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: fields,
        required: Object.keys(fields),
        additionalProperties: false,
      },
    },
  }
}
export const agentTools = [
  ...readToolDefinitions,
  tool(
    'prepare_discovery',
    '把明确的选品需求整理为待确认的任务。用户未指定实时查询时选 cache，不自行扩大范围。',
    {
      ...properties,
      pages: { type: 'integer', minimum: 1, maximum: 20 },
      mode: { type: 'string', enum: ['cache', 'live'] },
    },
  ),
]
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : []
}
function text(value: unknown, fallback = '未知') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
}
function money(value: unknown, currency: unknown) {
  return value == null ? '价格待核' : text(value) + ' ' + text(currency, '币种待核')
}
function readableResult(name: string, result: ReadToolResult): string {
  const data = result.data ?? {},
    lines: string[] = []
  if (result.status === 'unavailable') lines.push('已有资料暂时无法读取。')
  else if (name === 'read_product') {
    const p = object(data.product),
      history = rows(data.history)
    if (!p.id) lines.push('没有找到这件商品的已有资料。')
    else {
      lines.push(
        text(p.title_cn || p.title) + '（' + text(p.id) + '）',
        '价格 ' + money(p.min_price, p.currency) + ' · 累计销量 ' + text(p.total_sold),
        '日销量 ' +
          text(p.day_sold) +
          ' · 周销量 ' +
          text(p.week_sold) +
          ' · 月销量 ' +
          text(p.month_sold),
        '来源观察时间 ' + text(p.updated_at) + ' · 保存时间 ' + text(p.fetched_at),
        '已有历史记录 ' + history.length + ' 条 · 规格 ' + rows(data.variants).length + ' 组。',
      )
      const latest = history.at(-1)
      if (latest)
        lines.push(
          '最近历史观察 ' + text(latest.observed_at) + '：累计销量 ' + text(latest.total_sold) + '。',
        )
    }
  } else if (name === 'read_reviews') {
    const report = object(data.report),
      review = object(report.data)
    if (!data.report) lines.push('暂无已保存的评论报告。')
    else {
      lines.push('已有评论报告 · ' + text(data.productId) + ' · 更新于 ' + text(report.updatedAt))
      if (review.withText != null || review.total != null)
        lines.push(
          '有文字样本 ' + text(review.withText) + ' 条 · 来源评论总量 ' + text(review.total) + '。',
        )
      if (typeof review.summary === 'string') lines.push(review.summary)
      for (const topic of rows(review.topics).slice(0, 10))
        lines.push('评论主题：' + text(topic.name) + ' · 提及 ' + text(topic.mentions) + ' 次。')
      if (!review.summary && !rows(review.topics).length) lines.push('已有记录未包含可用评论总结。')
    }
  } else if (name === 'read_amazon_comparison') {
    const matches = rows(data.matches)
    lines.push(
      matches.length
        ? '已有 Amazon 美国站竞品 ' + matches.length + ' 款。'
        : '暂无已保存的 Amazon 美国站竞品。',
    )
    for (const match of matches.slice(0, 10))
      lines.push(
        text(match.title || match.asin) +
          '（' +
          text(match.asin) +
          '） · 已存价格 ' +
          money(match.price, match.currency) +
          ' · 资料时间 ' +
          text(match.fetchedAt),
      )
  } else if (name === 'list_potential') {
    const grades: Record<string, string> = {
      priority: '优先研究',
      watch: '继续观察',
      hold: '暂缓',
      unknown: '待补数据',
      undated: '上架时间待核',
    }
    lines.push('潜力新品共 ' + result.coverage.total + ' 款，本页 ' + result.coverage.returned + ' 款。')
    for (const item of rows(data.items))
      lines.push(
        text(item.title) +
          '（' +
          text(item.id) +
          '） · ' +
          money(item.price, item.currency) +
          ' · 日销量 ' +
          text(item.daySold) +
          ' · 周销量 ' +
          text(item.weekSold) +
          ' · ' +
          (grades[text(item.grade)] ?? '评级待核'),
      )
    if (result.coverage.hasMore) lines.push('还有下一页资料。')
  } else if (name === 'read_job') {
    const job = object(data.job)
    lines.push(
      '任务：' + text(job.title) + '（' + text(job.id) + '）',
      text(job.summary, '暂无任务总结。'),
    )
    for (const step of rows(job.steps))
      lines.push(text(step.title) + (step.summary ? '：' + text(step.summary) : ''))
  }
  if (result.missing.length) {
    const labels: Record<string, string> = {
      product: '商品资料',
      saved_review_report: '已保存的评论报告',
      saved_amazon_comparison: '已保存的竞品资料',
      saved_data_invalid: '有效的已保存资料',
      review_summary: '评论总结',
      min_price: '价格',
      currency: '币种',
      total_sold: '累计销量',
      updated_at: '来源观察时间',
      fetched_at: '保存时间',
    }
    lines.push(
      '资料缺口：' + result.missing.map((key) => labels[key] ?? '部分业务资料').join('、') + '。',
    )
  }
  lines.push(...result.warnings)
  return lines.join('\n\n') || '暂无可用的已有资料。'
}
export async function runAgentTool(
  env: Bindings,
  actor: AssistantActor,
  name: string,
  args: unknown,
): Promise<Result> {
  if (name !== 'prepare_discovery') {
    const previewArgs =
      (name === 'search_inventory' || name === 'my_jobs') &&
      args &&
      typeof args === 'object' &&
      !Array.isArray(args)
        ? { pageSize: 5, ...args }
        : args
    const data = await runReadTool(env, actor, name, previewArgs)
    if (data.status === 'denied') return { answer: data.warnings.join('；'), data }
    const items = (data.data?.items ?? []) as Record<string, unknown>[]
    if (name === 'my_jobs') {
      const labels: Record<string, string> = {
        queued: '排队中',
        running: '执行中',
        succeeded: '已完成',
        partial: '部分完成',
        failed: '未完成',
        paused: '已暂停',
        cancelled: '已取消',
      }
      return {
        answer:
          items
            .map(
              (r) =>
                String(r.title) +
                ' · ' +
                (labels[String(r.status)] ?? r.status) +
                (r.summary ? '\n' + r.summary : ''),
            )
            .join('\n\n') || '你还没有选品任务。',
        jobId: items[0]?.id as string | undefined,
        data,
      }
    }
    if (name === 'search_inventory')
      return {
        answer:
          '已查商品库，符合条件 ' +
          data.coverage.total +
          ' 款。' +
          items
            .map(
              (r, i) =>
                '\n' +
                (i + 1) +
                '. ' +
                String(r.title_cn || r.title).slice(0, 64) +
                ' · ' +
                (r.min_price == null
                  ? '价格待核'
                  : (r.currency === 'USD' ? '$' : String(r.currency ?? '')) + r.min_price) +
                ' · 累计销量 ' +
                (r.total_sold ?? '未知'),
            )
            .join(''),
        data,
      }
    return { answer: readableResult(name, data), data }
  }
  const current = await currentActor(env, actor)
  requireWritable(current)
  const f = filters.parse(name === 'prepare_discovery' ? filters.strip().parse(args) : args)
  if (f.platform === 'amazon' && f.category === 'home')
    throw new PublicError(
      'INVALID_INPUT',
      '请提供 Amazon 商品关键词；Temu 家居类目不能跨平台套用。',
      400,
    )
  const plan = planSchema.parse(args)
  if (plan.platform === 'amazon' && plan.pages > 10)
    throw new PublicError('INVALID_INPUT', 'Amazon 每组条件最多查 10 页。', 400)
  if (plan.mode === 'live' && plan.platform === 'temu' && !plan.keyword && plan.category === 'all')
    throw new PublicError('INVALID_INPUT', '在线查 Temu 需要一个关键词或类目。', 400)
  const { settings } = await currentStrategy(env.DB)
  const cap = plan.mode === 'live' ? plan.pages * 10 : 0
  return {
    plan,
    answer: [
      plan.platform === 'temu' ? 'Temu 美国站' : 'Amazon 美国站',
      plan.category === 'home' ? '家居' : '全部类目',
      plan.keyword || '不限关键词',
      plan.maxPrice === null ? '不限价格' : '不超过 $' + plan.maxPrice,
      '累计销量至少 ' + plan.minSold + ' 件',
      plan.mode === 'live'
        ? '在线检索最多 ' +
          plan.pages +
          ' 页，数据上限 ' +
          cap +
          ' 积分，团队每日上限 ' +
          settings.dataDailyPoints +
          ' 积分'
        : '使用已有商品资料，0 积分',
    ].join(' · '),
  }
}
