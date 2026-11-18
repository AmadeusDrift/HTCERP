import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'
import type { OpsBindings } from '../operations/model'
import { isHaulListing } from '../weekly-feedback/owner-rules'
import { buildTitleAuditInspector, version } from './context-review'
import { customTerms } from './catalog'
import { listingState } from './listings'

const halfHourMs = 30 * 60 * 1000

export async function launchAudit(
  env: Pick<OpsBindings, 'DB' | 'RUNNER'>,
  seller: string,
  scheduledTime?: number,
) {
  const scope = scheduledTime === undefined ? 'full' : 'haul'
  let windowStart: number | null = null
  let windowEnd: number | null = null
  if (scheduledTime !== undefined) {
    const cutoff = scheduledTime - 2 * 60 * 1000
    const cursor = await env.DB.prepare(
      "SELECT MAX(window_end_ms) AS through FROM title_audit_runs WHERE seller=? AND scope='haul' AND status IN ('done','partial')",
    ).bind(seller).first<{ through: number | null }>()
    const through = cursor?.through ?? cutoff - halfHourMs
    if (through >= cutoff) return
    windowStart = through + 1
    windowEnd = Math.min(cutoff, through + 2 * halfHourMs)
  }
  const id =
      'title-audit-' +
      (scheduledTime === undefined
        ? crypto.randomUUID()
        : 'haul-' + seller + '-' + Math.floor(scheduledTime / halfHourMs)),
    now = new Date().toISOString()
  // Recover abandoned dispatches without reusing an incomplete snapshot.
  await env.DB.prepare(
    "UPDATE title_audit_runs SET status='failed',error='巡检超时，请重试' WHERE seller=? AND scope=? AND status='running' AND started<?",
  )
    .bind(seller, scope, new Date(Date.now() - 86400000).toISOString())
    .run()
  const slot = await env.DB.prepare(
    "INSERT OR IGNORE INTO title_audit_runs(id,seller,started,status,version,scope,window_start_ms,window_end_ms) VALUES(?,?,?,'running',?,?,?,?)",
  )
    .bind(id, seller, now, version, scope, windowStart, windowEnd)
    .run()
  if (!slot.meta.changes) return
  try {
    await env.RUNNER.create({ id, params: { runId: id } })
  } catch (e) {
    await env.DB.prepare("UPDATE title_audit_runs SET status='failed',error='工作流启动失败' WHERE id=?")
      .bind(id)
      .run()
    throw e
  }
}
export async function auditWorkflow(env: OpsBindings, id: string, step: WorkflowStep) {
  try {
    const run = await step.do('audit-store', async () => {
      const r = await env.DB.prepare(
        "SELECT seller,started,scope,window_start_ms,window_end_ms FROM title_audit_runs WHERE id=? AND status='running'",
      )
        .bind(id)
        .first<{ seller: string; started: string; scope: 'full' | 'haul'; window_start_ms: number | null; window_end_ms: number | null }>()
      if (!r) throw new Error('巡检未启动')
      const terms = await customTerms(env.DB)
      const revision = terms.at(-1)?.id ?? 0
      await env.DB.prepare('UPDATE title_audit_runs SET version=? WHERE id=?')
        .bind(version + '+' + revision, id)
        .run()
      return { ...r, revision }
    })
    const haul = run.scope === 'haul'
    const ranges = [[run.window_start_ms ?? Date.UTC(1994, 0), run.window_end_ms ?? Date.parse(run.started), 0]]
    const check = buildTitleAuditInspector(await customTerms(env.DB, run.revision))
    let api: AmazonUS | undefined
    let clientSince = 0
    let sequence = 0,
      reported = 0,
      uncertainWindows = 0
    while (ranges.length) {
      const [start, end, retry] = ranges.pop()!
      let cursor: string | undefined,
        seen = 0,
        windowCount = 0
      do {
        const token: string | undefined = cursor
        const page: { count: number; size: number; next: string | null } = await step.do(
          'audit-page-' + sequence++,
          { retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' } },
          async () => {
            if (!api || Date.now() - clientSince > 300000) {
              const { credentials } = await providerCredentials(env, 'amazon')
              api = new AmazonUS(credentials, undefined, env.DB)
              clientSince = Date.now()
            }
            const result = await api.auditListings(run.seller, start, end, token, haul)
            if (result.numberOfResults <= 1000 && result.items.length) {
              const items = haul ? result.items.filter(isHaulListing) : result.items
              if (items.length) await env.DB.batch(
                items.map((item) => {
                  const row = listingState(item),
                    checked = check(row.title)
                  return env.DB.prepare(
                    'INSERT OR REPLACE INTO title_audit_rows(run,sku,asin,title,verdict,disposition,evidence,hits) VALUES(?,?,?,?,?,?,?,?)',
                  ).bind(
                    id,
                    row.sku,
                    row.asin,
                    row.title,
                    checked.verdict,
                    row.disposition,
                    row.evidence,
                    JSON.stringify(checked.hits),
                  )
                }),
              )
            }
            return {
              count: result.numberOfResults,
              size: result.items.length,
              next: result.pagination?.nextToken ?? null,
            }
          },
        )
        if (sequence === 1) reported = page.count
        windowCount = Math.max(windowCount, page.count)
        if (page.count > 1000) {
          if (end - start < 2) throw new Error('同一时间窗超过 Amazon 分页上限')
          const mid = Math.floor((start + end) / 2)
          ranges.push([mid + 1, end, retry], [start, mid, retry])
          break
        }
        seen += page.size
        if (
          (page.next && (page.next === token || !page.size || seen >= 1000)) ||
          (!page.next && seen < windowCount)
        )
        {
          // Retry only the incomplete interval in smaller pieces. Repeated SKUs upsert safely.
          if (!retry && end - start >= 2) {
            const mid = Math.floor((start + end) / 2)
            ranges.push([mid + 1, end, 1], [start, mid, 1])
          } else {
            uncertainWindows++
          }
          break
        }
        cursor = page.next ?? undefined
      } while (cursor)
    }
    await step.do('audit-publish', async () => {
      const n = await env.DB.prepare('SELECT COUNT(*) n FROM title_audit_rows WHERE run=?')
        .bind(id)
        .first<number>('n')
      const partial = uncertainWindows > 0 || (!haul && n !== reported)
      const warning = !partial
        ? null
        : haul
          ? `亚马逊有 ${uncertainWindows} 个分页时间段未能核齐。本批已检查 ${n} 个 Haul SKU。`
          : `亚马逊起始报告 ${reported} 条，实际读取 ${n} 个不同 SKU，仍有 ${uncertainWindows} 个分页时间段未能核齐。`
      await env.DB.prepare(
        "UPDATE title_audit_runs SET status=?,error=?,finished=? WHERE id=? AND status='running'",
      )
        .bind(partial ? 'partial' : 'done', warning, new Date().toISOString(), id)
        .run()
      await env.DB.prepare(
        `DELETE FROM title_audit_runs WHERE seller=?1 AND scope=?2 AND status<>'running'
        AND id NOT IN (SELECT id FROM title_audit_runs WHERE seller=?1 AND scope=?2
          AND (status='done' OR (?2='haul' AND status='partial')) ORDER BY started DESC LIMIT 2)
        AND ((?2='full' AND status='done') OR started<?3)`,
      )
        .bind(run.seller, run.scope, new Date(Date.now() - 7 * 86400000).toISOString())
        .run()
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'WorkflowInternalError') throw e
    await env.DB.prepare("UPDATE title_audit_runs SET status='failed',error=? WHERE id=? AND status='running'")
      .bind(e instanceof Error ? e.message.slice(0, 240) : '巡检中断', id)
      .run()
    throw e
  }
}
