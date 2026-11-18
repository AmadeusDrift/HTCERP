import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import type { OpsBindings } from '../operations/model'
import { InventoryAutomatic } from './automatic'
import {
  AmazonSourceClient,
  inventorySourceSettings,
  parseReport,
  type SourceRow,
  type SourceRun,
  SourceStore,
  sourceChannel,
  sourceConnection,
  sourceErrorCode,
  sourceReportCoverage,
} from './source'

const retry = { retries: { limit: 4, delay: '30 seconds' as const, backoff: 'exponential' as const } }
export type SourceDependencies = {
  client: Pick<AmazonSourceClient, 'create' | 'poll' | 'download'>
  orders: (start: string, end: string, token?: string) => ReturnType<AmazonUS['haulSalesPage']>
}

/** Deterministic cron dispatch; durable RUNNING rows can recover a crash before RUNNER.create. */
export async function launchInventoryPatrol(env: Pick<OpsBindings, 'DB' | 'RUNNER'>, now = Date.now(), minimumMinutes = 0) {
  const settings = await inventorySourceSettings(env.DB)
  if (!settings.enabled || settings.mode !== 'READ_ONLY' || settings.activatedAt === null) return null
  const seller = (
    await env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
      seller: string
    }>()
  )?.seller
  if (!seller) throw new Error('SOURCE_SELLER_NOT_CONFIGURED')
  const running = await env.DB.prepare(
    "SELECT id,started_at FROM inventory_source_runs WHERE seller=? AND state='RUNNING'",
  )
    .bind(seller)
    .first<{ id: string; started_at: number }>()
  if (running) {
    const instance = await env.RUNNER.get(running.id).catch(() => null)
    const state = await instance?.status().catch(() => null)
    if (state && ['errored', 'terminated', 'complete'].includes(state.status)) {
      await new SourceStore(env.DB).fail(running.id)
      return null
    }
    if (!state) await env.RUNNER.create({ id: running.id, params: { runId: running.id } })
    return running.id
  }
  const latest = await env.DB.prepare(
    'SELECT started_at FROM inventory_source_runs WHERE seller=? ORDER BY started_at DESC LIMIT 1',
  )
    .bind(seller)
    .first<{ started_at: number }>()
  if (latest && now - latest.started_at < Math.max(minimumMinutes, settings.intervalMinutes) * 60000) return null
  // Keep the current snapshot available to the plan workflow and its cron fallback until it is seeded.
  const pending = await env.DB.prepare(`SELECT 1 FROM inventory_source_current c
    JOIN inventory_source_runs r ON r.id=c.generation AND r.state='COMPLETE'
    JOIN inventory_automatic_settings s ON s.singleton=1 AND s.enabled=1 AND r.started_at>s.activated_after
    LEFT JOIN inventory_automatic_generations g ON g.generation=r.id
    WHERE c.seller=? AND COALESCE(g.state,'SEEDING')='SEEDING'`)
    .bind(seller).first()
  if (pending) return null
  const current = await env.DB.prepare(
    'SELECT r.order_through FROM inventory_source_current c JOIN inventory_source_runs r ON r.id=c.generation WHERE c.seller=?',
  )
    .bind(seller)
    .first<{ order_through: number }>()
  const id = 'inventory-patrol-' + seller + '-' + Math.floor(now / 60000)
  const store = new SourceStore(env.DB)
  // Two-minute Orders API availability lag; one-day overlap also catches delayed order visibility.
  await store.begin(
    id,
    seller,
    now,
    settings.activatedAt,
    now - 180000,
    current ? current.order_through - 86400000 : settings.activatedAt - 7 * 86400000,
  )
  const inserted = await env.DB.prepare('SELECT id FROM inventory_source_runs WHERE id=?')
    .bind(id)
    .first()
  if (!inserted) return null
  try {
    await env.RUNNER.create({ id, params: { runId: id } })
  } catch (error) {
    // A duplicate create is successful dispatch. Unknown launch failures remain recoverable next cron.
    const existing = await env.RUNNER.get(id)
      .then((i) => i.status())
      .catch(() => null)
    if (!existing) throw error
  }
  return id
}
export const scheduleInventoryPatrol = launchInventoryPatrol

export async function seedInventoryAutomatic(env: OpsBindings, generation: string, step: WorkflowStep) {
  // A completed source snapshot can also be seeded after a pause without requesting new reports.
  for (let page = 0; page < 2000; page++) {
    const planned = await step.do('automatic-plan-' + page, retry, () =>
      new InventoryAutomatic(env).plan(Date.now(), 500, generation),
    )
    if (planned.complete) return planned
  }
  return { complete: false, generation }
}

export async function inventoryPatrolWorkflow(
  env: OpsBindings,
  id: string,
  step: WorkflowStep,
  injected?: SourceDependencies,
) {
  const store = new SourceStore(env.DB)
  try {
    const run = await step.do('inventory-source-start', async () => {
      const r = await env.DB.prepare(
        "SELECT * FROM inventory_source_runs WHERE id=? AND state='RUNNING'",
      )
        .bind(id)
        .first<SourceRun>()
      if (!r) throw new Error('SOURCE_RUN_NOT_RUNNING')
      const connection = injected ? null : (await sourceConnection(env)).identity
      if (connection && connection.seller !== r.seller) throw new Error('SOURCE_CONNECTION_CHANGED')
      await env.DB.prepare('UPDATE inventory_source_runs SET connection_revision=? WHERE id=?')
        .bind(connection?.revision ?? null, id)
        .run()
      return { ...r, connection }
    })
    const client = injected?.client ?? new AmazonSourceClient(env, undefined, run.connection!)
    const orders =
      injected?.orders ??
      (async (start: string, end: string, token?: string) => {
        const c = await sourceConnection(env, run.connection!)
        const api = new AmazonUS(c.credentials, undefined, env.DB)
        return api.haulSalesPage(start, end, token)
      })
    for (const kind of ['inventory', 'listings'] as const) {
      // Report creation is read-only but Amazon offers no idempotency key. A crash after Amazon accepts
      // the request may create an extra report; only the checkpointed ID can be ingested or published.
      const reportId = await step.do('source-create-' + kind, retry, () => client.create(kind))
      let documentId: string | null = null,
        sourceAt: string | null = null
      for (let poll = 0; poll < 120; poll++) {
        const result = await step.do('source-poll-' + kind + '-' + poll, retry, () =>
          client.poll(reportId),
        )
        if (result.status === 'DONE') {
          if (!result.documentId) throw new Error('SOURCE_REPORT_DOCUMENT_MISSING')
          documentId = result.documentId
          sourceAt = result.sourceAt
          break
        }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(result.status))
          throw new Error('SOURCE_REPORT_TERMINAL_FAILURE')
        await step.sleep('source-wait-' + kind + '-' + poll, '30 seconds')
      }
      if (!documentId) throw new Error('SOURCE_REPORT_POLL_TIMEOUT')
      const key = `inventory-source/${id}/${kind}`
      await step.do('source-download-' + kind, retry, () =>
        client.download(documentId!, env.ARCHIVE, key + '/raw.tsv'),
      )
      const manifest = await step.do('source-chunk-' + kind, retry, async () => {
        const object = await env.ARCHIVE.get(key + '/raw.tsv')
        if (!object) throw new Error('SOURCE_ARCHIVE_MISSING')
        let chunk: SourceRow[] = [],
          chunks = 0,
          rows = 0
        const save = async () => {
          await env.ARCHIVE.put(`${key}/chunk-${chunks}.json`, JSON.stringify(chunk))
          rows += chunk.length
          chunks++
          chunk = []
          if (chunks > 1600) throw new Error('SOURCE_REPORT_SIZE_LIMIT')
        }
        const coverage = sourceReportCoverage()
        coverage.sourceCharset = object.customMetadata?.sourceCharset
        for await (const row of parseReport(object.body, kind, coverage)) {
          chunk.push(row)
          if (chunk.length === 500) await save()
        }
        if (chunk.length) await save()
        const result = { chunks, rows, reportId, documentId, coverage }
        await env.ARCHIVE.put(key + '/manifest.json', JSON.stringify(result))
        return result
      })
      // One checkpoint per bounded chunk: retries do not repeat the full 200k-row D1 ingestion.
      for (let chunk = 0; chunk < manifest.chunks; chunk++) {
        await step.do('source-stage-' + kind + '-' + chunk, retry, async () => {
          const object = await env.ARCHIVE.get(`${key}/chunk-${chunk}.json`)
          if (!object) throw new Error('SOURCE_CHUNK_MISSING')
          await store.stage(id, kind, await object.json<SourceRow[]>(), chunk)
        })
      }
      await step.do('source-complete-' + kind, retry, () =>
        store.completePart(id, kind, reportId, manifest.rows, sourceAt, manifest.coverage),
      )
    }
    let token: string | undefined,
      pages = 0
    const tokens = new Set<string>()
    for (;;) {
      const pageToken = token
      const result: { nextToken: string | null } = await step.do(
        'source-orders-' + pages,
        retry,
        async () => {
          const page = await orders(
            new Date(run.order_from).toISOString(),
            new Date(run.order_through).toISOString(),
            pageToken,
          )
          const skus = page.orders.flatMap((o) =>
            o.items.filter((i) => i.units > 0 && i.sku && sourceChannel(i.sku)).map((i) => i.sku!),
          )
          await store.ordered(
            id,
            skus,
            `AMAZON_HAUL_ORDERS:${run.order_from}:${run.order_through}:page-${pages}`,
          )
          // Archive qualification evidence only; no buyer names, addresses, or access tokens.
          await env.ARCHIVE.put(
            `inventory-source/${id}/orders-${pages}.json`,
            JSON.stringify({
              skus: [...new Set(skus)],
              from: run.order_from,
              through: run.order_through,
            }),
          )
          return { nextToken: page.nextToken }
        },
      )
      pages++
      if (!result.nextToken) break
      if (tokens.has(result.nextToken) || pages >= 2000)
        throw new Error('SOURCE_ORDER_PAGINATION_INCOMPLETE')
      tokens.add(result.nextToken)
      token = result.nextToken
    }
    await step.do('source-orders-complete', retry, () => store.completePart(id, 'orders', null, pages))
    await step.do('source-publish', retry, async () => {
      if (run.connection) await sourceConnection(env, run.connection)
      await store.publish(id)
    })
    // Checkpoint every bounded candidate page. A partial seed cannot authorize execution.
    await seedInventoryAutomatic(env, id, step)
    for (let batch = 0; batch < 400; batch++) {
      const removed = await step.do('automatic-prune-' + batch, retry, () =>
        new InventoryAutomatic(env).prune(),
      )
      if (removed.removed < 5000 && removed.scansRemoved < 100) break
    }
    // Keep two completed snapshots; clear older/failed staging in bounded D1 mutations.
    // R2 reports remain archived and all run/qualification metadata is retained.
    for (let batch = 0; batch < 400; batch++) {
      const removed = await step.do('source-prune-' + batch, retry, () => store.prune(id))
      if (removed < 5000) break
    }
    return { generation: id, mode: 'READ_ONLY', executionEnabled: false }
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowInternalError') throw error
    await step.do('source-failed', async () => store.fail(id, error))
    // Never serialize upstream response bodies, credentials, presigned URLs, or pagination tokens.
    throw new Error(sourceErrorCode(error))
  }
}
