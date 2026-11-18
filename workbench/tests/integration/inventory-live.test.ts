import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import {
  amazonLiveReader,
  InventoryLive,
  type LiveDevice,
  type LiveReceipt,
  liveInventory,
  liveListing,
} from '../../packages/inventory-sync/live'
import { ReplenishmentQueue } from '../../packages/inventory-sync/queue'
import { type InventoryObservation, inventoryKey, scopeKey } from '../../packages/inventory-sync/rules'
import { sourceConnection } from '../../packages/inventory-sync/source'

const start = Date.parse('2026-11-16T12:00:00Z')
const offerAttributes = {
  purchasable_offer: [{ marketplace_id: 'ATVPDKIKX0DER', audience: 'BZR', currency: 'USD' }],
}
const base: InventoryObservation = {
  sellerAccountId: 'SELLER',
  marketplaceId: 'ATVPDKIKX0DER',
  warehouseCode: 'A1C5',
  binCode: 'Default',
  inventoryType: 'GOOD',
  sku: 'ONE-JIT',
  sellable: 3,
  listingStatus: 'active',
  hasOrdered: true,
  createdAt: start - 30 * 86400000,
  observedAt: start,
}
const device: LiveDevice = {
  id: 'device-a',
  scope_json: JSON.stringify({
    sellerAccountId: base.sellerAccountId,
    marketplaceId: base.marketplaceId,
    warehouseCode: base.warehouseCode,
  }),
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  for (const migration of [
    '0041_inventory_replenishment.sql',
    '0042_inventory_source.sql',
    '0043_inventory_devices.sql',
    '0044_inventory_live.sql',
    '0045_inventory_device_handoff.sql',
    '0046_inventory_automatic.sql',
    '0047_inventory_order_history.sql',
    '0058_inventory_new_listing_pause.sql',
  ])
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'))
  sqlite.exec(
    "CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY,seller TEXT); INSERT INTO title_audit_store VALUES(1,'SELLER'); CREATE TABLE connection_credentials(provider TEXT,version INTEGER,nonce TEXT,ciphertext TEXT)",
  )
  sqlite
    .prepare('INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at) VALUES(?,?,?,?,?)')
    .run(device.id, 'a'.repeat(64), 'Fixture device', device.scope_json, start)
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = sqlite.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => statement.get(...values) ?? null,
      all: () => ({ results: statement.all(...values) }),
      run: () => ({ meta: statement.run(...values) }),
    }
  }
  const DB = {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  const rows = new Map<string, Partial<InventoryObservation>>([
    ['ONE-JIT', {}],
    ['TWO-J1T', {}],
  ])
  const archives: string[] = []
  const env = {
    DB,
    SP_CLIENT_ID: 'client',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
    ARCHIVE: {
      put: async (key: string) => {
        archives.push(key)
      },
    } as unknown as R2Bucket,
  }
  const reader = async (_identity: unknown, skus: string[], now: number) => ({
    observations: skus.map((sku) => ({ ...base, ...rows.get(sku), sku, observedAt: now })),
    updatedAt: Object.fromEntries(skus.map((sku) => [sku, start - 1000])),
    evidence: { fixture: true },
  })
  return { sqlite, DB, rows, archives, env, service: new InventoryLive(env, reader) }
}
async function create(f: ReturnType<typeof fixture>, skus = ['ONE-JIT']) {
  await f.service.createTrial('admin@test', { skus }, start)
  const claimed = (await f.service.claim(device, start + 10)).job!
  return { jobId: claimed.id, leaseId: claimed.leaseId }
}
async function submitted(f: ReturnType<typeof fixture>, skus = ['ONE-JIT']) {
  const keys = await create(f, skus)
  const prepared = (await f.service.prepare(device, keys, start + 20)).job
  await f.service.dispatched(device, keys, start + 21)
  return { keys, prepared }
}
function result(
  job: Awaited<ReturnType<InventoryLive['prepare']>>['job'],
  patch: Partial<LiveReceipt> = {},
): LiveReceipt {
  return {
    jobId: job.id,
    leaseId: job.leaseId,
    eventId: 'event-1',
    filename: job.filename!,
    sha256: job.sha256!,
    warehouseCode: 'A1C5',
    status: 'COMPLETED',
    errorCount: 0,
    evidence: { rowText: job.filename + ' Completed 0', observedAt: start + 30 },
    ...patch,
  }
}

it('bounds real trials to the explicit allowlist and rechecks 3 → 4 before creating the file', async () => {
  const f = fixture()
  try {
    const keys = await create(f)
    const q = new ReplenishmentQueue(f.DB)
    await q.scan(
      'unrelated',
      [{ ...base, sku: 'OTHER-JIT' }],
      { complete: true, source: 'fixture' },
      start,
    )
    f.rows.set('ONE-JIT', { sellable: 4 })
    const prepared = (await f.service.prepare(device, keys, start + 20)).job
    expect(prepared.rows).toHaveLength(1)
    expect(prepared.rows[0].quantity).toBe(1)
    expect('csv' in prepared && prepared.csv).toContain('ONE-JIT,1,GOOD')
    const repeat = (await f.service.prepare(device, keys, start + 21)).job
    expect('csv' in repeat).toBe(false)
    expect(repeat.needsReconciliation).toBe(true)
    expect((await f.service.claim(device, start + 22)).job?.id).toBe(keys.jobId)
    await expect(f.service.createTrial('admin', { skus: ['OTHER-JIT'] }, start + 23)).rejects.toThrow(
      '未完成',
    )
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_rows').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})

it('retains new qualification for a trial with missing listing dates and reconciles at two', async () => {
  const f = fixture()
  const q = new ReplenishmentQueue(f.DB)
  await q.configure('admin', { enabledAt: start, intervalMinutes: 60 })
  await q.scan(
    'new-qualification',
    [{ ...base, sellable: 0, hasOrdered: false, createdAt: start - 1000, observedAt: start - 1 }],
    { complete: true, source: 'fixture' },
    start - 1,
  )
  f.rows.set('ONE-JIT', { sellable: 0, hasOrdered: null, createdAt: null })
  const { prepared } = await submitted(f)
  expect(prepared.rows[0].quantity).toBe(2)
  await f.service.results(device, result(prepared), start + 30)
  expect((await f.service.status()).trial?.state).toBe('WAITING_API')
  f.rows.set('ONE-JIT', { sellable: 2, hasOrdered: null, createdAt: null })
  expect((await f.service.reconcile(start + 1000)).trial?.state).toBe('COMPLETE')
  f.sqlite.close()
})

it('skips a listing newly banned at preflight and never returns a receive file', async () => {
  const f = fixture()
  try {
    const keys = await create(f)
    f.rows.set('ONE-JIT', { listingStatus: 'banned' })
    const prepared = (await f.service.prepare(device, keys, start + 20)).job
    expect(prepared.state).toBe('SKIPPED')
    expect('csv' in prepared).toBe(false)
    expect((await f.service.status()).trial?.state).toBe('SKIPPED')
  } finally {
    f.sqlite.close()
  }
})

it('blocks other devices and changed credentials even with the original job lease', async () => {
  const f = fixture()
  try {
    const keys = await create(f)
    const other = { ...device, id: 'device-b' }
    expect((await f.service.claim(other, start + 15)).job).toBeNull()
    await expect(f.service.prepare(other, keys, start + 20)).rejects.toThrow('当前设备')
    f.env.SP_REFRESH_TOKEN = 'changed'
    await expect(f.service.prepare(device, keys, start + 20)).rejects.toThrow('CONNECTION_CHANGED')
  } finally {
    f.sqlite.close()
  }
})

it('keeps receipt-confirmed rows locked through API lag and completes only after target confirmation', async () => {
  const f = fixture()
  try {
    const { prepared } = await submitted(f)
    const event = result(prepared)
    expect((await f.service.results(device, event, start + 30)).accepted).toBe(true)
    expect((await f.service.status()).trial?.state).toBe('WAITING_API')
    expect((await f.service.claim(device, start + 200000)).job).toBeNull()
    expect((await f.service.results(device, event, start + 31)).replay).toBe(true)
    await expect(
      f.service.results(
        device,
        { ...event, evidence: { ...event.evidence, rowText: 'edited' } },
        start + 32,
      ),
    ).rejects.toThrow('修改内容')
    f.rows.set('ONE-JIT', { sellable: 5 })
    expect((await f.service.reconcile(start + 300000)).trial?.state).toBe('COMPLETE')
    expect((await f.service.claim(device, start + 400000)).job).toBeNull()
    expect(f.archives.some((key) => key.includes('/receipt-'))).toBe(true)
  } finally {
    f.sqlite.close()
  }
})

it('locks unknown receipts, rejects mismatched manifests, and permits a later conclusive receipt', async () => {
  const f = fixture()
  try {
    const { keys, prepared } = await submitted(f)
    await expect(
      f.service.results(device, result(prepared, { filename: 'wrong.csv' }), start + 30),
    ).rejects.toThrow('回执')
    await f.service.results(
      device,
      result(prepared, { status: 'UNKNOWN', errorCount: null }),
      start + 30,
    )
    expect((await f.service.status()).trial?.state).toBe('UNKNOWN')
    const resumed = (await f.service.claim(device, start + 900000)).job!
    expect(resumed.filename).toBe(prepared.filename)
    expect(resumed.leaseId).toBe(keys.leaseId)
    expect('csv' in (await f.service.prepare(device, keys, start + 900001)).job).toBe(false)
    await f.service.results(device, result(prepared, { eventId: 'confirmed' }), start + 900002)
    expect((await f.service.status()).trial?.state).toBe('WAITING_API')
  } finally {
    f.sqlite.close()
  }
})

it('does not guess partial failure row numbers, but maps exact unique SKU errors', async () => {
  const f = fixture()
  try {
    const { prepared } = await submitted(f, ['ONE-JIT', 'TWO-J1T'])
    await f.service.results(
      device,
      result(prepared, { errorCount: 1, errors: [{ fileRow: 1, message: 'invalid quantity' }] }),
      start + 30,
    )
    expect((await f.service.status()).jobs[0].rowStates.every((r) => r.outcome === 'UNKNOWN')).toBe(true)
    await f.service.results(
      device,
      result(prepared, {
        eventId: 'exact',
        errorCount: 1,
        errors: [{ sku: 'ONE-JIT', message: 'invalid quantity' }],
      }),
      start + 40,
    )
    const outcomes = (await f.service.status()).jobs[0].rowStates
    expect(outcomes.find((r) => r.sku === 'ONE-JIT')?.outcome).toBe('FAILED')
    expect(outcomes.find((r) => r.sku === 'TWO-J1T')?.outcome).toBe('SUCCEEDED')
  } finally {
    f.sqlite.close()
  }
})

it('retries explicit file failures after 2 minutes, at most 3 times after initial attempt', async () => {
  const f = fixture()
  try {
    await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start)
    let now = start + 10
    for (let attempt = 0; attempt < 4; attempt++) {
      const claimed = (await f.service.claim(device, now)).job!
      expect(claimed).not.toBeNull()
      const keys = { jobId: claimed.id, leaseId: claimed.leaseId }
      const prepared = (await f.service.prepare(device, keys, now + 1)).job
      const event = result(prepared, {
        eventId: 'fail-' + attempt,
        status: 'FAILED',
        errorCount: null,
        evidence: { rowText: prepared.filename + ' Failed', observedAt: now + 2 },
      })
      await f.service.results(device, event, now + 2)
      await f.service.results(device, event, now + 3)
      expect((await f.service.claim(device, now + 1000)).job).toBeNull()
      now += 120010
    }
    expect((await f.service.claim(device, now)).job).toBeNull()
    expect((await f.service.status()).trial?.state).toBe('FAILED')
    expect(
      f.sqlite.prepare('SELECT failure_count,paused FROM inventory_replenishment_demands').get(),
    ).toMatchObject({ failure_count: 4, paused: 1 })
    await expect(f.service.createTrial('admin', { skus: ['ONE-JIT'] }, now + 10)).rejects.toThrow('上限')
  } finally {
    f.sqlite.close()
  }
})

it('holds unqualified zero and accepts zero only with positive eligibility evidence', async () => {
  const f = fixture()
  try {
    f.rows.set('ONE-JIT', { sellable: 0, hasOrdered: null })
    await expect(f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start)).rejects.toThrow('不符合')
    f.rows.set('ONE-JIT', { sellable: 0, hasOrdered: true })
    await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start + 1)
    expect((await f.service.claim(device, start + 2)).job?.rows[0].quantity).toBe(5)
  } finally {
    f.sqlite.close()
  }
})

it('requires exact Low-Cost Store, NewItem and unique inventory API rows', () => {
  const row = {
    sellerSku: 'ONE-JIT',
    stores: ['Low-Cost Store'],
    condition: 'NewItem',
    inventoryDetails: { fulfillableQuantity: 3 },
  }
  expect(liveInventory([row], 'ONE-JIT').sellable).toBe(3)
  for (const rows of [
    [row, row],
    [{ ...row, stores: ['MAIN'] }],
    [{ ...row, stores: undefined }],
    [{ ...row, stores: ['Low-Cost Store', 'MAIN'] }],
    [{ ...row, condition: 'UsedLikeNew' }],
  ])
    expect(() => liveInventory(rows, 'ONE-JIT')).toThrow()
})

it('reads listing issues and holds unknown or suppressed status even when BUYABLE appears', () => {
  const listing = {
    sku: 'ONE-JIT',
    attributes: offerAttributes,
    summaries: [{ marketplaceId: base.marketplaceId, status: ['BUYABLE', 'DISCOVERABLE'] }],
    issues: [] as unknown[],
  }
  expect(liveListing(listing, 'ONE-JIT').status).toBe('active')
  expect(liveListing({ ...listing, issues: [{ severity: 'ERROR' }] }, 'ONE-JIT').status).toBe('unknown')
  expect(
    liveListing(
      { ...listing, summaries: [{ marketplaceId: base.marketplaceId, status: ['BUYABLE'] }] },
      'ONE-JIT',
    ).status,
  ).toBe('unknown')
  expect(liveListing(listing, 'WRONG-JIT').status).toBe('unknown')
})

it('permits verified image 300404 errors and material warnings while a listing remains buyable and discoverable', () => {
  const listing = {
    sku: 'ONE-JIT',
    attributes: offerAttributes,
    summaries: [{ marketplaceId: base.marketplaceId, status: ['BUYABLE', 'DISCOVERABLE'] }],
    issues: [
      { code: '300404', severity: 'ERROR', categories: ['LISTING'] },
      { code: '300404', severity: 'ERROR', categories: ['LISTING', 'INVALID_IMAGE'] },
      { code: '18448', severity: 'WARNING', categories: ['MISSING_ATTRIBUTE', 'LISTING'] },
    ],
  }
  expect(liveListing(listing, 'ONE-JIT').status).toBe('active')
  expect(
    liveListing(
      { ...listing, summaries: [{ marketplaceId: base.marketplaceId, status: ['DISCOVERABLE'] }] },
      'ONE-JIT',
    ).status,
  ).toBe('out_of_stock')
  for (const status of [['BUYABLE'], []]) {
    expect(
      liveListing({ ...listing, summaries: [{ marketplaceId: base.marketplaceId, status }] }, 'ONE-JIT')
        .status,
    ).toBe('unknown')
  }
  for (const action of ['LISTING_SUPPRESSED', 'SEARCH_SUPPRESSED', 'CATALOG_ITEM_REMOVED']) {
    expect(
      liveListing(
        {
          ...listing,
          issues: [
            ...listing.issues,
            {
              code: '300404',
              severity: 'ERROR',
              categories: ['LISTING'],
              enforcements: { actions: [{ action }] },
            },
          ],
        },
        'ONE-JIT',
      ).status,
    ).toBe('suppressed')
  }
  for (const category of [
    'RESTRICTED_PRODUCT',
    'QUALIFICATION_REQUIRED',
    'LISTING_SUPPRESSED',
    'CATALOG_ITEM_REMOVED',
    'PROHIBITED_PRODUCT',
    'APPROVAL_REQUIRED',
  ]) {
    expect(
      liveListing(
        {
          ...listing,
          issues: [...listing.issues, { code: '300404', severity: 'WARNING', categories: [category] }],
        },
        'ONE-JIT',
      ).status,
    ).toBe('suppressed')
  }
  for (const issue of [
    { code: '999999', severity: 'ERROR', categories: ['LISTING'] },
    { code: '300404', severity: 'ERROR', categories: ['UNKNOWN_CATEGORY'] },
    { code: '300404', severity: 'ERROR', categories: [] },
    { code: '300404', severity: 'ERROR' },
  ]) {
    expect(liveListing({ ...listing, issues: [...listing.issues, issue] }, 'ONE-JIT').status).toBe(
      'unknown',
    )
  }
})

it('ignores image errors but blocks rejected attributes even when the listing remains buyable', () => {
  const listing = (issues: unknown[], status = ['BUYABLE', 'DISCOVERABLE']) => ({
    sku: 'ONE-JIT',
    attributes: offerAttributes,
    summaries: [{ marketplaceId: base.marketplaceId, status }],
    issues,
  })
  const attribute = {
    code: '100476',
    severity: 'ERROR',
    categories: ['INVALID_ATTRIBUTE', 'LISTING'],
    attributeNames: ['title_differentiation'],
    enforcements: { actions: [{ action: 'ATTRIBUTE_SUPPRESSED' }] },
  }
  const images = [
    { code: '300404', severity: 'ERROR', categories: ['LISTING'] },
    ...['20000', '20014', '100581'].map((code) => ({
      code,
      severity: 'ERROR',
      categories: ['INVALID_IMAGE', 'INVALID_ATTRIBUTE', 'LISTING'],
    })),
  ]
  for (const issue of images) {
    expect(liveListing(listing([issue]), 'ONE-JIT').status).toBe('active')
    expect(liveListing(listing([issue], ['DISCOVERABLE']), 'ONE-JIT').status).toBe('out_of_stock')
    expect(
      liveListing(
        listing([{ ...issue, enforcements: { actions: [{ action: 'ATTRIBUTE_SUPPRESSED' }] } }]),
        'ONE-JIT',
      ).status,
    ).toBe('suppressed')
    for (const action of ['LISTING_SUPPRESSED', 'SEARCH_SUPPRESSED', 'CATALOG_ITEM_REMOVED']) {
      expect(
        liveListing(
          listing([
            attribute,
            { ...issue, enforcements: { actions: [{ action: 'ATTRIBUTE_SUPPRESSED' }, { action }] } },
          ]),
          'ONE-JIT',
        ).status,
      ).toBe('suppressed')
    }
  }
  expect(liveListing(listing([attribute]), 'ONE-JIT').status).toBe('suppressed')
  expect(liveListing(listing([attribute], ['DISCOVERABLE']), 'ONE-JIT').status).toBe('suppressed')
  expect(
    liveListing(
      listing([attribute, { code: '100390', severity: 'ERROR', categories: ['PRODUCT'] }]),
      'ONE-JIT',
    ).status,
  ).toBe('suppressed')
  expect(
    liveListing(
      listing([...images, { code: '100390', severity: 'ERROR', categories: ['PRODUCT'] }]),
      'ONE-JIT',
    ).status,
  ).toBe('unknown')
  expect(
    liveListing(
      listing([{ ...images[0], enforcements: { actions: [{ action: 'UNKNOWN_ENFORCEMENT' }] } }]),
      'ONE-JIT',
    ).status,
  ).toBe('unknown')
  expect(liveListing(listing(images, ['BUYABLE', 'DISCOVERABLE', 'DELETED']), 'ONE-JIT').status).toBe(
    'closed',
  )
})

it('automatically distinguishes a closed Low-Cost Store offer from an out-of-stock offer', () => {
  const listing = {
    sku: 'ONE-JIT',
    summaries: [{ marketplaceId: base.marketplaceId, status: ['DISCOVERABLE'] }],
    issues: [],
    attributes: offerAttributes,
  }
  const offer = offerAttributes.purchasable_offer[0]
  const check = (offers: unknown, status = ['DISCOVERABLE']) =>
    liveListing(
      {
        ...listing,
        summaries: [{ marketplaceId: base.marketplaceId, status }],
        attributes: { purchasable_offer: offers },
      },
      'ONE-JIT',
      start,
    ).status
  // Actual 388 API shape: no issues, DISCOVERABLE, but its BZR offer ended on October 28.
  expect(check([{ ...offer, end_at: { value: '2026-10-28T11:23:57.642Z' } }])).toBe('closed')
  expect(
    check([{ ...offer, end_at: { value: new Date(start).toISOString() } }], ['BUYABLE', 'DISCOVERABLE']),
  ).toBe('closed')
  // Actual 496 API shape: zero stock, DISCOVERABLE, open-ended BZR offer.
  expect(check([offer])).toBe('out_of_stock')
  expect(
    check([
      {
        ...offer,
        start_at: { value: new Date(start).toISOString() },
        end_at: { value: new Date(start + 1).toISOString() },
      },
    ]),
  ).toBe('out_of_stock')
  expect(check([{ ...offer, start_at: { value: new Date(start + 1).toISOString() } }])).toBe('unknown')
  expect(check([{ ...offer, end_at: { value: 'not-a-date' } }])).toBe('unknown')
  expect(check([{ ...offer, end_at: null }])).toBe('unknown')
  expect(check([offer, offer])).toBe('unknown')
  expect(check([])).toBe('closed')
  expect(check(undefined)).toBe('unknown')
  expect(liveListing({ ...listing, attributes: undefined }, 'ONE-JIT', start).status).toBe('unknown')
  expect(check([{ ...offer, audience: 'ALL' }])).toBe('unknown')
  expect(check([{ ...offer, marketplace_id: 'OTHER' }])).toBe('unknown')
  expect(
    check([
      { ...offer, end_at: { value: new Date(start - 1).toISOString() } },
      { ...offer, audience: 'ALL' },
    ]),
  ).toBe('closed')
  expect(
    check([offer, { ...offer, audience: 'ALL', end_at: { value: new Date(start - 1).toISOString() } }]),
  ).toBe('out_of_stock')
})

it('reads only selected inventory and fresh listing issues through bound credentials', async () => {
  const f = fixture()
  const calls: { url: URL; method: string }[] = []
  try {
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'fixture-token' })
      if (url.pathname === '/fba/inventory/v1/summaries')
        return Response.json({
          payload: {
            inventorySummaries: [
              {
                sellerSku: 'ONE-JIT',
                stores: ['Low-Cost Store'],
                condition: 'NewItem',
                inventoryDetails: { fulfillableQuantity: 2 },
              },
            ],
          },
        })
      if (url.pathname === '/listings/2021-08-01/items/SELLER/ONE-JIT')
        return Response.json({
          sku: 'ONE-JIT',
          attributes: offerAttributes,
          summaries: [{ marketplaceId: base.marketplaceId, status: ['DISCOVERABLE', 'BUYABLE'] }],
          issues: [],
        })
      throw new Error('Unexpected HTTP request')
    }) as typeof fetch
    const reader = amazonLiveReader(f.env, request)
    const { identity } = await sourceConnection(f.env)
    const snapshot = await reader(identity, ['ONE-JIT'], start)
    expect(snapshot.observations[0]).toMatchObject({
      sellable: 2,
      listingStatus: 'active',
      warehouseCode: 'A1C5',
    })
    expect(
      calls.find((call) => call.url.pathname.includes('summaries'))?.url.searchParams.get('sellerSkus'),
    ).toBe('ONE-JIT')
    expect(
      calls.find((call) => call.url.pathname.includes('listings'))?.url.searchParams.get('includedData'),
    ).toBe('summaries,issues,attributes')
    expect(
      calls
        .filter((call) => call.url.hostname !== 'api.amazon.com')
        .every((call) => call.method === 'GET'),
    ).toBe(true)
  } finally {
    f.sqlite.close()
  }
})

it('resumes a queue claim committed before the trial activation acknowledgement was saved', async () => {
  const f = fixture()
  try {
    const keys = await create(f)
    f.sqlite.prepare("UPDATE inventory_live_trials SET state='CLAIMING'").run()
    const resumed = (await f.service.claim(device, start + 11)).job
    expect(resumed?.id).toBe(keys.jobId)
    expect(resumed?.leaseId).toBe(keys.leaseId)
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})

it('recovers stale claims before commit and rejects invalidated claimant tokens', async () => {
  const f = fixture()
  try {
    const initial = await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start)
    f.sqlite
      .prepare("UPDATE inventory_live_trials SET state='CLAIMING',claim_token='old',device_id=?")
      .run(device.id)
    expect((await f.service.claim(device, start + 1000)).job).toBeNull()
    // Recovery first revokes the token. A delayed worker cannot insert work after that fence.
    f.sqlite.prepare("UPDATE inventory_live_trials SET state='READY',claim_token=NULL").run()
    const queue = new ReplenishmentQueue(f.DB)
    expect(
      await queue.claim(scopeKey(base), start + 120001, 2, [inventoryKey(base)], {
        id: initial.trial!.id,
        token: 'old',
      }),
    ).toBeNull()
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_jobs').get()?.n).toBe(0)
    f.sqlite.prepare("UPDATE inventory_live_trials SET state='CLAIMING',claim_token='crashed'").run()
    expect((await f.service.claim(device, start + 120002)).job?.state).toBe('CLAIMED')
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})

it('retires interrupted initialization without uploading and requires a new administrator action', async () => {
  const f = fixture()
  try {
    await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start)
    f.sqlite.prepare("UPDATE inventory_live_trials SET state='PREPARING'").run()
    expect((await f.service.claim(device, start + 300001)).job).toBeNull()
    expect((await f.service.status()).trial?.state).toBe('FAILED')
    expect((await f.service.claim(device, start + 400000)).job).toBeNull()
    await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start + 400001)
    expect((await f.service.claim(device, start + 400002)).job?.state).toBe('CLAIMED')
  } finally {
    f.sqlite.close()
  }
})

it('attests only owned expired never-submitted jobs for safe local latch replacement', async () => {
  const f = fixture()
  try {
    const old = await create(f)
    const previous = { previousJobId: old.jobId, previousLeaseId: old.leaseId }
    const renewed = await f.service.claim(device, start + 120011, previous)
    expect(renewed.job?.id).not.toBe(old.jobId)
    expect(renewed.previousJob).toEqual({
      id: old.jobId,
      leaseId: old.leaseId,
      state: 'EXPIRED',
      submitted: false,
    })
    expect((await f.service.claim(device, start + 120012, previous)).previousJob).toEqual(
      renewed.previousJob,
    )
    expect(
      (await f.service.claim({ ...device, id: 'other-device' }, start + 120013, previous)).previousJob,
    ).toBeNull()
    expect(
      (await f.service.claim(device, start + 120014, { ...previous, previousLeaseId: 'wrong' }))
        .previousJob,
    ).toBeNull()
    const job = renewed.job!
    await f.service.prepare(device, { jobId: job.id, leaseId: job.leaseId }, start + 120015)
    const submittedProof = await f.service.claim(device, start + 300000, {
      previousJobId: job.id,
      previousLeaseId: job.leaseId,
    })
    expect(submittedProof.job?.id).toBe(job.id)
    expect(submittedProof.previousJob).toBeNull()
  } finally {
    f.sqlite.close()
  }
})

it('attests a skipped never-submitted preflight after its response was lost', async () => {
  const f = fixture()
  try {
    const old = await create(f)
    const previous = { previousJobId: old.jobId, previousLeaseId: old.leaseId }
    f.rows.set('ONE-JIT', { listingStatus: 'banned' })
    expect((await f.service.prepare(device, old, start + 20)).job.state).toBe('SKIPPED')
    const recovered = await f.service.claim(device, start + 21, previous)
    expect(recovered.job).toBeNull()
    expect(recovered.previousJob).toEqual({
      id: old.jobId,
      leaseId: old.leaseId,
      state: 'SKIPPED',
      submitted: false,
    })
    expect((await f.service.claim(device, start + 22, previous)).previousJob).toEqual(
      recovered.previousJob,
    )
    expect(
      (await f.service.claim({ ...device, id: 'other-device' }, start + 23, previous)).previousJob,
    ).toBeNull()
    expect(
      (await f.service.claim(device, start + 24, { ...previous, previousLeaseId: 'wrong' })).previousJob,
    ).toBeNull()
    // A later explicitly authorized trial can return both a new job and the old terminal proof.
    f.rows.set('ONE-JIT', { sellable: 3, listingStatus: 'active' })
    await f.service.createTrial('admin', { skus: ['ONE-JIT'] }, start + 30)
    const next = await f.service.claim(device, start + 31, previous)
    expect(next.job?.id).not.toBe(old.jobId)
    expect(next.previousJob).toEqual(recovered.previousJob)
    // Even a corrupt terminal status does not attest a job with submission evidence.
    f.sqlite
      .prepare('UPDATE inventory_replenishment_jobs SET submitted_at=? WHERE id=?')
      .run(start + 19, old.jobId)
    expect((await f.service.claim(device, start + 32, previous)).previousJob).toBeNull()
  } finally {
    f.sqlite.close()
  }
})

it('automatically reconciles a confirmed receipt on later device polling without creating new work', async () => {
  const f = fixture()
  try {
    const { prepared } = await submitted(f)
    await f.service.results(device, result(prepared), start + 30)
    expect((await f.service.status()).trial?.state).toBe('WAITING_API')
    expect((await f.service.claim(device, start + 60000)).state).toBe('WAITING_API')
    expect((await f.service.status()).jobs[0].rowStates[0].active).toBe(true)
    f.rows.set('ONE-JIT', { sellable: 5 })
    const poll = await f.service.claim(device, start + 120000)
    expect(poll.job).toBeNull()
    expect(poll.state).toBe('COMPLETE')
    expect((await f.service.status()).trial?.state).toBe('COMPLETE')
    expect((await f.service.status()).jobs[0].rowStates[0].active).toBe(false)
    expect((await f.service.claim(device, start + 180000)).job).toBeNull()
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM inventory_replenishment_jobs').get()?.n).toBe(1)
  } finally {
    f.sqlite.close()
  }
})
