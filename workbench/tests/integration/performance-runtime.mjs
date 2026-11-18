import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'

const calls = []
const previous = new Date(Date.now() - 86400000).toISOString()
const line = (id, sku, quantity) => ({
  orderItemId: id,
  quantityOrdered: quantity,
  product: { sellerSku: sku, title: sku },
  proceeds: {
    breakdowns: [
      { type: 'ITEM', subtotal: { amount: '4.00', currencyCode: 'USD' } },
      { type: 'SHIPPING', subtotal: { amount: '1.00', currencyCode: 'USD' } },
    ],
  },
})
const order = (id, items) => ({
  orderId: id,
  createdTime: previous,
  lastUpdatedTime: previous,
  programs: ['AMAZON_HAUL'],
  salesChannel: { marketplaceId: 'ATVPDKIKX0DER' },
  fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
  orderItems: items,
})
async function outbound(request) {
  const url = new URL(request.url)
  calls.push({ path: url.pathname, method: request.method })
  if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'fixture-only' })
  if (url.pathname.startsWith('/listings/')) return Response.json({ numberOfResults: 0, items: [] })
  if (url.pathname === '/orders/2026-01-01/orders') {
    assert.equal(url.searchParams.get('includedData'), 'PROCEEDS,FULFILLMENT,CANCELLATION')
    assert.equal(url.searchParams.get('maxResultsPerPage'), '100')
    const first = order('first', [line('1', 'TEST-JIT', 2)])
    return Response.json(
      url.searchParams.has('paginationToken')
        ? { orders: [first, order('second', [line('2', 'TEST-STANDARD', 3)])] }
        : { orders: [first], pagination: { nextToken: 'fixture-next' } },
    )
  }
  throw new Error('Unexpected outbound request: ' + url.pathname)
}
const common = {
  modules: true,
  compatibilityDate: '2026-10-01',
  d1Databases: { DB: 'performance-fixture' },
  r2Buckets: { ARCHIVE: 'performance-archive' },
  outboundService: outbound,
}
const bindings = {
  SP_CLIENT_ID: 'fixture',
  SP_CLIENT_SECRET: 'fixture-secret',
  SP_REFRESH_TOKEN: 'fixture-refresh',
}
const flow = { name: 'performance-runner', className: 'ResearchWorkflow' }
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...common,
        name: 'api',
        scriptPath: process.env.PERFORMANCE_API_SCRIPT ?? '.local/dry-api/index.js',
        bindings: { ...bindings, LOCAL_DEVELOPMENT: '1' },
        workflows: { RUNNER: { ...flow, scriptName: 'jobs' } },
      },
      {
        ...common,
        name: 'jobs',
        scriptPath: process.env.PERFORMANCE_JOBS_SCRIPT ?? '.local/dry-jobs/index.js',
        bindings,
        workflows: { RUNNER: flow },
      },
    ],
  }),
)
try {
  const db = await mf.getD1Database('DB', 'api')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const sql of splitSQL(readFileSync('migrations/' + file, 'utf8'))) await db.prepare(sql).run()
  await db.prepare("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'FIXTURE')").run()
  await db
    .prepare(
      "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('local','local','admin','','')",
    )
    .run()
  const cookie = 'a'.repeat(64)
  await db
    .prepare('INSERT INTO account_sessions VALUES(?,?,1,?)')
    .bind(
      createHash('sha256').update(cookie).digest('hex'),
      'local',
      Math.floor(Date.now() / 1000) + 3600,
    )
    .run()
  const api = await mf.getWorker('api')
  const read = async (path, body) => {
    const response = await api.fetch('http://127.0.0.1/api' + path, {
      headers: { 'Content-Type': 'application/json', Cookie: 'workbench_dev_session=' + cookie },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, await response.clone().text())
    return response.json()
  }
  assert.equal((await read('/store-sales')).source, 'pending')
  await db.prepare('INSERT INTO partner_orders_budget VALUES(1,12,1,?,?)')
    .bind(Date.now(), Date.now() + 5000).run()
  const started = await read('/store-sales/sync', {})
  const { RUNNER: runner } = await mf.getBindings('jobs')
  const instance = await runner.get(started.id)
  let status
  let quotaWaitObserved = false
  for (let attempt = 0; attempt < 45; attempt++) {
    status = await instance.status()
    const waiting = await db.prepare('SELECT error FROM performance_sync_runs WHERE id=?').bind(started.id).first()
    if (waiting?.error?.includes('等待共享订单读取额度')) quotaWaitObserved = true
    if (['complete', 'errored'].includes(status.status)) break
    await delay(500)
  }
  assert.equal(status.status, 'complete', JSON.stringify(status))
  assert.ok(quotaWaitObserved, 'Actual Workflow must sleep through a shared budget cooldown')
  const report = await read('/store-sales')
  assert.equal(report.source, 'live')
  assert.equal(report.sync.status, 'complete')
  assert.equal(report.policy.status, 'pending_confirmation')
  assert.equal(
    report.days.reduce((n, d) => n + d.team.units, 0),
    5,
  )
  assert.equal(
    report.days.reduce((n, d) => n + d.team.cents, 0),
    1000,
  )
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM performance_order_lines').first()).n, 2)
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM performance_order_versions').first()).n, 2)
  const skus = await read('/store-sales/skus')
  assert.equal(skus.items.length, 2)
  const account = skus.accounts[0]
  assert.ok(account)
  await read('/store-sales/owner', { sku: 'TEST-JIT', accountId: account.id })
  assert.equal((await read('/store-sales/skus?q=TEST-JIT')).items[0].accountId, account.id)
  assert.ok(calls.every((c) => c.method === 'GET' || c.path === '/auth/o2/token'))
  const evidence = {
    passed: true,
    environment: 'local Workers/D1/Workflows',
    pages: report.sync.pages,
    uniqueLines: 2,
    units: 5,
    knownCents: 1000,
    externalWrites: 0,
    quotaWaitObserved,
    checks: [
      'actual HTTP routes',
      'durable Workflow complete',
      'D1 migrations and deduplication',
      'daily report',
      'owner correction',
    ],
  }
  mkdirSync('.local/performance', { recursive: true })
  writeFileSync('.local/performance/runtime-result.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  await mf.dispose()
}
