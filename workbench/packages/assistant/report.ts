import { z } from 'zod'
import { productIdSchema } from './contracts'
import type { AssistantBindings, AssistantRunRow } from './runs'

const finding = z
  .object({
    productId: z.string().max(100),
    reason: z.string().trim().min(1).max(1000),
    evidenceIds: z.array(z.string().max(300)).min(1).max(20),
  })
  .strict()
export const investigationReportSchema = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    recommendations: z.array(finding).max(10).default([]),
    excluded: z.array(finding).max(20).default([]),
    missing: z.array(z.string().max(1000)).max(30).default([]),
  })
  .strict()
export type InvestigationReport = z.infer<typeof investigationReportSchema>
type Evidence = {
  id: string
  objectId?: string
  kind?: string
  observedAt?: string | null
  fetchedAt?: string | null
}
export async function savedInvestigationFacts(db: D1Database, id: string) {
  const rows = await db
    .prepare(
      "SELECT name,input_json,result_json FROM assistant_steps WHERE run_id=? AND kind='tool' AND status='completed' ORDER BY seq",
    )
    .bind(id)
    .all<{ name: string; input_json: string; result_json: string }>()
  const evidence = new Map<string, Evidence>()
  const products = new Set<string>()
  const missing: string[] = []
  const accessibleRows: typeof rows.results = []
  let usableReads = 0
  for (const row of rows.results) {
    if (row.name === 'read_job') {
      const input = JSON.parse(row.input_json)
      const allowed = await db
        .prepare(
          'SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id JOIN job_runs j ON j.id=? WHERE r.id=? AND a.active=1 AND j.actor=a.username',
        )
        .bind(input.jobId, id)
        .first()
      if (!allowed) {
        missing.push('任务权限已变更或不可访问，旧证据不可引用。')
        continue
      }
    }
    accessibleRows.push(row)
    const result = JSON.parse(row.result_json)
    for (const item of [...(result.missing ?? []), ...(result.warnings ?? [])])
      if (typeof item === 'string') missing.push(item)
    if (!['ok', 'partial', 'empty'].includes(result.status)) continue
    usableReads++
    for (const item of result.evidence ?? [])
      if (typeof item.id === 'string') {
        evidence.set(item.id, item)
        const productId =
          item.kind === 'amazon_comparison' ? JSON.parse(row.input_json).productId : item.objectId
        if (productIdSchema.safeParse(productId).success) products.add(productId)
      }
  }
  return { rows: accessibleRows, evidence, products, missing, usableReads }
}
export async function validateInvestigationReport(db: D1Database, id: string, value: unknown) {
  const parsed = investigationReportSchema.safeParse(value)
  if (!parsed.success) return null
  const facts = await savedInvestigationFacts(db, id)
  if (!facts.usableReads) return null
  for (const item of [...parsed.data.recommendations, ...parsed.data.excluded]) {
    if (!facts.products.has(item.productId)) return null
    if (item.evidenceIds.some((e) => !facts.evidence.has(e))) return null
    if (
      !item.evidenceIds.some((e) => {
        const entry = facts.evidence.get(e)
        return (
          entry?.objectId === item.productId ||
          (entry?.kind === 'amazon_comparison' && entry.objectId?.startsWith(item.productId + ':'))
        )
      })
    )
      return null
  }
  return {
    ...parsed.data,
    missing: [...new Set([...parsed.data.missing, ...facts.missing])].slice(0, 30),
  }
}
export async function persistInvestigationReport(
  env: Pick<AssistantBindings, 'DB'>,
  row: AssistantRunRow,
  status: string,
  reason: string,
  report?: InvestigationReport,
) {
  const facts = await savedInvestigationFacts(env.DB, row.id)
  const observations = facts.rows
    .flatMap((row) => {
      const result = JSON.parse(row.result_json)
      const items = result.data?.product ? [result.data.product] : (result.data?.items ?? [])
      return items
        .filter((item: Record<string, unknown>) => productIdSchema.safeParse(item.id).success)
        .map((item: Record<string, unknown>) => ({
          productId: item.id,
          title: item.title_cn || item.title || '',
          minPrice: item.min_price ?? null,
          currency: item.currency ?? null,
          totalSold: item.total_sold ?? null,
          observedAt: item.updated_at ?? null,
        }))
    })
    .filter((value, index, values) => values.findIndex((v) => v.productId === value.productId) === index)
    .slice(0, 30)
  const data = report ?? {
    summary:
      '调查已保存部分结果。' +
      reason +
      ` 已完成 ${facts.rows.length} 次缓存读取，涉及 ${facts.products.size} 款商品。`,
    recommendations: [],
    excluded: [],
    missing: [reason, ...facts.missing].filter(Boolean).slice(0, 30),
  }
  const usage = await env.DB.prepare(
    "SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) aiMicros,COALESCE(SUM(CASE WHEN state!='confirmed' THEN reserved ELSE 0 END),0) unconfirmedAiMicros FROM usage_reservations WHERE assistant_run_id=?",
  )
    .bind(row.id)
    .first()
  const complete = {
    version: 1,
    goal: row.goal,
    scope: JSON.parse(row.context_json),
    scopeVersion: row.scope_version,
    policyVersion: row.policy_version,
    ...data,
    evidence: [...facts.evidence.values()],
    coverage: { tools: facts.rows.length, products: facts.products.size },
    observations,
    linkedJobs: [...facts.evidence.values()]
      .filter((e) => e.kind === 'job_report')
      .map((e) => ({ jobId: e.objectId, evidenceId: e.id })),
    usage: { dataPoints: 0, ...usage },
    generatedAt: new Date().toISOString(),
  }
  const answer = [
    data.summary,
    ...data.recommendations.map(
      (v) => '推荐 ' + v.productId + '：' + v.reason + '（' + v.evidenceIds.join('、') + '）',
    ),
    ...data.excluded.map(
      (v) => '排除 ' + v.productId + '：' + v.reason + '（' + v.evidenceIds.join('、') + '）',
    ),
    ...(!report
      ? observations.map(
          (v) =>
            `已存事实 ${v.productId} ${v.title}：价格 ${v.minPrice ?? '未知'} ${v.currency ?? ''}，来源累计销量 ${v.totalSold ?? '未知'}；观察时间 ${v.observedAt ?? '未知'}。`,
        )
      : []),
    data.missing.length ? '资料缺口：' + data.missing.join('；') : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  for (let retry = 0; retry < 3; retry++) {
    const current = await env.DB.prepare(
      'SELECT attempt,version,status,lease_token FROM assistant_runs WHERE id=?',
    )
      .bind(row.id)
      .first<{ attempt: number; version: number; status: string; lease_token: string | null }>()
    if (!current || current.attempt !== row.attempt || current.lease_token !== row.lease_token)
      return false
    if (
      ['cancelled', 'succeeded', 'partial', 'failed'].includes(current.status) &&
      current.status !== status
    )
      return false
    const target =
      current.status === 'cancelling'
        ? 'cancelled'
        : current.status === 'pausing'
          ? 'paused'
          : current.status === 'paused'
            ? 'paused'
            : status
    const [saved] = await env.DB.batch([
      env.DB.prepare(
        'UPDATE assistant_runs SET status=?,report_json=?,summary=?,updated_at=?,version=version+1 WHERE id=? AND attempt=? AND version=? AND status=? AND lease_token IS ?',
      ).bind(
        target,
        JSON.stringify(complete),
        reason || data.summary,
        new Date().toISOString(),
        row.id,
        current.attempt,
        current.version,
        current.status,
        current.lease_token,
      ),
      // D1 batch is atomic: changes() refers to the guarded run UPDATE immediately above.
      env.DB.prepare(
        'UPDATE assistant_turns SET answer=?,issue=NULL WHERE changes()=1 AND conversation_id=? AND id=? AND EXISTS(SELECT 1 FROM assistant_conversations WHERE id=? AND account_id=?)',
      ).bind(answer, row.conversation_id, row.origin_turn_id, row.conversation_id, row.account_id),
    ])
    if (saved.meta.changes) return true
  }
  return false
}
