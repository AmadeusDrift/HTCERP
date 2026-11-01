import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'

const calls = []
const { publicKey, privateKey } = await generateKeyPair('RS256')
const issuer = 'https://fixture.cloudflareaccess.com'
const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256' }
async function fixture(request) {
  const url = new URL(request.url)
  calls.push(url.pathname)
  if (url.href === 'https://api.amazon.com/auth/o2/token') {
    assert.equal((await request.formData()).get('refresh_token'), 'fixture-refresh')
    return Response.json({ access_token: 'fixture-access' })
  }
  if (
    url.origin === 'https://sellingpartnerapi-na.amazon.com' &&
    url.pathname === '/catalog/2022-04-01/items'
  ) {
    assert.equal(request.headers.get('x-amz-access-token'), 'fixture-access')
    assert.equal(url.searchParams.get('marketplaceIds'), 'ATVPDKIKX0DER')
    if (url.searchParams.get('keywords') === 'desk organizer') return Response.json({ items: [] })
    assert.match(url.searchParams.get('keywords'), /measuring spoon/i)
    return Response.json({
      items: [
        {
          asin: 'B000000001',
          summaries: [
            { marketplaceId: 'ATVPDKIKX0DER', itemName: 'Measuring Spoon Set', packageQuantity: 2 },
          ],
          salesRanks: [
            { marketplaceId: 'ATVPDKIKX0DER', displayGroupRanks: [{ rank: 1050, title: 'Kitchen' }] },
          ],
        },
      ],
    })
  }
  if (
    url.origin === 'https://sellingpartnerapi-na.amazon.com' &&
    url.pathname === '/products/pricing/v0/items/B000000001/offers'
  ) {
    assert.equal(url.searchParams.get('MarketplaceId'), 'ATVPDKIKX0DER')
    return Response.json({
      payload: {
        Offers: [
          {
            ListingPrice: { Amount: 8.5, CurrencyCode: 'USD' },
            Shipping: { Amount: 1.5, CurrencyCode: 'USD' },
          },
        ],
      },
    })
  }
  if (url.origin === issuer && url.pathname === '/cdn-cgi/access/certs')
    return Response.json({ keys: [jwk] })
  if (url.origin === 'https://openapi.geekbi.com' && url.pathname.endsWith('/goods/search')) {
    assert.equal(request.headers.get('X-GB-App-Key'), 'workflow-fixture-app-key')
    assert.equal(url.searchParams.get('siteId'), '48')
    assert.equal(url.searchParams.get('catIds'), '9711')
    assert.ok(request.headers.get('X-GB-Signature'))
    const goods = (id, sold, price) => ({
      goodsId: String(id),
      goodsName: '量匙 2件套',
      goodsNameEn: id === 1 ? 'Measuring Spoon Set, 2 Pieces' : 'Kitchen Mixing Bowl',
      sold,
      minPrice: price,
      siteId: 48,
      catItems: [{ catId: 9711, parentCatId: 0, catName: '家居' }],
      updateTime: '2026-10-30T09:00:00+08:00',
    })
    return Response.json(
      {
        code: 0,
        data: {
          hasMore: false,
          total: 5,
          list: [
            goods(1, 50000, 4),
            goods(2, 30000, 4),
            goods(3, 10000, 4),
            goods(4, 9999, 1),
            goods(5, 100000, 5),
          ],
        },
      },
      { headers: { 'x-gb-price-points': '10' } },
    )
  }
  if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/alpha/decisions') {
    assert.equal(request.headers.get('authorization'), 'Bearer workflow-fixture-router')
    const body = await request.json()
    assert.equal(body.model, 'openai/gpt-6-luna-decisions')
    assert.ok(body.questions.route)
    return Response.json({
      answers: {
        route: {
          type: 'choice',
          choice: 'research',
          confidence: 0.9,
          probabilities: { research: 0.9, observe: 0.05, review: 0.05 },
        },
      },
      usage: { cost: 0.0003 },
    })
  }
  if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
    assert.equal(request.headers.get('authorization'), 'Bearer workflow-fixture-router')
    const body = await request.json()
    assert.equal(body.model, 'openai/gpt-6.1-terra')
    const state = JSON.parse(body.messages[1].content)
    assert.equal(state.products[0].id, 'temu:US:1')
    assert.equal(state.products[0].min_price, 4)
    assert.equal(state.products[0].total_sold, 50000)
    assert.equal(state.amazonComparisons[0].productId, 'temu:US:1')
    assert.equal(state.amazonComparisons[0].status, 'found')
    const [candidate] = state.amazonComparisons[0].candidates
    assert.equal(candidate.asin, 'B000000001')
    assert.equal(candidate.rank, 1050)
    assert.equal(candidate.price, 8.5)
    assert.equal(candidate.shipping, 1.5)
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: '离线验证报告',
              standardProduct: '核对尺寸',
              differentiation: '比较图案',
              selection: { verdict: 'insufficient', reason: '候选 ASIN 的容量仍待核实。' },
              missing: ['候选商品容量'],
              nextActions: ['人工确认'],
            }),
          },
        },
      ],
      usage: { cost: 0.002 },
    })
  }
  throw new Error('Unexpected outbound request in fixture')
}
const shared = {
  modules: true,
  compatibilityDate: '2026-10-01',
  d1Databases: { DB: 'fixture-catalog' },
  r2Buckets: { ARCHIVE: 'fixture-r2' },
  outboundService: fixture,
}
const binding = { name: 'fixture-run', className: 'ResearchWorkflow' }
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...shared,
        name: 'api',
        scriptPath: '.local/dry-api/index.js',
        bindings: { LOCAL_DEVELOPMENT: '1', CONNECTIONS_KEY: 'cd'.repeat(32) },
        workflows: { RUNNER: { ...binding, scriptName: 'jobs' } },
      },
      {
        ...shared,
        name: 'jobs',
        scriptPath: '.local/dry-jobs/index.js',
        bindings: { CONNECTIONS_KEY: 'cd'.repeat(32) },
        workflows: { RUNNER: binding },
      },
      {
        ...shared,
        name: 'secure-api',
        routes: ['fixture.test/*'],
        scriptPath: '.local/dry-api/index.js',
        bindings: {
          ACCESS_TEAM_DOMAIN: 'fixture.cloudflareaccess.com',
          ACCESS_AUD: 'fixture-app',
          APP_ROLES: '{"owner@example.test":"admin","reader@example.test":"viewer"}',
        },
        workflows: { RUNNER: { ...binding, scriptName: 'jobs' } },
      },
    ],
  }),
)
try {
  const db = await mf.getD1Database('DB', 'api')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const statement of splitSQL(readFileSync('migrations/' + file, 'utf8')))
      await db.prepare(statement).run()
  }
  const secure = await mf.getWorker('secure-api')
  const tokenFor = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('fixture-app')
      .setExpirationTime('5m')
      .sign(privateKey)
  assert.equal((await secure.fetch('https://fixture.test/api/session')).status, 401)
  const auth = { 'Cf-Access-Jwt-Assertion': await tokenFor('reader@example.test') }
  assert.equal((await secure.fetch('https://fixture.test/api/session', { headers: auth })).status, 401)
  assert.equal(
    (await secure.fetch('https://fixture.test/api/auth/setup', { headers: auth })).status,
    403,
  )
  async function api(path, body) {
    const response = await mf.dispatchFetch(
      'http://127.0.0.1/api' + path,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    const data = await response.json()
    assert.ok(response.ok, JSON.stringify(data))
    return data
  }
  for (const [provider, credentials] of [
    ['geekbi', { GB_APP_KEY: 'workflow-fixture-app-key', GB_APP_SECRET: 'workflow-fixture-app-secret' }],
    ['openrouter', { OPENROUTER_API_KEY: 'workflow-fixture-router' }],
    [
      'amazon',
      {
        SP_CLIENT_ID: 'fixture-id',
        SP_CLIENT_SECRET: 'fixture-secret',
        SP_REFRESH_TOKEN: 'fixture-refresh',
      },
    ],
  ]) {
    assert.deepEqual(await api('/connections/' + provider + '/credentials', { credentials }), {
      ok: true,
    })
  }
  assert.equal((await api('/connections/amazon/test', {})).status, 'catalog_verified')
  const strategy = await api('/strategy')
  assert.deepEqual(strategy.connections, { geekbi: true, productData: true, openrouter: true })
  await api('/strategy', {
    baseVersion: strategy.version,
    settings: { ...strategy.settings, focusLimit: 0, dataDailyPoints: 10, aiDailyMicros: 50000 },
  })
  async function complete(job) {
    const spec = await api('/jobs', job)
    for (let i = 0; i < 200; i++) {
      const run = await api('/jobs/' + spec.id)
      if (!['running', 'queued'].includes(run.status)) {
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        return run
      }
      await delay(150)
    }
    throw new Error('Workflow did not reach a terminal state ' + spec.id)
  }
  const discovery = await complete({
    kind: 'discovery',
    requestId: 'fixture-discovery',
    inputs: { mode: 'live', maxDataPoints: 10, maxAiMicros: 0 },
  })
  assert.equal(discovery.usage.dataPoints, 10)
  assert.match(discovery.summary, /首次入库 3 件，复访 0 件/)
  assert.equal((await api('/products')).total, 3)
  const search = discovery.steps.find((s) => s.key === 'search-1')
  assert.equal(search.result.matched, 3)
  assert.equal(search.result.missingSold, 0)
  const bucket = await mf.getR2Bucket('ARCHIVE', 'jobs')
  const archived = await db
    .prepare('SELECT evidence_ref FROM job_steps WHERE run_id=? AND step_key=?')
    .bind(discovery.id, search.key)
    .first()
  assert.ok(await bucket.head(archived.evidence_ref))
  const research = await complete({
    kind: 'research',
    requestId: 'fixture-research',
    inputs: { mode: 'live', productId: 'temu:US:1', goal: 'E2E 离线验证', maxAiMicros: 50000 },
  })
  const reportStep = research.steps.find((s) => s.key === 'terra')
  assert.deepEqual(
    research.steps.map((s) => s.key),
    ['plan', 'decision', 'amazon-compare', 'terra', 'review-task'],
  )
  const comparison = research.steps.find((s) => s.key === 'amazon-compare').result.comparisons[0]
  assert.equal(comparison.status, 'found')
  assert.equal(comparison.sourceSold, 50000)
  assert.match(comparison.query, /measuring spoon/i)
  assert.equal(comparison.candidates[0].price, 8.5)
  assert.equal(reportStep.result.summary, '离线验证报告')
  assert.deepEqual(reportStep.result.selection, {
    verdict: 'insufficient',
    reason: '候选 ASIN 的容量仍待核实。',
  })
  const reportDate = new Date(Date.parse(discovery.createdAt) + 8 * 3600000).toISOString().slice(0, 10)
  const daily = await api('/daily?date=' + reportDate)
  assert.equal(daily.summary.selected, 3)
  assert.equal(daily.summary.linked, 0)
  assert.equal(research.usage.aiMicros, 2300)
  assert.equal(calls.filter((p) => p.endsWith('/goods/search')).length, 1)
  assert.equal(calls.filter((p) => p === '/api/alpha/decisions').length, 1)
  assert.equal(calls.filter((p) => p === '/api/v1/chat/completions').length, 1)
  assert.ok(calls.lastIndexOf('/catalog/2022-04-01/items') > calls.indexOf('/api/alpha/decisions'))
  assert.ok(
    calls.lastIndexOf('/products/pricing/v0/items/B000000001/offers') <
      calls.indexOf('/api/v1/chat/completions'),
  )
  const site = 'https://fixture.test'
  const ownerJWT = { 'Cf-Access-Jwt-Assertion': await tokenFor('owner@example.test') }
  const form = await secure.fetch(site + '/api/auth/setup', { headers: ownerJWT })
  assert.equal(form.status, 200)
  assert.match(await form.text(), /type="password"/)
  const password = 'fixture only password'
  const setup = await secure.fetch(site + '/api/auth/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...ownerJWT, Origin: site, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', password }).toString(),
  })
  assert.equal(setup.status, 303, await setup.text())
  const json = (path, body, cookie = '', method = 'POST') =>
    secure.fetch(site + '/api' + path, {
      method,
      headers: { Origin: site, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  async function loginCookie(username) {
    const signedIn = await json('/auth/login', { username, password })
    assert.equal(signedIn.status, 200)
    const cookie = signedIn.headers.get('Set-Cookie')
    assert.match(cookie, /^__Host-/)
    return cookie.split(';')[0]
  }
  const ownerCookie = await loginCookie('owner')
  const created = await json(
    '/accounts',
    { username: 'reader', password, position: 'operations_lead' },
    ownerCookie,
  )
  assert.equal(created.status, 201)
  const viewer = await created.json()
  assert.equal(viewer.role, 'viewer')
  assert.equal(viewer.position, 'operations_lead')
  const readerCookie = await loginCookie('reader')
  const memberGet = (path) => secure.fetch(site + '/api' + path, { headers: { Cookie: readerCookie } })
  assert.equal((await memberGet('/connections')).status, 403)
  assert.equal((await (await memberGet('/auth/me')).json()).position, 'operations_lead')
  const memberStrategy = await (await memberGet('/strategy')).json()
  assert.equal('models' in memberStrategy || 'connections' in memberStrategy, false)
  assert.deepEqual(memberStrategy.capabilities, { discovery: false, research: false })
  assert.equal((await json('/strategy', {}, readerCookie)).status, 403)
  assert.equal((await json('/me/preferences', { view: 'grid', pageSize: 50 }, readerCookie)).status, 200)
  assert.equal((await json('/jobs', {}, readerCookie)).status, 403)
  assert.equal(
    (await json('/accounts/' + viewer.id, { active: false }, ownerCookie, 'PATCH')).status,
    200,
  )
  assert.equal(
    (await secure.fetch(site + '/api/session', { headers: { Cookie: readerCookie } })).status,
    401,
  )
  console.log(
    'Workerd fixture passed: API → Workflow → D1/R2, three tiers, Decisions → Amazon US → Terra, confirmed usage.',
  )
} finally {
  await mf.dispose()
}
