import type { Actor } from '../../apps/api/src/access'
import type { ConnectionBindings } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { type SourceIdentity, sourceConnection } from '../inventory-sync/source'
import { marketplace } from '../weekly-feedback/model'
import { feedbackOwnerRules, matchFeedbackOwner } from '../weekly-feedback/owner-rules'
import { dailySalesWindow } from './daily'
import {
  daysBefore,
  type PerformanceSkuList,
  provisionalPolicy,
  type SaleLine,
  type SalesDay,
  type StoreSales,
  salesDay,
  summarize,
} from './report'
import type { PerformanceSyncRun } from './sync'

type Owner = { id: string; name: string; source: string }
async function ownersFor(db: D1Database, seller: string, skus: string[]) {
  const rules = await feedbackOwnerRules(db, seller)
  const accounts = (
    await db
      .prepare(
        "SELECT id,username name FROM accounts WHERE active=1 AND role IN ('admin','operator') ORDER BY username",
      )
      .all<{ id: string; name: string }>()
  ).results
  const names = new Map(accounts.map((a) => [a.id, a.name]))
  const saved = new Map<string, Owner>()
  for (let offset = 0; offset < skus.length; offset += 80) {
    const batch = skus.slice(offset, offset + 80)
    const { results } = await db
      .prepare(`SELECT sku,account_id,source FROM weekly_feedback_owners
      WHERE seller=? AND marketplace=? AND sku IN (${batch.map(() => '?').join(',')})`)
      .bind(seller, marketplace, ...batch)
      .all<{ sku: string; account_id: string; source: string }>()
    for (const row of results) {
      const name = names.get(row.account_id)
      if (name) saved.set(row.sku, { id: row.account_id, name, source: row.source })
    }
  }
  const owners = new Map<string, Owner>()
  for (const sku of skus) {
    const prior = saved.get(sku)
    const match = matchFeedbackOwner(sku, rules)
    const owner =
      prior?.source === 'manual'
        ? prior
        : match
          ? { id: match.account_id, name: names.get(match.account_id)!, source: 'rule' }
          : prior
    if (owner) owners.set(sku, owner)
  }
  return { owners, accounts }
}

type GroupedLine = {
  sku: string | null
  title: string
  units: number
  cents: number | null
  line_count: number
  cancelled_units: number
}
async function dayLines(db: D1Database, identity: SourceIdentity, date: string) {
  const { start, end } = dailySalesWindow(date)
  return (
    await db
      .prepare(`SELECT sku,MAX(title) title,SUM(quantity) units,SUM(known_cents) cents,COUNT(*) line_count,
    SUM(CASE WHEN cancelled=1 THEN quantity ELSE 0 END) cancelled_units
    FROM performance_order_lines WHERE seller=? AND connection_revision=? AND purchased_at>=? AND purchased_at<?
    GROUP BY sku,known_cents IS NULL`)
      .bind(identity.seller, identity.revision, start, end)
      .all<GroupedLine>()
  ).results
}

export async function performanceReport(
  env: ConnectionBindings,
  actor: Actor,
  now = new Date(),
): Promise<StoreSales> {
  const yesterday = daysBefore(salesDay(now), 1)
  const report: StoreSales = {
    source: 'pending',
    yesterday,
    days: [],
    policy: provisionalPolicy,
    listingsStatus: 'pending',
  }
  const source = await sourceConnection(env).catch(() => null)
  report.sync = {
    status: 'not_configured',
    coverageFrom: null,
    through: null,
    updatedAt: null,
    pages: 0,
    lines: 0,
    error: null,
  }
  if (
    !source ||
    !source.credentials.SP_REFRESH_TOKEN ||
    !source.credentials.SP_CLIENT_ID ||
    !source.credentials.SP_CLIENT_SECRET
  )
    return report
  const { identity } = source
  const db = env.DB
  const state = await db
    .prepare(
      'SELECT coverage_from,through_at,updated_at FROM performance_sync_state WHERE seller=? AND connection_revision=?',
    )
    .bind(identity.seller, identity.revision)
    .first<{ coverage_from: string; through_at: string | null; updated_at: string }>()
  const latest = await db
    .prepare(
      'SELECT * FROM performance_sync_runs WHERE seller=? AND connection_revision=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
    )
    .bind(identity.seller, identity.revision)
    .first<PerformanceSyncRun>()
  report.sync = {
    status: latest?.status ?? (state?.through_at ? 'complete' : 'idle'),
    coverageFrom: state?.coverage_from ?? null,
    through: state?.through_at ?? null,
    updatedAt: latest?.updated_at ?? state?.updated_at ?? null,
    pages: latest?.pages ?? 0,
    lines: latest?.line_count ?? 0,
    error: latest?.error ?? null,
  }
  const groups = await Promise.all(
    Array.from({ length: 7 }, async (_, offset) => {
      const date = daysBefore(yesterday, offset)
      return { date, rows: await dayLines(db, identity, date) }
    }),
  )
  const skus = [...new Set(groups.flatMap((g) => g.rows.flatMap((r) => (r.sku ? [r.sku] : []))))]
  const { owners } = await ownersFor(db, identity.seller, skus)
  for (const { date, rows } of groups) {
    const { start, end } = dailySalesWindow(date)
    const complete = !!state?.through_at && state.coverage_from <= start && state.through_at >= end
    if (!complete && !rows.length) continue
    const lines: (SaleLine & { ownerId: string | null })[] = rows.map((row) => ({
      title: row.title,
      sku: row.sku,
      operator: row.sku ? (owners.get(row.sku)?.name ?? null) : null,
      ownerId: row.sku ? (owners.get(row.sku)?.id ?? null) : null,
      units: row.units,
      unitCents: null,
      shippingCents: null,
      lineCents: row.cents,
      lineCount: row.line_count,
      isJit: row.sku ? /j(?:i|1)t/i.test(row.sku) : false,
    }))
    const visible = actor.role === 'admin' ? lines : lines.filter((line) => line.ownerId === actor.id)
    const operators = [...new Set(visible.map((line) => line.ownerId))].map((id) => {
      const owned = visible.filter((line) => line.ownerId === id)
      return { name: owned[0].operator, summary: summarize(owned, []) }
    })
    const products = new Map<string, SalesDay['products'][number]>()
    for (const line of visible) {
      if (!line.sku) continue
      const product = products.get(line.sku) ?? {
        sku: line.sku,
        title: line.title,
        operator: line.operator,
        units: 0,
        cents: 0,
      }
      product.units += line.units
      product.cents =
        product.cents === null || line.lineCents == null ? null : product.cents + line.lineCents
      products.set(line.sku, product)
    }
    report.days.push({
      date,
      coverage: complete ? 'synced' : 'partial',
      team: summarize(lines, []),
      operators,
      products: [...products.values()],
      quality: {
        unassignedUnits: lines.filter((line) => line.ownerId === null).reduce((n, l) => n + l.units, 0),
        cancelledUnits: rows.reduce((n, l) => n + l.cancelled_units, 0),
        missingSkuUnits: lines.filter((line) => !line.sku).reduce((n, l) => n + l.units, 0),
      },
    })
  }
  if (report.days.length) report.source = 'live'
  return report
}

function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可管理 SKU 运营归属。', 403)
}
async function connected(env: ConnectionBindings) {
  return sourceConnection(env).catch(() => {
    throw new PublicError('NOT_CONFIGURED', '请先完成当前店铺的 Amazon 连接。', 409)
  })
}

export async function performanceSkus(
  env: ConnectionBindings,
  actor: Actor,
  query: string,
): Promise<PerformanceSkuList> {
  requireAdmin(actor)
  const { identity } = await connected(env)
  const filter =
    'seller=? AND connection_revision=? AND sku IS NOT NULL AND instr(upper(sku),upper(?))>0'
  const args = [identity.seller, identity.revision, query]
  const { results } = await env.DB.prepare(`SELECT sku,MAX(title) title,SUM(quantity) units
    FROM performance_order_lines WHERE ${filter} GROUP BY sku ORDER BY sku LIMIT 100`)
    .bind(...args)
    .all<{ sku: string; title: string; units: number }>()
  const total = await env.DB.prepare(
    `SELECT COUNT(DISTINCT sku) total FROM performance_order_lines WHERE ${filter}`,
  )
    .bind(...args)
    .first<number>('total')
  const { owners, accounts } = await ownersFor(
    env.DB,
    identity.seller,
    results.map((r) => r.sku),
  )
  return {
    accounts,
    total: total ?? 0,
    items: results.map((row) => ({
      ...row,
      accountId: owners.get(row.sku)?.id ?? null,
      operator: owners.get(row.sku)?.name ?? null,
      source: owners.get(row.sku)?.source ?? null,
    })),
  }
}

export async function setPerformanceOwner(
  env: ConnectionBindings,
  actor: Actor,
  sku: string,
  accountId: string | null,
) {
  requireAdmin(actor)
  const { identity } = await connected(env)
  const db = env.DB
  if (
    !(await db
      .prepare(
        'SELECT 1 FROM performance_order_lines WHERE seller=? AND connection_revision=? AND sku=? LIMIT 1',
      )
      .bind(identity.seller, identity.revision, sku)
      .first())
  )
    throw new PublicError('NOT_FOUND', '当前店铺没有该 SKU 的订单记录。', 404)
  const { owners, accounts } = await ownersFor(db, identity.seller, [sku])
  if (accountId && !accounts.some((a) => a.id === accountId))
    throw new PublicError('INVALID_INPUT', '请选择启用的运营或管理员账号。', 400)
  const previous = owners.get(sku)?.id ?? null
  const resultingOwner =
    accountId ??
    matchFeedbackOwner(sku, await feedbackOwnerRules(db, identity.seller))?.account_id ??
    null
  const now = new Date().toISOString()
  const assignment = accountId
    ? db
        .prepare(`INSERT INTO weekly_feedback_owners(seller,marketplace,sku,account_id,source,updated_by,updated_at)
    VALUES(?,?,?,?,'manual',?,?) ON CONFLICT(seller,marketplace,sku) DO UPDATE SET account_id=excluded.account_id,
    source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(identity.seller, marketplace, sku, accountId, actor.id, now)
    : db
        .prepare('DELETE FROM weekly_feedback_owners WHERE seller=? AND marketplace=? AND sku=?')
        .bind(identity.seller, marketplace, sku)
  await db.batch([
    assignment,
    db
      .prepare('INSERT INTO performance_owner_history VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        crypto.randomUUID(),
        identity.seller,
        marketplace,
        sku,
        previous,
        resultingOwner,
        actor.id,
        now,
      ),
  ])
}
