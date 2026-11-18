import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'
import { automaticRuntime } from './inventory-automatic-runtime.mjs'
import { browserAutomatic } from './inventory-browser-automatic.mjs'
import { browserHandoff } from './inventory-browser-handoff.mjs'

const calls = []
const automaticStocks = new Map()
let liveSellable = 3
async function outbound(request) {
  const url = new URL(request.url)
  calls.push(request.method + ' ' + url.pathname)
  // Every outbound request is intercepted locally. Only token exchange/report creation may POST;
  // inventory and Listing fixtures are GET-only, and unrecognized requests never reach the network.
  const tokenExchange = url.hostname === 'api.amazon.com' && url.pathname === '/auth/o2/token'
  const reportCreation = url.pathname === '/reports/2021-06-30/reports' && request.method === 'POST'
  assert.ok(
    ['api.amazon.com', 'sellingpartnerapi-na.amazon.com', 'fixture.s3.amazonaws.com'].includes(
      url.hostname,
    ),
  )
  assert.equal(request.method, tokenExchange || reportCreation ? 'POST' : 'GET')
  if (tokenExchange) return Response.json({ access_token: 'fixture-access', expires_in: 3600 })
  if (url.pathname === '/reports/2021-06-30/reports' && request.method === 'POST') {
    const body = await request.json()
    return Response.json({
      reportId: body.reportType === 'GET_FBA_MYI_ALL_INVENTORY_DATA' ? 'inventory' : 'listings',
    })
  }
  if (url.pathname.startsWith('/reports/2021-06-30/reports/'))
    return Response.json({
      processingStatus: 'DONE',
      reportDocumentId: url.pathname.split('/').at(-1),
      createdTime: new Date().toISOString(),
    })
  if (url.pathname.startsWith('/reports/2021-06-30/documents/'))
    return Response.json({ url: 'https://fixture.s3.amazonaws.com/' + url.pathname.split('/').at(-1) })
  if (url.hostname === 'fixture.s3.amazonaws.com')
    return new Response(
      url.pathname === '/inventory'
        ? 'sku\tafn-fulfillable-quantity\tstore\tfnsku\n' +
          'FIXTURE-JIT\t3\tLow-Cost Store\tX000000001\n' +
          'FIXTURE-J1T\t0\tLow-Cost Store\tX000000002\n' +
          'FIXTURE-JIT\t1\tMAIN\tX000000003\n'
        : 'seller-sku\tstatus\topen-date\nFIXTURE-JIT\tActive\t2026-01-01T00:00:00Z\nFIXTURE-J1T\tActive\t' +
            new Date(Date.now() - 60000).toISOString() +
            '\n',
    )
  if (url.pathname === '/orders/2026-01-01/orders')
    return Response.json({
      orders: [
        {
          orderId: 'fixture-order',
          createdTime: new Date(Date.parse(url.searchParams.get('createdBefore')) - 60000).toISOString(),
          programs: ['AMAZON_HAUL'],
          salesChannel: { marketplaceId: 'ATVPDKIKX0DER' },
          orderItems: [
            { orderItemId: 'fixture-item', product: { sellerSku: 'FIXTURE-JIT' }, quantityOrdered: 1 },
          ],
        },
      ],
    })
  if (url.pathname === '/fba/inventory/v1/summaries') {
    const skus = url.searchParams.get('sellerSkus').split(',')
    if (skus.every((sku) => automaticStocks.has(sku)))
      return Response.json({
        payload: {
          inventorySummaries: skus.map((sku) => ({
            sellerSku: sku,
            stores: ['Low-Cost Store'],
            condition: 'NewItem',
            inventoryDetails: { fulfillableQuantity: automaticStocks.get(sku) },
            lastUpdatedTime: new Date().toISOString(),
          })),
        },
      })
    assert.equal(url.searchParams.get('sellerSkus'), 'FIXTURE-JIT')
    assert.equal(url.searchParams.get('marketplaceIds'), 'ATVPDKIKX0DER')
    return Response.json({
      payload: {
        inventorySummaries: [
          {
            sellerSku: 'FIXTURE-JIT',
            stores: ['Low-Cost Store'],
            condition: 'NewItem',
            inventoryDetails: { fulfillableQuantity: liveSellable },
            lastUpdatedTime: new Date().toISOString(),
          },
        ],
      },
    })
  }
  if (url.pathname.startsWith('/listings/2021-08-01/items/SELLER1/AUTO-')) {
    const sku = decodeURIComponent(url.pathname.split('/').at(-1))
    const imageOnlyNew = sku.endsWith('-001-JIT')
    assert.ok(automaticStocks.has(sku))
    return Response.json({
      sku,
      attributes: { purchasable_offer: [{ marketplace_id: 'ATVPDKIKX0DER', audience: 'BZR' }] },
      summaries: [
        {
          marketplaceId: 'ATVPDKIKX0DER',
          status: imageOnlyNew ? ['DISCOVERABLE'] : ['BUYABLE', 'DISCOVERABLE'],
          createdDate: '2026-01-01T00:00:00Z',
        },
      ],
      issues: imageOnlyNew
        ? [
            {
              code: '20014',
              severity: 'ERROR',
              categories: ['INVALID_IMAGE', 'INVALID_ATTRIBUTE', 'LISTING'],
            },
          ]
        : [],
    })
  }
  if (url.pathname === '/listings/2021-08-01/items/SELLER1/FIXTURE-JIT') {
    assert.equal(url.searchParams.get('includedData'), 'summaries,issues,attributes')
    assert.equal(url.searchParams.get('marketplaceIds'), 'ATVPDKIKX0DER')
    return Response.json({
      sku: 'FIXTURE-JIT',
      attributes: { purchasable_offer: [{ marketplace_id: 'ATVPDKIKX0DER', audience: 'BZR' }] },
      summaries: [
        {
          marketplaceId: 'ATVPDKIKX0DER',
          status: ['BUYABLE', 'DISCOVERABLE'],
          createdDate: '2026-01-01T00:00:00Z',
        },
      ],
      issues: [],
    })
  }
  throw new Error('Unexpected outbound request: ' + url.pathname)
}
const shared = {
  modules: true,
  compatibilityDate: '2026-10-01',
  d1Databases: { DB: 'inventory-fixture' },
  r2Buckets: { ARCHIVE: 'inventory-fixture' },
  outboundService: outbound,
}
const flow = { name: 'inventory-run', className: 'ResearchWorkflow' }
const assistant = { name: 'inventory-assistant', className: 'AssistantWorkflow' }
// Chromium hashes the unpacked native path (UTF-16 on Windows) for its extension ID.
// Allow that exact test origin through Miniflare's internal /cdn-cgi proxy guard;
// the application still receives and validates the original browser headers.
const fixtureExtensionId = createHash('sha256')
  .update(
    Buffer.from(
      resolve('extensions/sellerflex-inventory'),
      process.platform === 'win32' ? 'utf16le' : 'utf8',
    ),
  )
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...shared,
        name: 'api',
        routes: ['htcerp.app/*', fixtureExtensionId + '/*'],
        scriptPath: process.env.HTC_INVENTORY_API_BUNDLE ?? '.local/dry-api/index.js',
        bindings: {
          LOCAL_DEVELOPMENT: '1',
          SP_CLIENT_ID: 'fixture-id',
          SP_CLIENT_SECRET: 'fixture-secret',
          SP_REFRESH_TOKEN: 'fixture-refresh',
        },
        workflows: {
          RUNNER: { ...flow, scriptName: 'jobs' },
          ASSISTANT_RUNNER: { ...assistant, scriptName: 'jobs' },
        },
      },
      {
        ...shared,
        name: 'jobs',
        scriptPath: process.env.HTC_INVENTORY_JOBS_BUNDLE ?? '.local/dry-jobs/index.js',
        bindings: {
          SP_CLIENT_ID: 'fixture-id',
          SP_CLIENT_SECRET: 'fixture-secret',
          SP_REFRESH_TOKEN: 'fixture-refresh',
        },
        workflows: { RUNNER: flow, ASSISTANT_RUNNER: assistant },
      },
    ],
  }),
)
try {
  const db = await mf.getD1Database('DB', 'api')
  for (const f of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const sql of splitSQL(readFileSync('migrations/' + f, 'utf8'))) await db.prepare(sql).run()
  await db.prepare("INSERT INTO title_audit_store VALUES(1,'SELLER1',0)").run()
  const api = await mf.getWorker('api'),
    base = 'http://127.0.0.1'
  let sessionCookie = ''
  async function admin(path, body) {
    const res = await api.fetch(base + '/api/inventory-sync' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', Cookie: sessionCookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    return res.json()
  }
  assert.equal((await api.fetch('https://fixture.test/api/inventory-sync')).status, 401)
  assert.equal((await api.fetch(base + '/api/inventory-device/work')).status, 401)
  await admin('/settings', { enabled: true, mode: 'READ_ONLY', intervalMinutes: 60 })
  const { runId } = await admin('/scan', {})
  assert.match(runId, /^inventory-patrol-/)
  const { RUNNER } = await mf.getBindings('jobs')
  const instance = await RUNNER.get(runId)
  let status
  for (let n = 0; n < 160; n++) {
    const execution = await instance.status()
    assert.notEqual(execution.status, 'errored', JSON.stringify(execution))
    status = await admin('')
    if (status.latest?.state === 'FAILED') throw new Error('Readonly workflow failed')
    if (status.current) break
    await delay(250)
  }
  assert.equal(status.current?.state, 'COMPLETE', JSON.stringify({ latest: status.latest, calls }))
  const fnskuIndex = await db
    .prepare(`SELECT f.sku,f.fnsku FROM inventory_source_current c
      JOIN inventory_source_fnskus f ON f.generation=c.generation ORDER BY f.sku`)
    .all()
  assert.deepEqual(fnskuIndex.results, [
    { sku: 'FIXTURE-J1T', fnsku: 'X000000002' },
    { sku: 'FIXTURE-JIT', fnsku: 'X000000001' },
  ])
  const candidates = await admin('/candidates')
  assert.equal(candidates.rows.length, 2)
  assert.ok(candidates.rows.every((r) => r.executionEligible === false))
  assert.deepEqual(candidates.rows.map((r) => r.candidateQuantity).sort(), [2, 2])
  assert.equal((await admin('/scan', {})).runId, null)
  const jobs = await mf.getWorker('jobs')
  await jobs.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' })
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_source_runs').first()).n, 1)
  const pair = await admin('/pair', {})
  const state = {},
    alarms = {}
  const chrome = {
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async (key) => ({ [key]: structuredClone(state[key]) }),
        set: async (value) => Object.assign(state, structuredClone(value)),
        remove: async (key) => {
          delete state[key]
        },
      },
    },
    alarms: {
      get: async (key) => alarms[key],
      create: async (key, value) => {
        alarms[key] = value
      },
    },
  }
  let loseResponse = true
  const transport = async (url, init) => {
    const response = await api.fetch(url, init)
    if (url.endsWith('/results') && loseResponse) {
      loseResponse = false
      throw new Error('Simulated disconnect after server accepted receipt')
    }
    return response
  }
  const factory = () => {
    const scope = { TextEncoder, URL, AbortSignal, structuredClone }
    runInNewContext(readFileSync('extensions/sellerflex-inventory/connector.js', 'utf8'), scope)
    return scope.SellerFlexConnector.create({
      chrome,
      crypto: webcrypto,
      fetch: transport,
      allowLocalTest: true,
    })
  }
  const connector = factory()
  const paired = await connector.pair({
    baseUrl: base,
    code: pair.code,
    name: 'Worker integration fixture',
  })
  await admin('/test', { deviceId: paired.deviceId })
  assert.equal((await connector.poll()).pending, true)
  const restarted = factory()
  assert.equal((await restarted.poll()).pending, false)
  const final = await admin('')
  assert.ok(final.devices[0].last_test_passed)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_device_tests').first()).n, 1)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_replenishment_jobs').first()).n, 0)
  await admin('/revoke', { deviceId: paired.deviceId })
  assert.ok((await restarted.poll()).error)
  assert.ok(!calls.some((call) => /feeds|listings\/2021-08-01/.test(call)))

  // Exercise actual cookie sessions, rather than bypassing login for connection grants.
  const accountResponse = await api.fetch(base + '/api/accounts', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'fixture-admin',
      password: 'isolated-fixture-password',
      role: 'admin',
    }),
  })
  assert.equal(accountResponse.status, 201, await accountResponse.clone().text())
  const login = await api.fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-admin', password: 'isolated-fixture-password' }),
  })
  assert.equal(login.status, 200, await login.clone().text())
  sessionCookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await api.fetch(base + '/api/inventory-sync/connection/session')).status, 401)
  assert.equal((await admin('/connection/session')).actor.role, 'admin')
  const verifier = 'f'.repeat(64)
  const challenge = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('hex')
  const grantRequest = { requestId: webcrypto.randomUUID(), challenge, name: 'Second isolated computer' }
  const grant = await admin('/connection/authorize', grantRequest)
  assert.deepEqual(await admin('/connection/authorize', grantRequest), grant)
  const redeem = async () => {
    const response = await api.fetch(base + '/api/inventory-device/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantId: grant.grantId, verifier }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const secondDevice = await redeem()
  assert.deepEqual(await redeem(), secondDevice)
  const crossOrigin = await api.fetch(base + '/api/inventory-sync/connection/authorize', {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.test',
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify(grantRequest),
  })
  assert.equal(crossOrigin.status, 403)

  // Exercise the actual Worker live routes against scoped, read-only Amazon fixtures.
  const livePair = await admin('/pair', {})
  const livePairResponse = await api.fetch(base + '/api/inventory-device/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: livePair.code, name: 'Live Worker integration fixture' }),
  })
  assert.equal(livePairResponse.status, 200, await livePairResponse.clone().text())
  const liveDevice = await livePairResponse.json()
  async function deviceLive(path, body = {}, device = liveDevice) {
    const response = await api.fetch(base + '/api/inventory-device/live' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + device.token },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  async function selectExecutor(device) {
    const current = await admin('')
    const request = {
      requestId: webcrypto.randomUUID(),
      deviceId: device.deviceId,
      expectedExecutorId: current.executor.deviceId,
      expectedVersion: current.executor.version,
      expectedTrialId: current.activeTrialId,
    }
    const result = await admin('/executor', request)
    assert.deepEqual(await admin('/executor', request), result)
    return result
  }
  await selectExecutor(liveDevice)
  const trial = await admin('/live/trial', { skus: ['FIXTURE-JIT'] })
  assert.equal(trial.trial.state, 'READY')
  assert.equal(trial.automaticExecutionEnabled, false)
  const liveClaim = (await deviceLive('/claim')).job
  assert.equal(liveClaim.mode, 'REAL_TRIAL')
  assert.equal(liveClaim.state, 'CLAIMED')
  const oldCommand = { jobId: liveClaim.id, leaseId: liveClaim.leaseId }
  assert.equal((await deviceLive('/claim', {}, secondDevice)).job, null)
  await selectExecutor(secondDevice)
  const beforeUpload = (await deviceLive('/claim', {}, secondDevice)).job
  assert.equal(beforeUpload.id, liveClaim.id)
  assert.notEqual(beforeUpload.leaseId, liveClaim.leaseId)
  assert.equal(beforeUpload.needsReconciliation, false)
  const retired = await deviceLive('/claim', {
    previousJobId: oldCommand.jobId,
    previousLeaseId: oldCommand.leaseId,
  })
  assert.equal(retired.previousJob.state, 'TRANSFERRED')
  assert.equal(retired.previousJob.submitted, false)
  const secondCommand = { jobId: beforeUpload.id, leaseId: beforeUpload.leaseId }
  const livePrepared = (await deviceLive('/prepare', secondCommand, secondDevice)).job
  assert.equal(livePrepared.state, 'SUBMITTING')
  assert.equal(livePrepared.rows.length, 1)
  assert.equal(livePrepared.rows[0].sku, 'FIXTURE-JIT')
  assert.equal(livePrepared.rows[0].quantity, 2)
  assert.ok(livePrepared.csv.includes('FIXTURE-JIT,2,GOOD'))
  assert.equal(
    livePrepared.sha256,
    Array.from(
      new Uint8Array(
        await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(livePrepared.csv)),
      ),
      (value) => value.toString(16).padStart(2, '0'),
    ).join(''),
  )
  const repeatedPrepare = (await deviceLive('/prepare', secondCommand, secondDevice)).job
  assert.equal(Object.hasOwn(repeatedPrepare, 'csv'), false)
  assert.equal(repeatedPrepare.needsReconciliation, true)
  // Losing the upload/acknowledgement must never produce a second CSV on another computer.
  await selectExecutor(liveDevice)
  const watchOnly = (await deviceLive('/claim')).job
  assert.equal(watchOnly.filename, livePrepared.filename)
  assert.equal(watchOnly.sha256, livePrepared.sha256)
  assert.equal(watchOnly.needsReconciliation, true)
  const command = { jobId: watchOnly.id, leaseId: watchOnly.leaseId }
  assert.equal(Object.hasOwn((await deviceLive('/prepare', command)).job, 'csv'), false)
  const staleDispatch = await api.fetch(base + '/api/inventory-device/live/dispatched', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secondDevice.token },
    body: JSON.stringify(secondCommand),
  })
  assert.equal(staleDispatch.status, 409)
  const submittedRetirement = await deviceLive(
    '/claim',
    { previousJobId: secondCommand.jobId, previousLeaseId: secondCommand.leaseId },
    secondDevice,
  )
  assert.equal(submittedRetirement.previousJob.submitted, true)
  assert.equal((await deviceLive('/claim')).job.filename, livePrepared.filename)
  assert.equal((await deviceLive('/dispatched', command)).accepted, true)
  const liveReceipt = {
    ...command,
    eventId: 'fixture-live-complete',
    filename: livePrepared.filename,
    sha256: livePrepared.sha256,
    warehouseCode: 'A1C5',
    status: 'COMPLETED',
    errorCount: 0,
    evidence: { rowText: livePrepared.filename + ' Completed 0', observedAt: Date.now() },
  }
  assert.equal((await deviceLive('/results', liveReceipt)).accepted, true)
  assert.equal((await deviceLive('/results', liveReceipt)).replay, true)
  const waiting = await admin('/live/status')
  assert.equal(waiting.trial.state, 'WAITING_API')
  assert.equal(waiting.jobs[0].rowStates[0].outcome, 'SUCCEEDED')
  assert.equal(waiting.jobs[0].rowStates[0].active, true)
  assert.equal((await deviceLive('/claim')).job, null)
  liveSellable = 5
  await delay(5)
  const automaticReconcile = await deviceLive('/claim')
  assert.equal(automaticReconcile.job, null)
  assert.equal(automaticReconcile.state, 'COMPLETE')
  const reconciled = await admin('/live/reconcile', {})
  assert.equal(reconciled.trial.state, 'COMPLETE')
  assert.equal(reconciled.jobs[0].rowStates[0].active, false)
  assert.equal((await deviceLive('/claim')).job, null)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_replenishment_jobs').first()).n, 1)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_live_events').first()).n, 1)
  assert.ok(calls.some((call) => call === 'GET /fba/inventory/v1/summaries'))
  assert.ok(calls.some((call) => call === 'GET /listings/2021-08-01/items/SELLER1/FIXTURE-JIT'))
  assert.ok(
    !calls.some(
      (call) =>
        /feeds|sellerflex/i.test(call) || /^(POST|PUT|PATCH|DELETE) \/(fba|listings)\//.test(call),
    ),
  )
  const browser =
    process.env.INVENTORY_BROWSER_TEST === '1'
      ? await browserHandoff({
          api,
          admin,
          setSellable: (value) => {
            liveSellable = value
          },
        })
      : null
  const executorBeforeAutomatic = (await admin('')).executor
  if (executorBeforeAutomatic.deviceId !== liveDevice.deviceId) await selectExecutor(liveDevice)
  const automatic = await automaticRuntime({
    api,
    db,
    admin,
    device: liveDevice,
    stocks: automaticStocks,
  })
  const automaticBrowser =
    process.env.INVENTORY_BROWSER_TEST === '1'
      ? await browserAutomatic({ api, db, admin, stocks: automaticStocks })
      : null
  mkdirSync('.local/inventory-integration', { recursive: true })
  const report = {
    passed: true,
    realAmazonWrites: 0,
    environment: 'local Miniflare Workers/D1/R2/Workflows',
    checks: [
      'readonly reports workflow',
      'atomic complete snapshot',
      'hourly cron deduplication',
      'admin/device auth',
      'original extension connector pair',
      'canonical file checksum receipt',
      'lost acknowledgement + service worker restart replay',
      'device revocation',
      'real cookie login + proof-bound one-click connection + response-loss replay',
      'cross-origin grant denied and anonymous session denied',
      'executor selection replay and standby device cannot claim',
      'unsubmitted transfer requires new lease and fresh API preflight',
      'possibly issued CSV transfers reconciliation only with unchanged filename/hash',
      'old device credentials cannot dispatch after transfer',
      'simulation leaves real replenishment queue empty',
      'fresh API inventory + Listing issues within exact Low-Cost Store scope',
      'bounded live trial claim + prepare + canonical receive manifest',
      'repeat prepare cannot authorize another upload',
      'idempotent successful platform receipt remains locked during API lag',
      'API target confirmation completes trial without automatic reupload',
      'later device polling automatically reconciles API lag without manual intervention',
      'all Amazon calls intercepted locally; no inventory or Listing writes',
    ],
    candidates: candidates.rows.length,
    liveTrialState: reconciled.trial.state,
    liveQuantity: livePrepared.rows[0].quantity,
    browser,
    automatic,
    automaticBrowser,
  }
  writeFileSync(
    '.local/inventory-integration/runtime-result.json',
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report))
} finally {
  await mf.dispose()
}
