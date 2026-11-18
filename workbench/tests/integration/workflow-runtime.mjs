import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'

const calls = []
const wecomMessages = []
const salesMessages = []
const salesWindows = []
let rejectImage = true
let exemption = 'EXEMPT_UNTIL_EXPIRY_DATE'
let infringementReason = 'Trademark misuse'
const samplePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xMrkAAAAASUVORK5CYII=', 'base64')
let assistantModelCalls = 0
const { publicKey, privateKey } = await generateKeyPair('RS256')
const issuer = 'https://fixture.cloudflareaccess.com'
const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256' }
async function fixture(request) {
  const url = new URL(request.url)
  calls.push(url.pathname)
  if (url.href === 'https://m.media-amazon.com/images/I/test.jpg')
    return new Response(samplePng, { headers: { 'content-type': 'image/png' } })
  if (url.href === 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-group-1122') {
    const message = await request.json()
    wecomMessages.push(message)
    if (message.msgtype === 'image' && rejectImage) {
      rejectImage = false
      return Response.json({ errcode: 45009 })
    }
    return Response.json({ errcode: 0 })
  }
  if (url.href === 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-sales-3344') {
    salesMessages.push(await request.json())
    return Response.json({ errcode: 0 })
  }
  if (url.href === 'https://api.amazon.com/auth/o2/token') {
    assert.equal((await request.formData()).get('refresh_token'), 'fixture-refresh')
    return Response.json({ access_token: 'fixture-access' })
  }
  if (url.origin === 'https://sellingpartnerapi-na.amazon.com' && url.pathname === '/sales/v1/orderMetrics') {
    const interval = '2025-11-13T08:00:00.000Z--2025-11-13T15:00:00.000Z'
    assert.equal(url.searchParams.get('interval'), interval)
    assert.equal(url.searchParams.get('amazonProgram'), 'AmazonHaul')
    return Response.json({ payload: [{ interval, unitCount: 22, orderItemCount: 20, totalSales: { amount: 10, currencyCode: 'USD' } }] })
  }
  if (url.origin === 'https://sellingpartnerapi-na.amazon.com' && url.pathname === '/orders/2026-01-01/orders') {
    assert.equal(url.searchParams.get('marketplaceIds'), 'ATVPDKIKX0DER')
    assert.equal(url.searchParams.get('includedData'), null)
    const start = url.searchParams.get('createdAfter')
    const end = url.searchParams.get('createdBefore')
    const entry = (id, skus, programs = ['AMAZON_HAUL']) => ({
      orderId: id, createdTime: start, programs,
      salesChannel: { marketplaceId: 'ATVPDKIKX0DER' },
      orderItems: skus.map(([sellerSku, quantityOrdered], index) => ({
        orderItemId: 'i' + index, quantityOrdered, product: { sellerSku },
      })),
    })
    const mixed = entry('mixed', [['C-JIT-01', start === '2026-11-12T08:00:00.000Z' ? 2 : 3], ['C-02', 1], ['COLLECTION-J1T-1', 2]])
    if (url.searchParams.has('paginationToken')) {
      assert.equal(url.searchParams.get('paginationToken'), 'fixture-next')
      return Response.json({ orders: [mixed, entry('second', [
        ['HUNI-01', 2], ['B.JA-01', 1], ['LAFA-DX-XCAR', 1], ['unassigned', 1],
      ])] })
    }
    salesWindows.push([start, end])
    return Response.json({
      orders: [mixed, { ...entry('next-window', [['C-JIT-01', 4]]), createdTime: end }, entry('outside-haul', [['C-03', 20]], [])],
      pagination: { nextToken: 'fixture-next' },
    })
  }
  if (
    url.origin === 'https://sellingpartnerapi-na.amazon.com' &&
    url.pathname === '/listings/2021-08-01/items/SELLERA'
  ) {
    const recent = url.searchParams.has('lastUpdatedAfter')
    if (recent) {
      assert.ok(url.searchParams.has('lastUpdatedBefore'))
      assert.equal(url.searchParams.get('includedData'), 'summaries,issues')
    }
    return Response.json({
      numberOfResults: 1,
      items: [
        {
          sku: 'WEEKLY-001',
          summaries: [
            {
              marketplaceId: 'ATVPDKIKX0DER',
              asin: 'B000000001',
              itemName: 'Printed Mug',
              mainImage: { link: 'https://m.media-amazon.com/images/I/test.jpg' },
            },
          ],
          relationships: [{ marketplaceId: 'ATVPDKIKX0DER', relationships: [] }],
          ...(recent ? { issues: [{ code: '18146', message: infringementReason, attributeNames: ['item_name'], enforcements: {
            actions: [{ action: 'CATALOG_ITEM_REMOVED' }], exemption: { status: exemption },
          } }] } : {}),
        },
      ],
    })
  }
  if (
    url.origin === 'https://sellingpartnerapi-na.amazon.com' &&
    url.pathname === '/customerFeedback/2024-06-01/items/B000000001/reviews/topics'
  ) {
    return Response.json({
      asin: 'B000000001',
      marketplaceId: 'ATVPDKIKX0DER',
      dateRange: { startDate: '2026-05-01', endDate: '2026-11-01' },
      topics: {
        negativeTopics: [
          {
            topic: 'Print Quality',
            asinMetrics: { numberOfMentions: 12, starRatingImpact: -0.2 },
            reviewSnippets: ['Blurry print'],
          },
        ],
      },
    })
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
  if (url.origin === 'https://openapi.geekbi.com' && url.pathname.endsWith('/goods/detail'))
    return Response.json(
      {
        code: 0,
        data: {
          goods: {
            goodsId: '1',
            goodsName: '量匙更新',
            goodsNameEn: 'Measuring Spoon Set, 2 Pieces',
            minPrice: 4,
            sold: 51000,
            siteId: 48,
          },
          history: [],
        },
      },
      { headers: { 'x-gb-price-points': '10' } },
    )
  if (url.origin === 'https://openapi.geekbi.com' && url.pathname.endsWith('/review/search'))
    return Response.json(
      {
        code: 0,
        data: { total: 1, list: [{ goodsId: '1', score: 1, comment: 'Handle broke after first use.' }] },
      },
      { headers: { 'x-gb-price-points': '10' } },
    )
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
    if (Array.isArray(state))
      return Response.json({
        model: body.model,
        choices: [{ message: { content: '样本1反映把手耐用性问题，不能外推全部买家。' } }],
        usage: { cost: 0.00002 },
      })
    if (Array.isArray(state.observations)) {
      assistantModelCalls++
      if (state.goal === 'runtime-cancel' || state.goal === 'runtime-pause') await delay(250)
      const number = state.observations.length
      const action =
        number === 0
          ? { type: 'tool', name: 'search_inventory', args: { platform: 'temu' } }
          : number === 1
            ? { type: 'tool', name: 'read_product', args: { productId: 'temu:US:1' } }
            : number === 2
              ? { type: 'tool', name: 'read_product', args: { productId: 'temu:US:2' } }
              : {
                  type: 'report',
                  report: {
                    summary:
                      state.scopeVersion > 1 ? '已按补充条件继续原调查。' : '持久调查已完成缓存比较。',
                    recommendations: [
                      {
                        productId: 'temu:US:1',
                        reason: '来源快照记录价格 4 USD、累计销量 50000；规格仍需人工核对。',
                        evidenceIds: [state.observations[1].result.evidence[0].id],
                      },
                    ],
                    excluded: [],
                    missing: ['未在线补查，利润未知'],
                  },
                }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(action) } }],
        usage: { cost: 0.00001 },
      })
    }
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
const assistantBinding = { name: 'fixture-assistant', className: 'AssistantWorkflow' }
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...shared,
        name: 'api',
        scriptPath: '.local/dry-api/index.js',
        bindings: { LOCAL_DEVELOPMENT: '1', CONNECTIONS_KEY: 'cd'.repeat(32) },
        workflows: {
          RUNNER: { ...binding, scriptName: 'jobs' },
          ASSISTANT_RUNNER: { ...assistantBinding, scriptName: 'jobs' },
        },
      },
      {
        ...shared,
        name: 'jobs',
        scriptPath: '.local/dry-jobs/index.js',
        bindings: {
          CONNECTIONS_KEY: 'cd'.repeat(32),
          WECOM_GROUP_WEBHOOKS: JSON.stringify({ trial: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-group-1122' }),
        },
        workflows: { RUNNER: binding, ASSISTANT_RUNNER: assistantBinding },
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
        workflows: {
          RUNNER: { ...binding, scriptName: 'jobs' },
          ASSISTANT_RUNNER: { ...assistantBinding, scriptName: 'jobs' },
        },
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
  await api('/connections/amazon/seller', { sellerId: 'SELLERA' })
  const weekly = await api('/weekly-feedback/run', {})
  let weeklyReport
  for (let attempt = 0; attempt < 100; attempt++) {
    weeklyReport = await api('/weekly-feedback?run=' + weekly.id)
    if (weeklyReport.run.status !== 'running') break
    await delay(150)
  }
  assert.equal(weeklyReport.run.status, 'done', JSON.stringify(weeklyReport))
  assert.deepEqual(weeklyReport.rows[0].skus, ['WEEKLY-001'])
  assert.equal(weeklyReport.rows[0].topics[0].mentions, 12)
  assert.equal(weeklyReport.rows[0].image, 'https://m.media-amazon.com/images/I/test.jpg')
  assert.equal((await api('/weekly-feedback/notification?run=' + weekly.id)).sent, false)
  const strategy = await api('/strategy')
  assert.deepEqual(strategy.connections, { geekbi: true, productData: true, openrouter: true })
  await api('/strategy', {
    baseVersion: strategy.version,
    settings: { ...strategy.settings, focusLimit: 0, dataDailyPoints: 10, aiDailyMicros: 120000 },
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
  const admin = async (path, body) => {
    const response = body === undefined
      ? await secure.fetch(site + '/api' + path, { headers: { Cookie: ownerCookie } })
      : await json(path, body, ownerCookie)
    const data = await response.json()
    assert.ok(response.ok, JSON.stringify(data))
    return data
  }
  const group = await admin('/group-notifications/groups', { name: '验收测试群', webhookKey: 'trial' })
  await db.prepare("INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('wecom-operator','Peter','operator','','')").run()
  await admin('/weekly-feedback/wecom-member', { accountId: 'wecom-operator', userid: 'wecom_peter' })
  await admin(`/group-notifications/groups/${group.id}/members`, { accountId: 'wecom-operator', enabled: true })
  const trial = await admin(`/group-notifications/groups/${group.id}/trial`, {
    service: 'infringement', accountId: 'wecom-operator', sku: 'WEEKLY-001',
  })
  assert.match((await db.prepare('SELECT content FROM notification_deliveries WHERE id=?').bind(trial.id).first()).content, /商品标题：Printed Mug/)
  let delivery
  for (let attempt = 0; attempt < 100; attempt++) {
    const { deliveries } = await admin(`/group-notifications/groups/${group.id}/deliveries`)
    delivery = deliveries.find((row) => row.id === trial.id)
    if (delivery?.phase === 'image' && delivery?.error) break
    await delay(100)
  }
  assert.equal(delivery?.status, 'queued', JSON.stringify({ delivery, calls: calls.slice(-8), wecomMessages }))
  assert.equal(wecomMessages.length, 2)
  assert.deepEqual(wecomMessages[0].text.mentioned_list, ['wecom_peter'])
  assert.match(wecomMessages[0].text.content, /SKU：WEEKLY-001/)
  assert.deepEqual(wecomMessages[1], {
    msgtype: 'image', image: { base64: samplePng.toString('base64'), md5: createHash('md5').update(samplePng).digest('hex') },
  })
  const { RUNNER } = await mf.getBindings('jobs')
  const tick = Date.now()
  async function runScan(time) {
    const id = 'group-notification-tick-' + time
    const instance = await RUNNER.create({ id, params: { runId: id } })
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await instance.status()
      if (result.status === 'complete') return
      assert.notEqual(result.status, 'errored', JSON.stringify(result))
      await delay(100)
    }
    assert.fail('Group notification scan did not complete')
  }
  await runScan(tick)
  assert.deepEqual(wecomMessages.map((message) => message.msgtype), ['text', 'image', 'image'])
  assert.deepEqual(wecomMessages[2], wecomMessages[1])
  assert.equal((await admin(`/group-notifications/groups/${group.id}/deliveries`)).deliveries[0].status, 'sent')
  const infringement = await admin('/group-notifications/infringements')
  assert.equal(infringement.rows[0].asin, 'B000000001')
  assert.equal(infringement.scan.error, null)
  await admin('/weekly-feedback/assign', { run: weekly.id, sku: 'WEEKLY-001', accountId: 'wecom-operator' })
  await admin('/group-notifications/services/infringement', { groupId: group.id })
  await runScan(tick + 30 * 60000)
  assert.equal(wecomMessages.length, 3)
  exemption = 'NOT_EXEMPT'
  await runScan(tick + 45 * 60000)
  assert.equal(wecomMessages.length, 3)
  infringementReason = 'Trademark misuse in the title'
  await runScan(tick + 60 * 60000)
  assert.deepEqual(wecomMessages.map((message) => message.msgtype), ['text', 'image', 'image', 'text', 'image'])
  assert.match(wecomMessages[3].text.content, /涉及运营：Peter/)
  assert.match(wecomMessages[3].text.content, /亚马逊原文：Trademark misuse in the title/)
  assert.match(wecomMessages[3].text.content, /亚马逊位置字段：商品标题（item_name）/)
  assert.equal((await admin('/group-notifications')).groups[0].webhookHint, '1122')
  await admin('/group-notifications/daily-sales/teams', { team: 'c', accountIds: ['wecom-operator'] })
  await db.prepare(`INSERT INTO accounts(id,username,role,salt,password_hash)
    VALUES('test-nick','Nick','operator','',''),('test-jack','Jack','operator','','')`).run()
  await db.prepare(`INSERT INTO weekly_feedback_owner_rules VALUES
    ('SELLERA','ATVPDKIKX0DER','prefix','C-',0,'wecom-operator','wecom-operator'),
    ('SELLERA','ATVPDKIKX0DER','prefix','HUNI',1,'test-nick','wecom-operator'),
    ('SELLERA','ATVPDKIKX0DER','contains_suffix','.JA-',1,'test-jack','wecom-operator')`).run()
  await admin('/group-notifications/daily-sales/teams', { team: 'a', accountIds: ['test-nick'] })
  await admin('/group-notifications/daily-sales/teams', { team: 'b', accountIds: ['test-jack'] })
  await db.prepare("INSERT INTO daily_sales_sku_teams(sku,team) VALUES ('LAFA-DX-XCAR','a') ON CONFLICT DO NOTHING").run()
  assert.equal((await json('/group-notifications/daily-sales/teams', {
    team: 'a', accountIds: ['test-nick', 'test-jack'],
  }, ownerCookie)).status, 409)
  const mainAPI = await mf.getWorker('api')
  const registerSales = await mainAPI.fetch(site + '/api/group-notifications/groups', {
    method: 'POST',
    headers: { Origin: site, 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      name: '销量验收群', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-sales-3344',
      dailySales: true,
    }),
  })
  assert.equal(registerSales.status, 201, await registerSales.clone().text())
  const sales = await registerSales.json()
  assert.equal((await admin('/group-notifications/daily-sales')).target.id, sales.id)
  assert.equal((await admin('/group-notifications/daily-sales')).target.scheduled, 0)
  assert.equal((await json('/group-notifications/services/daily-sales', { groupId: sales.id }, ownerCookie)).status, 409)
  assert.equal((await json('/group-notifications/services/daily-sales', { groupId: group.id }, ownerCookie)).status, 409)
  const salesDate = '2026-11-13'
  async function runSales(mode) {
    const salesTick = Date.parse(mode === 'slot' ? '2026-11-13T15:00:00Z' : '2026-11-14T08:00:00Z')
    const id = mode === 'auto' ? 'daily-sales-auto-' + salesDate
      : mode === 'slot' ? 'daily-sales-slot-' + salesTick
        : 'daily-sales-preview-' + salesDate + '-00000000-0000-4000-8000-000000000002'
    const instance = await RUNNER.create({ id, params: { runId: id, ...(mode === 'preview' ? {} : { salesTick }) } })
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await instance.status()
      if (result.status === 'complete') return
      assert.notEqual(result.status, 'errored', JSON.stringify(result))
      await delay(100)
    }
    assert.fail('Daily sales workflow did not complete')
  }
  await runSales('preview')
  assert.deepEqual(salesMessages, [])
  const salesReport = await admin('/group-notifications/daily-sales')
  assert.equal(salesReport.run.status, 'ready')
  assert.match(salesReport.preview, /^【美国站 Haul U2 销量日报】2026-11-13（美西）\nHaul U2 总计｜11 件\n　└ 其中 JIT｜5 件（45.5%）/)
  assert.match(salesReport.preview, /　　A 组｜3 件（27.3%）｜含 JIT 0 件（组内 0.0%，占总 JIT 0.0%）/)
  assert.match(salesReport.preview, /　　B 组｜1 件（9.1%）｜含 JIT 0 件（组内 0.0%，占总 JIT 0.0%）/)
  assert.match(salesReport.preview, /　　C 组｜4 件（36.4%）｜含 JIT 3 件（组内 75.0%，占总 JIT 60.0%）/)
  assert.match(salesReport.preview, /　　集美｜2 件（18\.2%）｜占总 JIT 40\.0%/)
  assert.match(salesReport.preview, /　　未归类｜1 件（9.1%）/)
  const salesTrial = await admin(`/group-notifications/groups/${sales.id}/trial`, { service: 'daily-sales' })
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await admin('/group-notifications/daily-sales')).trial?.status === 'sent') break
    await delay(100)
  }
  assert.deepEqual(salesMessages.splice(0), [{
    msgtype: 'text', text: { content: '【测试】' + salesReport.preview, mentioned_list: ['@all'] },
  }])
  const trialRow = await db.prepare('SELECT trial FROM notification_deliveries WHERE id=?').bind(salesTrial.id).first()
  assert.equal(trialRow.trial, 1)
  await admin('/group-notifications/services/daily-sales', { groupId: sales.id })
  await db.prepare(`INSERT INTO daily_sales_year_baselines
    (sale_date,hours,source,source_ref,quantity,start_at,end_at,imported_at) VALUES
    ('2025-11-13',24,'workbook','unverified',999,NULL,NULL,'2026-11-13T08:00:00.000Z'),
    ('2025-11-13',24,'amazon-orders','fixture',8,'2025-11-13T08:00:00.000Z','2025-11-14T08:00:00.000Z','2026-11-13T08:00:00.000Z')`).run()
  const cachedReport = {
    seller: 'SELLERA', haul: { units: 10 }, jit: { units: 4 }, jimei: { includedInJit: true },
    window: { start: '2026-11-12T08:00:00.000Z', end: '2026-11-13T08:00:00.000Z' },
  }
  const persistSales = db.prepare(`INSERT INTO daily_sales_runs(id,report_date,status,report_json,updated_at)
    VALUES(?,'2026-11-12','ready',?,'2026-11-13T08:05:00.000Z')`)
  await persistSales.bind('daily-sales-auto-2026-11-12', JSON.stringify(cachedReport)).run()
  await persistSales.bind('daily-sales-slot-' + Date.parse('2026-11-12T15:00:00Z'), JSON.stringify(cachedReport)).run()
  await persistSales.bind('daily-sales-slot-' + Date.parse('2025-11-13T15:00:00Z'), JSON.stringify({
    ...cachedReport, haul: { units: 8 },
    window: { start: '2025-11-13T08:00:00.000Z', end: '2025-11-13T15:00:00.000Z' },
  })).run()
  assert.equal((await json('/group-notifications/services/infringement', { groupId: sales.id }, ownerCookie)).status, 409)
  const beforeAuto = salesWindows.length
  await runSales('auto')
  assert.deepEqual(salesWindows.slice(beforeAuto), [
    ['2026-11-13T08:00:00.000Z', '2026-11-14T08:00:00.000Z'],
  ])
  const cumulative = (await admin('/group-notifications/daily-sales')).preview
  assert.equal(cumulative, salesMessages[0].text.content)
  const backfillId = 'daily-sales-backfill-' + salesDate
  const backfill = await RUNNER.create({ id: backfillId, params: { runId: backfillId } })
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await backfill.status()
    if (result.status === 'complete') break
    assert.notEqual(result.status, 'errored', JSON.stringify(result))
    await delay(100)
  }
  assert.equal((await backfill.status()).status, 'complete')
  await runScan(tick + 90 * 60000)
  const beforeSlot = salesWindows.length
  await runSales('slot')
  assert.equal(salesMessages.length, 3)
  assert.match(cumulative, /^【美国站 Haul U2 时段销量】\n2026-11-13 16:00 至 2026-11-14 16:00（北京时间）\nHaul U2 总计｜11 件（比昨天同期增加 10\.0%，比去年同期增加 37\.5%）/)
  assert.match(cumulative, /其中 JIT｜5 件（45\.5%）（比昨天同期增加 25\.0%）/)
  assert.match(cumulative, /　　集美｜2 件（18\.2%）｜占总 JIT 40\.0%/)
  assert.ok(Buffer.byteLength(cumulative) < 2048)
  assert.deepEqual(salesMessages[0].text.mentioned_list, ['@all'])
  assert.deepEqual(salesMessages[1], {
    msgtype: 'text', text: { content: salesReport.preview },
  })
  assert.deepEqual(salesWindows.slice(beforeSlot), [
    ['2026-11-13T08:00:00.000Z', '2026-11-13T15:00:00.000Z'],
  ])
  assert.match(salesMessages[2].text.content, /^【美国站 Haul U2 时段销量】\n2026-11-13 16:00 至 2026-11-13 23:00（北京时间）\nHaul U2 总计｜11 件（昨天同期暂无数据，比去年同期增加 37\.5%）/)
  assert.equal(await db.prepare("SELECT quantity FROM daily_sales_year_baselines WHERE sale_date='2025-11-13' AND hours=7").first(), null)
  assert.equal(calls.filter(path => path === '/sales/v1/orderMetrics').length, 0)
  assert.match(salesMessages[2].text.content, /其中 JIT｜5 件（45\.5%）（昨天同期暂无数据）/)
  assert.doesNotMatch(salesMessages[2].text.content, /销量日报】/)
  assert.deepEqual(salesMessages[2].text.mentioned_list, ['@all'])
  const afterSlot = await admin('/group-notifications/daily-sales')
  assert.equal(afterSlot.delivery.status, 'sent')
  assert.equal(afterSlot.preview, salesReport.preview)
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
  assert.equal((await memberGet('/group-notifications')).status, 403)
  assert.equal((await memberGet('/group-notifications/daily-sales')).status, 403)
  assert.equal((await (await memberGet('/auth/me')).json()).position, 'operations_lead')
  const memberStrategy = await (await memberGet('/strategy')).json()
  assert.equal('models' in memberStrategy || 'connections' in memberStrategy, false)
  assert.deepEqual(memberStrategy.capabilities, { discovery: false, research: false })
  assert.equal((await json('/strategy', {}, readerCookie)).status, 403)
  assert.equal((await json('/me/preferences', { view: 'grid', pageSize: 50 }, readerCookie)).status, 200)
  assert.equal((await json('/jobs', {}, readerCookie)).status, 403)
  const conversationId = crypto.randomUUID(),
    originTurn = crypto.randomUUID()
  const investigationInput = { id: originTurn, question: 'runtime-compare', page: '商品库' }
  const createInvestigation = () =>
    json(
      '/assistant/conversations/' + conversationId + '/investigations',
      investigationInput,
      readerCookie,
    )
  const submitted = await createInvestigation()
  assert.equal(submitted.status, 200, await submitted.clone().text())
  const investigation = await submitted.json()
  assert.equal((await (await createInvestigation()).json()).runId, investigation.runId)
  async function assistantUntil(id, states) {
    for (let i = 0; i < 200; i++) {
      const row = await db.prepare('SELECT * FROM assistant_runs WHERE id=?').bind(id).first()
      if (states.includes(row.status)) return row
      await delay(100)
    }
    throw new Error('Assistant workflow did not reach ' + states.join('/') + ': ' + id)
  }
  // No browser remains attached after submission: D1/R2 and Workflow own progress.
  const investigated = await assistantUntil(investigation.runId, ['succeeded', 'partial', 'failed'])
  assert.equal(investigated.status, 'succeeded', JSON.stringify(investigated))
  assert.equal(investigated.model_steps, 4)
  assert.equal(investigated.tool_steps, 3)
  assert.equal(assistantModelCalls, 4)
  const persistedReport = JSON.parse(investigated.report_json)
  assert.equal(persistedReport.recommendations[0].productId, 'temu:US:1')
  assert.equal(persistedReport.usage.aiMicros, 40)
  const assistantSteps = await db
    .prepare('SELECT * FROM assistant_steps WHERE run_id=? ORDER BY seq')
    .bind(investigation.runId)
    .all()
  assert.equal(assistantSteps.results.length, 7)
  for (const modelStep of assistantSteps.results.filter((s) => s.kind === 'model'))
    assert.ok(await bucket.head(modelStep.evidence_ref))
  const transcript = await (await memberGet('/assistant/conversations/' + conversationId)).json()
  assert.match(transcript.items[0].answer, /temu:US:1/)
  assert.equal(transcript.items[0].runStatus, 'succeeded')
  assert.equal((await (await createInvestigation()).json()).runId, investigation.runId)
  assert.equal(assistantModelCalls, 4)
  async function controlledInvestigation(goal) {
    const response = await json(
      '/assistant/conversations/' + crypto.randomUUID() + '/investigations',
      { id: crypto.randomUUID(), question: goal, page: '商品库' },
      readerCookie,
    )
    assert.equal(response.status, 200, await response.clone().text())
    const createdRun = await response.json()
    for (let i = 0; i < 100; i++) {
      if (
        await db
          .prepare("SELECT 1 FROM assistant_steps WHERE run_id=? AND status='sending'")
          .bind(createdRun.runId)
          .first()
      )
        return createdRun
      await delay(20)
    }
    throw new Error('Expected in-flight assistant request')
  }
  const pausedRun = await controlledInvestigation('runtime-pause')
  assert.equal(
    (
      await (
        await json('/assistant/investigations/' + pausedRun.runId + '/pause', {}, readerCookie)
      ).json()
    ).status,
    'pausing',
  )
  await assistantUntil(pausedRun.runId, ['paused'])
  const resumed = await json(
    '/assistant/investigations/' + pausedRun.runId + '/resume',
    {},
    readerCookie,
  )
  assert.equal(resumed.status, 200, await resumed.clone().text())
  const resumedRun = await assistantUntil(pausedRun.runId, ['succeeded', 'partial', 'failed'])
  assert.equal(resumedRun.status, 'succeeded', JSON.stringify(resumedRun))
  assert.equal(resumedRun.attempt, 2)
  assert.equal(resumedRun.model_steps, 4)
  const cancelledRun = await controlledInvestigation('runtime-cancel')
  assert.equal(
    (
      await (
        await json('/assistant/investigations/' + cancelledRun.runId + '/cancel', {}, readerCookie)
      ).json()
    ).status,
    'cancelling',
  )
  const cancelled = await assistantUntil(cancelledRun.runId, ['cancelled'])
  assert.equal(cancelled.model_steps, 1)
  assert.equal(cancelled.tool_steps, 0)
  const cancelledUsage = await db
    .prepare('SELECT state,actual FROM usage_reservations WHERE assistant_run_id=?')
    .bind(cancelledRun.runId)
    .all()
  assert.deepEqual(cancelledUsage.results, [{ state: 'confirmed', actual: 10 }])
  assert.ok(JSON.parse(cancelled.report_json).missing.length)
  const followupId = crypto.randomUUID()
  const steered = await json(
    '/assistant/investigations/' + investigation.runId + '/messages',
    { id: followupId, message: '继续刚才，优先核对尺寸', intent: 'continue' },
    readerCookie,
  )
  assert.equal(steered.status, 200, await steered.clone().text())
  const continued = await assistantUntil(investigation.runId, ['succeeded', 'partial', 'failed'])
  assert.equal(continued.scope_version, 2, JSON.stringify(continued))
  assert.match(JSON.parse(continued.report_json).summary, /补充条件/)
  const versions = await db
    .prepare('SELECT * FROM assistant_report_versions WHERE run_id=? ORDER BY revision')
    .bind(investigation.runId)
    .all()
  assert.equal(versions.results.length, 2)
  assert.match(JSON.parse(versions.results[0].report_json).summary, /缓存比较/)
  assert.equal(
    (
      await json(
        '/assistant/investigations/' + investigation.runId + '/messages',
        { id: followupId, message: '继续刚才，优先核对尺寸', intent: 'continue' },
        readerCookie,
      )
    ).status,
    200,
  )
  const freshStrategy = await (
    await secure.fetch(site + '/api/strategy', { headers: { Cookie: ownerCookie } })
  ).json()
  const adjusted = await json(
    '/strategy',
    {
      baseVersion: freshStrategy.version,
      settings: { ...freshStrategy.settings, dataDailyPoints: 100, aiDailyMicros: 1000000 },
    },
    ownerCookie,
  )
  assert.equal(adjusted.status, 200, await adjusted.clone().text())
  const onlineResponse = await json(
    '/assistant/conversations/' + crypto.randomUUID() + '/investigations',
    { id: crypto.randomUUID(), question: 'runtime-online', page: '商品库' },
    ownerCookie,
  )
  assert.equal(onlineResponse.status, 200, await onlineResponse.clone().text())
  const online = await onlineResponse.json()
  await assistantUntil(online.runId, ['succeeded'])
  const proposalResponse = await json(
    '/assistant/investigations/' + online.runId + '/proposals',
    {
      maxDataPoints: 20,
      maxAiMicros: 360000,
      actions: [
        {
          operation: 'product_refresh',
          productId: 'temu:US:1',
          calls: 1,
          maxDataPoints: 10,
          maxAiMicros: 0,
        },
        {
          operation: 'reviews_refresh',
          productId: 'temu:US:1',
          calls: 2,
          maxDataPoints: 10,
          maxAiMicros: 30000,
        },
      ],
    },
    ownerCookie,
  )
  assert.equal(proposalResponse.status, 200, await proposalResponse.clone().text())
  const proposal = await proposalResponse.json(),
    confirmPath = '/assistant/investigations/' + online.runId + '/proposals/' + proposal.id + '/confirm'
  const confirmations = await Promise.all([
    json(confirmPath, {}, ownerCookie),
    json(confirmPath, {}, ownerCookie),
  ])
  for (const response of confirmations) assert.equal(response.status, 200, await response.clone().text())
  const onlineDone = await assistantUntil(online.runId, ['succeeded', 'partial', 'failed'])
  assert.equal(onlineDone.status, 'succeeded', JSON.stringify(onlineDone))
  const links = await db
    .prepare('SELECT state,job_id FROM assistant_job_links WHERE run_id=?')
    .bind(online.runId)
    .all()
  assert.equal(links.results.length, 2)
  assert.ok(links.results.every((l) => l.state === 'settled' && l.job_id))
  const onlineUsage = await db
    .prepare(
      'SELECT unit,SUM(actual) n FROM usage_reservations WHERE assistant_run_id=? GROUP BY unit ORDER BY unit',
    )
    .bind(online.runId)
    .all()
  assert.deepEqual(onlineUsage.results, [
    { unit: 'micros', n: 70 },
    { unit: 'points', n: 20 },
  ])
  assert.equal(calls.filter((p) => p.endsWith('/goods/detail')).length, 1)
  assert.equal(calls.filter((p) => p.endsWith('/review/search')).length, 1)
  assert.equal(
    (await json('/accounts/' + viewer.id, { active: false }, ownerCookie, 'PATCH')).status,
    200,
  )
  assert.equal(
    (await secure.fetch(site + '/api/session', { headers: { Cookie: readerCookie } })).status,
    401,
  )
  console.log(
    'Workerd fixture passed: research, cached and authorized online investigation, bounded product/reviews refresh, total ledger, original-turn followups and report history, duplicate confirmations, pause/resume and cancellation.',
  )
} finally {
  await mf.dispose()
}
