import { expect, it } from 'vitest'
import type { Actor } from '../../apps/api/src/access'
import { sourceConnection } from '../../packages/inventory-sync/source'
import { type PerformanceFact, savePerformanceFacts } from '../../packages/store-sales/facts'
import { performanceReport, performanceSkus, setPerformanceOwner } from '../../packages/store-sales/live'
import { investigationFixture } from './assistant-run-fixture'

const time = new Date('2026-11-17T12:00:00Z')
const actor = (id: string, role: Actor['role']) => ({
  id,
  role,
  username: id,
  email: '',
  local: false,
  position: null,
})
async function fixture() {
  const f = investigationFixture()
  const env = { ...f.env, SP_CLIENT_ID: 'app', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' }
  f.db.exec(
    "INSERT INTO title_audit_store(singleton,seller) VALUES(1,'STORE'); UPDATE accounts SET role='admin' WHERE id='alice'",
  )
  const { identity } = await sourceConnection(env)
  f.db
    .prepare('INSERT INTO performance_sync_state VALUES(?,?,?,?,?)')
    .run(
      identity.seller,
      identity.revision,
      '2026-11-10T08:00:00.000Z',
      '2026-11-17T11:57:00.000Z',
      time.toISOString(),
    )
  f.db.exec(
    "INSERT INTO weekly_feedback_owner_rules VALUES('STORE','ATVPDKIKX0DER','prefix','BOB-',1,'bob','alice')",
  )
  const line: PerformanceFact = {
    orderId: 'o',
    itemId: '1',
    purchasedAt: '2026-11-17T07:59:59.000Z',
    updatedAt: '2026-11-17T08:00:00.000Z',
    sku: 'BOB-JIT-1',
    asin: null,
    title: 'bob product',
    quantity: 2,
    status: 'SHIPPED',
    cancelled: false,
    itemCents: 400,
    shippingCents: 100,
    discountCents: 0,
    taxCents: 0,
    knownCents: 500,
    rawJson: '{}',
  }
  await savePerformanceFacts(
    env.DB,
    identity,
    [
      line,
      {
        ...line,
        itemId: '2',
        sku: 'ALICE-1',
        title: 'alice product',
        quantity: 3,
        knownCents: 900,
        rawJson: '{"id":2}',
      },
      {
        ...line,
        itemId: '3',
        sku: null,
        title: 'missing sku',
        quantity: 1,
        knownCents: null,
        rawJson: '{"id":3}',
      },
      {
        ...line,
        itemId: '4',
        sku: 'BOB-J1T-2',
        title: 'cancelled',
        quantity: 4,
        cancelled: true,
        status: 'CANCELLED',
        knownCents: null,
        rawJson: '{"id":4}',
      },
      {
        ...line,
        itemId: '5',
        purchasedAt: '2026-11-17T08:00:00.000Z',
        quantity: 100,
        rawJson: '{"id":5}',
      },
    ],
    time.toISOString(),
  )
  return { ...f, env, identity }
}

it('uses real LA-day facts, does not multiply line money, and distinguishes unassigned and incomplete amounts', async () => {
  const { db, env } = await fixture()
  try {
    const report = await performanceReport(env, actor('alice', 'admin'), time)
    expect(report.source).toBe('live')
    expect(report.policy).toMatchObject({
      status: 'pending_confirmation',
      sourceReport: null,
      confirmedDateBasis: null,
    })
    const day = report.days[0]
    expect(day.date).toBe('2026-11-16')
    expect(day.team).toMatchObject({
      units: 10,
      cents: 1400,
      review: { units: 5, lines: 2, missingAmount: 2 },
    })
    expect(day.quality).toMatchObject({ unassignedUnits: 4, cancelledUnits: 4, missingSkuUnits: 1 })
    expect(day.coverage).toBe('synced')
    expect(day.operators.find((r) => r.name === 'bob')?.summary.units).toBe(6)
    expect(report.listingsStatus).toBe('pending')
  } finally {
    db.close()
  }
})

it('scopes employee detail server-side while retaining team totals and hides unassigned detail', async () => {
  const { db, env } = await fixture()
  try {
    const report = await performanceReport(env, actor('bob', 'operator'), time)
    expect(report.days[0].team.units).toBe(10)
    expect(report.days[0].operators.map((r) => r.name)).toEqual(['bob'])
    expect(report.days[0].products.map((r) => r.sku).sort()).toEqual(['BOB-J1T-2', 'BOB-JIT-1'])
    expect(JSON.stringify(report)).not.toContain('alice product')
    const viewer = await performanceReport(env, actor('viewer', 'viewer'), time)
    expect(viewer.days[0].operators).toEqual([])
    expect(viewer.days[0].products).toEqual([])
  } finally {
    db.close()
  }
})

it('reuses manual ownership ahead of rules and audits a correction without duplicating quantities', async () => {
  const { db, env } = await fixture()
  try {
    await setPerformanceOwner(env, actor('alice', 'admin'), 'BOB-JIT-1', 'alice')
    const report = await performanceReport(env, actor('alice', 'admin'), time)
    expect(report.days[0].team.units).toBe(10)
    expect(report.days[0].operators.find((r) => r.name === 'alice')?.summary.units).toBe(2)
    expect(
      db.prepare('SELECT previous_account_id,account_id,actor FROM performance_owner_history').get(),
    ).toMatchObject({ previous_account_id: 'bob', account_id: 'alice', actor: 'alice' })
    const list = await performanceSkus(env, actor('alice', 'admin'), 'BOB-')
    expect(list.items.find((r) => r.sku === 'BOB-JIT-1')).toMatchObject({
      accountId: 'alice',
      source: 'manual',
    })
    await setPerformanceOwner(env, actor('alice', 'admin'), 'BOB-JIT-1', null)
    expect(
      db
        .prepare(
          'SELECT previous_account_id,account_id FROM performance_owner_history ORDER BY rowid DESC LIMIT 1',
        )
        .get(),
    ).toMatchObject({ previous_account_id: 'alice', account_id: 'bob' })
    await expect(
      setPerformanceOwner(env, actor('bob', 'operator'), 'BOB-JIT-1', 'bob'),
    ).rejects.toMatchObject({ status: 403 })
    await expect(performanceSkus(env, actor('bob', 'operator'), '')).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      setPerformanceOwner(env, actor('alice', 'admin'), 'NOT-IN-STORE', 'bob'),
    ).rejects.toMatchObject({ status: 404 })
  } finally {
    db.close()
  }
})

it('never presents a half-read baseline as a complete day or leaks facts across a connection change', async () => {
  const { db, env } = await fixture()
  try {
    db.exec('UPDATE performance_sync_state SET through_at=NULL')
    const partial = await performanceReport(env, actor('alice', 'admin'), time)
    expect(partial.days[0].coverage).toBe('partial')
    env.SP_REFRESH_TOKEN = 'new-authorization'
    const switched = await performanceReport(env, actor('alice', 'admin'), time)
    expect(switched.days).toEqual([])
    expect(switched.source).toBe('pending')
  } finally {
    db.close()
  }
})
