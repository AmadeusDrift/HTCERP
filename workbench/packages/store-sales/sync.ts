import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import type { ConnectionBindings } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { sourceConnection } from '../inventory-sync/source'
import { dailySalesWindow } from './daily'
import { parsePerformancePage, savePerformanceFacts } from './facts'
import { daysBefore, salesDay } from './report'

type SyncBindings = ConnectionBindings & { RUNNER: Workflow<{ runId: string }> }
export interface PerformanceSyncRun {
  id: string
  seller: string
  connection_revision: string
  basis: 'created' | 'updated'
  from_at: string
  through_at: string
  status: 'queued' | 'running' | 'complete' | 'failed'
  pages: number
  line_count: number
  excluded_orders: number
  error: string | null
  started_at: string
  updated_at: string
}
type SyncState = { coverage_from: string; through_at: string | null }
const iso = (time: number) => new Date(time).toISOString()

export async function launchPerformanceSync(env: SyncBindings, now = Date.now()) {
  const source = await sourceConnection(env).catch(() => null)
  if (
    !source ||
    !source.credentials.SP_CLIENT_ID ||
    !source.credentials.SP_CLIENT_SECRET ||
    !source.credentials.SP_REFRESH_TOKEN
  )
    return null
  const { seller, revision } = source.identity
  const db = env.DB
  const active = await db
    .prepare(`SELECT * FROM performance_sync_runs WHERE seller=? AND status IN ('queued','running')`)
    .bind(seller)
    .first<PerformanceSyncRun>()
  if (active) {
    // Reconcile terminal instances, never expire a legitimately sleeping Workflow.
    if (now - Date.parse(active.updated_at) < 120000) return active
    const instance = await env.RUNNER.get(active.id)
      .then((flow) => flow.status())
      .catch(() => null)
    if (!instance) {
      // A request can stop between the D1 claim and Workflow creation. Reusing
      // the exact instance ID safely repairs this gap; an existing instance
      // rejects creation, so an ambiguous lookup never starts a second run.
      await env.RUNNER.create({ id: active.id, params: { runId: active.id } }).catch(() => undefined)
      return active
    }
    if (!['errored', 'terminated', 'complete'].includes(instance.status)) return active
    await db
      .prepare(
        `UPDATE performance_sync_runs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')`,
      )
      .bind('后台同步已中断，下次同步将从上次成功水位重读。', iso(now), active.id)
      .run()
  }
  await db
    .prepare(`INSERT INTO performance_sync_state VALUES(?,?,?,NULL,?) ON CONFLICT DO NOTHING`)
    .bind(seller, revision, dailySalesWindow(daysBefore(salesDay(new Date(now)), 7)).start, iso(now))
    .run()
  const state = await db
    .prepare(
      'SELECT coverage_from,through_at FROM performance_sync_state WHERE seller=? AND connection_revision=?',
    )
    .bind(seller, revision)
    .first<SyncState>()
  if (!state) throw new Error('Missing performance sync state')
  const through = iso(now - 180000)
  const basis = state.through_at ? 'updated' : 'created'
  // Updated-time polling already includes older orders that change. Keep an
  // hour of overlap each run, plus a full-day reconciliation on day rollover.
  const reconcile =
    state.through_at && salesDay(new Date(state.through_at)) !== salesDay(new Date(through))
  const overlap = reconcile ? 86400000 : 3600000
  const from = state.through_at ? iso(Date.parse(state.through_at) - overlap) : state.coverage_from
  if (Date.parse(through) <= Date.parse(state.through_at ?? from)) return null
  const id = 'performance-sync-' + crypto.randomUUID()
  const created = await db
    .prepare(`INSERT OR IGNORE INTO performance_sync_runs
    (id,seller,connection_revision,basis,from_at,through_at,status,started_at,updated_at)
    VALUES(?,?,?,?,?,?,'queued',?,?) RETURNING *`)
    .bind(id, seller, revision, basis, from, through, iso(now), iso(now))
    .first<PerformanceSyncRun>()
  if (!created)
    return db
      .prepare(`SELECT * FROM performance_sync_runs WHERE seller=? AND status IN ('queued','running')`)
      .bind(seller)
      .first<PerformanceSyncRun>()
  try {
    await env.RUNNER.create({ id, params: { runId: id } })
  } catch {
    const instance = await env.RUNNER.get(id)
      .then((flow) => flow.status())
      .catch(() => null)
    if (!instance) {
      await db
        .prepare("UPDATE performance_sync_runs SET error=? WHERE id=? AND status='queued'")
        .bind('正在确认后台任务是否启动，系统会自动重试。', id)
        .run()
    }
  }
  return created
}

export async function performanceSyncWorkflow(env: SyncBindings, step: WorkflowStep, id: string) {
  const db = env.DB
  try {
    const run = await step.do('performance-start', async () => {
      const saved = await db
        .prepare('SELECT * FROM performance_sync_runs WHERE id=?')
        .bind(id)
        .first<PerformanceSyncRun>()
      if (!saved) throw new Error('Missing performance sync run')
      if (saved.status === 'failed') throw new Error('Performance sync run is no longer active')
      const source = await sourceConnection(env, {
        seller: saved.seller,
        revision: saved.connection_revision,
      })
      if (saved.basis === 'created') {
        // Validate the saved Seller ID against the actual authorization before initial ingestion.
        await new AmazonUS(source.credentials, undefined, db).searchListingsItems(saved.seller)
      }
      await db
        .prepare(
          "UPDATE performance_sync_runs SET status='running',error=NULL,updated_at=? WHERE id=? AND status='queued'",
        )
        .bind(iso(Date.now()), id)
        .run()
      return saved
    })
    if (run.status === 'complete') return
    const identity = { seller: run.seller, revision: run.connection_revision }
    let token: string | null = null
    const tokens = new Set<string>()
    for (let page = 1; ; page++) {
      if (page > 10000)
        throw new PublicError('DATA_INCOMPLETE', '订单分页超出处理范围，请检查同步记录。', 502)
      const cursor: string | null = token
      let result: { next_token: string | null } | { waitSeconds: number }
      let attempt = 0
      for (;;) {
        result = await step.do(
          'performance-page-' + page + '-attempt-' + attempt,
          { retries: { limit: 5, delay: '3 minutes', backoff: 'constant' }, timeout: '2 minutes' },
          async () => {
            const saved = await db
              .prepare('SELECT next_token FROM performance_sync_pages WHERE run_id=? AND page=?')
              .bind(id, page)
              .first<{ next_token: string | null }>()
            if (saved) return saved
            const { credentials } = await sourceConnection(env, identity)
            const amazon = new AmazonUS(credentials, undefined, db, { owner: 'performance:' + id })
            let raw: unknown
            try {
              raw = await amazon.performanceOrders(
                run.from_at,
                run.through_at,
                run.basis,
                cursor ?? undefined,
              )
            } catch (error) {
              if (
                !(error instanceof PublicError) ||
                !['SOURCE_THROTTLED', 'SOURCE_RATE_LIMIT'].includes(error.code)
              )
                throw error
              await db
                .prepare("UPDATE performance_sync_runs SET error=? WHERE id=? AND status='running'")
                .bind('等待共享订单读取额度，任务会自动继续。', id)
                .run()
              return { waitSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60)) + 1 }
            }
            const parsed = parsePerformancePage(raw, run.from_at, run.through_at, run.basis)
            await sourceConnection(env, identity)
            await savePerformanceFacts(db, identity, parsed.lines, iso(Date.now()))
            await db.batch([
              db
                .prepare('INSERT INTO performance_sync_pages VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
                .bind(id, page, parsed.nextToken, parsed.lines.length, parsed.excludedOrders),
              db
                .prepare(`UPDATE performance_sync_runs SET pages=(SELECT COUNT(*) FROM performance_sync_pages WHERE run_id=?),
              line_count=(SELECT COALESCE(SUM(line_count),0) FROM performance_sync_pages WHERE run_id=?),
              excluded_orders=(SELECT COALESCE(SUM(excluded_orders),0) FROM performance_sync_pages WHERE run_id=?),error=NULL,updated_at=? WHERE id=?`)
                .bind(id, id, id, iso(Date.now()), id),
            ])
            return { next_token: parsed.nextToken }
          },
        )
        if (!('waitSeconds' in result)) break
        if (attempt >= 480)
          throw new PublicError(
            'SOURCE_THROTTLED',
            '订单额度持续繁忙，本轮保留进度，下次从成功水位继续。',
            429,
          )
        await step.sleep('performance-quota-' + page + '-' + attempt, `${result.waitSeconds} seconds`)
        attempt++
      }
      token = result.next_token
      if (!token) break
      if (tokens.has(token))
        throw new PublicError('DATA_INCOMPLETE', '订单分页重复，已保留进度，未推进同步水位。', 502)
      tokens.add(token)
    }
    await step.do('performance-complete', async () => {
      await sourceConnection(env, identity)
      await db.batch([
        db
          .prepare(`UPDATE performance_sync_state SET through_at=MAX(COALESCE(through_at,''),?),updated_at=?
          WHERE seller=? AND connection_revision=?`)
          .bind(run.through_at, iso(Date.now()), identity.seller, identity.revision),
        db
          .prepare(
            "UPDATE performance_sync_runs SET status='complete',error=NULL,updated_at=? WHERE id=?",
          )
          .bind(iso(Date.now()), id),
      ])
    })
  } catch (error) {
    await step.do('performance-failure', async () => {
      const message =
        error instanceof PublicError
          ? error.message
          : error instanceof Error && error.message === 'SOURCE_CONNECTION_CHANGED'
            ? '店铺授权已变更，本次同步停止；请重新同步当前连接。'
            : '订单同步中断，已保留明细；重试会从上次成功水位读取。'
      await db
        .prepare(
          "UPDATE performance_sync_runs SET status='failed',error=?,updated_at=? WHERE id=? AND status!='complete'",
        )
        .bind(message, iso(Date.now()), id)
        .run()
    })
    throw error
  }
}
