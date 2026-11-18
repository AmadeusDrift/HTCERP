import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bindings } from '../../apps/api/src/bindings'
import app from '../../apps/api/src/index'
import { providerCredentials } from '../../packages/connections/credentials'
import { positions } from '../../packages/contracts/accounts'

const local = 'http://127.0.0.1'
const site = 'https://work.example'
const password = ' only for testing '
let db: DatabaseSync
let DB: D1Database
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync('migrations/' + f, 'utf8'))
  }
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = db.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: () => statement.get(...values) ?? null,
      all: () => ({ results: statement.all(...values) }),
      run: () => ({ meta: statement.run(...values) }),
    }
  }
  DB = {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) => statements.map((s) => s.all()),
  } as unknown as D1Database
})
afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
})
function req(path: string, init?: RequestInit, origin = site, bindings: Partial<Bindings> = {}) {
  return app.request(origin + '/api' + path, init, { DB, LOCAL_DEVELOPMENT: '1', ...bindings })
}
const post = (path: string, data: unknown, cookie = '', method = 'POST') =>
  req(path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(data),
  })
const setup = (username = 'Owner') =>
  req(
    '/auth/setup',
    {
      method: 'POST',
      headers: { Origin: local, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    },
    local,
  )
const login = (username: string, pass = password) => post('/auth/login', { username, password: pass })
const cookieOf = (response: Response) => {
  expect(response.status).toBe(200)
  const cookie = response.headers.get('Set-Cookie')!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('Secure')
  expect(cookie).toMatch(/SameSite=(Strict|Lax)/)
  return cookie.split(';')[0]
}
const get = (path: string, cookie: string) => req(path, { headers: { Cookie: cookie } })

it('keeps simulated store sales behind the admin session and out of every live report', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  expect((await get('/store-sales?view=preview', '')).status).toBe(401)
  expect(await (await get('/store-sales', admin)).json()).toMatchObject({ source: 'pending', days: [] })
  const preview = await get('/store-sales?view=preview', admin)
  expect(preview.status).toBe(200)
  expect(preview.headers.get('Cache-Control')).toBe('no-store')
  const data = await preview.json() as { source: string; days: unknown[] }
  expect(data.source).toBe('simulation')
  expect(data.days).toHaveLength(7)
  expect(data.days[0]).toMatchObject({ team: {
    units: 22, cents: 9467, jit: { units: 13, cents: 4247 }, standard: { units: 6, cents: 4840 },
    review: { lines: 2, units: 3, cents: 380, missingAmount: 1 }, newListings: 2, unknownListings: 1,
  } })
  for (const role of ['viewer', 'operator']) {
    expect((await post('/accounts', { username: role, password, role }, admin)).status).toBe(201)
    const cookie = cookieOf(await login(role))
    expect(await (await get('/store-sales', cookie)).json()).toMatchObject({ source: 'pending', days: [] })
    const response = await get('/store-sales?view=preview&role=admin', cookie)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toMatch(/DEMO-|模拟运营/)
  }
})

it('saves only complete admin credentials, exposes status only, and detects tampering without falling back', async () => {
  const vault = { DB, CONNECTIONS_KEY: 'ab'.repeat(32), OPENROUTER_API_KEY: 'fixture-worker-binding' }
  const path = '/connections/openrouter/credentials'
  const credentials = { OPENROUTER_API_KEY: 'fixture-managed-credential' }
  const save = (cookie: string, body: unknown, bindings: Partial<Bindings> = vault) =>
    req(
      path,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      site,
      bindings,
    )
  await setup()
  const admin = cookieOf(await login('owner'))
  expect((await save('', { credentials })).status).toBe(401)
  for (const role of ['viewer', 'operator']) {
    expect((await post('/accounts', { username: role, password, role }, admin)).status).toBe(201)
    const cookie = cookieOf(await login(role))
    expect((await save(cookie, { credentials })).status).toBe(403)
    const connections = await req('/connections', { headers: { Cookie: cookie } }, site, vault)
    expect(connections.status).toBe(403)
    expect(await connections.text()).not.toMatch(/geekbi|极鲸云|openrouter|configured/i)
    const strategy = await (await req('/strategy', { headers: { Cookie: cookie } }, site, vault)).json()
    expect(strategy).toMatchObject({
      capabilities: { discovery: false, research: true },
      settings: { scheduleEnabled: false, dataDailyPoints: 0, aiDailyMicros: 0 },
    })
    expect(JSON.stringify(strategy)).not.toMatch(/geekbi|极鲸云|openrouter|connections|models/i)
    expect((await post('/strategy', { settings: { scheduleTime: '10:00' } }, cookie)).status).toBe(403)
    expect((await post('/connections/amazon/test', {}, cookie)).status).toBe(403)
  }
  for (const body of [
    {},
    { credentials: {} },
    { credentials: { ...credentials, extra: 'fixture-extra' } },
    { credentials, extra: true },
    { credentials: { OPENROUTER_API_KEY: 'fixture\nheader' } },
  ])
    expect((await save(admin, body)).status).toBe(400)
  expect((await save(admin, { credentials }, {})).status).toBe(503)
  expect(await (await get('/connections', admin)).json()).toMatchObject({ credentialEditing: false })
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  expect(await (await save(admin, { credentials })).json()).toEqual({ ok: true })
  const row = () => db.prepare("SELECT * FROM connection_credentials WHERE provider='openrouter'").get()!
  const first = row()
  expect(JSON.stringify(first)).not.toContain('fixture')
  expect(row().nonce).toHaveLength(16)
  const status = await req('/connections', { headers: { Cookie: admin } }, site, vault)
  expect(await status.json()).toMatchObject({
    credentialEditing: true,
    productData: { configured: false },
    openrouter: { configured: true },
    geekbi: { configured: false, slots: [1, 2, 3, 4, 5].map((slot) => ({ slot, configured: false })) },
    amazon: { configured: false, status: 'unconfigured', lastTestedAt: null },
    haul: { configured: false },
  })
  expect(await providerCredentials(vault, 'openrouter')).toMatchObject({ credentials })
  expect(await (await save(admin, { credentials })).json()).toEqual({ ok: true })
  expect(row().nonce).not.toBe(first.nonce)
  expect(row().ciphertext).not.toBe(first.ciphertext)
  await expect(
    providerCredentials({ ...vault, CONNECTIONS_KEY: '01'.repeat(32) }, 'openrouter'),
  ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' })
  db.exec(
    "INSERT INTO connection_credentials SELECT 'geekbi',version,nonce,ciphertext FROM connection_credentials WHERE provider='openrouter'",
  )
  await expect(providerCredentials(vault, 'geekbi')).rejects.toMatchObject({
    code: 'CREDENTIAL_STORE_UNAVAILABLE',
  })
  db.exec("UPDATE connection_credentials SET ciphertext='AAAA' WHERE provider='openrouter'")
  await expect(providerCredentials(vault, 'openrouter')).rejects.toMatchObject({
    code: 'CREDENTIAL_STORE_UNAVAILABLE',
  })
  expect(JSON.stringify(db.prepare('SELECT * FROM api_audit').all())).not.toContain(
    credentials.OPENROUTER_API_KEY,
  )
  expect(send).not.toHaveBeenCalled()
})

it('binds numbered GeekBI slots independently and returns only configuration flags', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  const bindings = {
    DB,
    CONNECTIONS_KEY: '01'.repeat(32),
    GB_APP_KEY_3: 'binding-three',
    GB_APP_SECRET_3: 'binding-secret',
    GEEKBI_CONFIGURED: 'true',
    GB_APP_KEY_4: 'incomplete-four',
  }
  const pair = { GB_APP_KEY: 'key-five', GB_APP_SECRET: 'secret-five' }
  const save = (slot: unknown) =>
    req(
      '/connections/geekbi/credentials',
      {
        method: 'POST',
        headers: { Cookie: admin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, credentials: pair }),
      },
      site,
      bindings,
    )
  for (const slot of [0, 6, '2', null, 1.5]) expect((await save(slot)).status).toBe(400)
  expect((await save(5)).status).toBe(200)
  const response = await req('/connections', { headers: { Cookie: admin } }, site, bindings)
  const result = (await response.json()) as { geekbi: unknown }
  expect(result.geekbi).toMatchObject({
    configured: true,
    slots: [1, 2, 3, 4, 5].map((slot) => ({
      slot,
      configured: slot === 3 || slot === 5,
      binding: slot === 3 || slot === 5 ? 'bound' : slot === 4 ? 'incomplete' : 'empty',
      testStatus: null,
      confirmedPoints: 0,
      pendingPoints: 0,
    })),
  })
  expect(JSON.stringify(result)).not.toMatch(/key-five|binding-secret|secret-five/)
  expect((await providerCredentials(bindings, 'geekbi', 5)).credentials).toEqual(pair)
  db.exec(
    "INSERT INTO connection_credentials SELECT 'geekbi-4',version,nonce,ciphertext FROM connection_credentials WHERE provider='geekbi-5'",
  )
  await expect(providerCredentials(bindings, 'geekbi', 4)).rejects.toMatchObject({
    code: 'CREDENTIAL_STORE_UNAVAILABLE',
  })
})

it('shows historical job diagnostics without supplier payloads while preserving user-authored goals', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  await post('/accounts', { username: 'reader', password, role: 'viewer' }, admin)
  const reader = cookieOf(await login('reader'))
  const diagnostic = '极鲸云待配置，检查 GB_APP_KEY 或 https://openapi.geekbi.com/private/trace'
  const goal = '人工输入：比较 geekbi 同名商标'
  const business = {
    variants: [{ skuId: 'test', specs: [{ key: '材质', value: '实木' }] }],
    amazon: [{ asin: 'B000000001', price: 10, comparisonNote: '人工备注：geekbi' }],
    plannedMaxAiMicros: 33000,
    tiers: [{ lower: 30000, upper: null, count: 2 }],
    report: { customResearchSection: [{ finding: '规格相符', confidence: 0.8 }] },
  }
  const job = (await (
    await post('/jobs', { kind: 'research', inputs: { goal, mode: 'cache' } }, admin)
  ).json()) as { id: string }
  db.prepare('UPDATE job_runs SET summary=? WHERE id=?').run(diagnostic, job.id)
  db.prepare(
    "UPDATE job_steps SET title=?,summary=?,result_json=?,evidence_ref=? WHERE run_id=? AND step_key='plan'",
  ).run(
    diagnostic,
    diagnostic,
    JSON.stringify({
      ...business,
      model: 'fixture/private-routing',
      goal,
      reasons: [diagnostic],
      target: { id: 'temu:US:1', title: 'lamp', evidence_ref: 'probe-output/fixture', source: 'geekbi' },
      rawResponse: { trace: 'fixture-private-body' },
    }),
    'https://openapi.geekbi.com/private/raw',
    job.id,
  )
  expect((await get('/jobs/'+job.id,reader)).status).toBe(404)
  expect(await (await get('/jobs',reader)).json()).toMatchObject({items:[]})
  for (const cookie of [admin]) {
    const entry = (await (await get('/jobs/' + job.id, cookie)).json()) as {
      title: string
      inputs: { goal: string }
      summary: string
      steps: { title: string; summary: string; result: Record<string, unknown> }[]
    }
    expect(entry.title).toBe(goal)
    expect(entry.inputs.goal).toBe(goal)
    expect(entry.steps[0].result).toEqual({
      ...business,
      ...(cookie === admin ? { model: 'fixture/private-routing' } : {}),
      goal,
      reasons: [entry.summary],
      target: { id: 'temu:US:1', title: 'lamp' },
    })
    expect(entry.steps[0]).not.toHaveProperty('evidenceRef')
    expect([entry.summary, entry.steps[0].title, entry.steps[0].summary].join('')).not.toMatch(
      /极鲸云|geekbi|GB_APP|private/i,
    )
    const list = (await (await get('/jobs', cookie)).json()) as { items: { summary: string }[] }
    expect(list.items[0].summary).toBe(entry.summary)
  }
  expect(db.prepare('SELECT summary FROM job_runs WHERE id=?').get(job.id)?.summary).toBe(diagnostic)
})

it('reauthorizes Amazon after rotation and discards a test that finished with superseded credentials', async () => {
  const bindings = {
    CONNECTIONS_KEY: 'cd'.repeat(32),
    SP_CLIENT_ID: 'legacy-id',
    SP_CLIENT_SECRET: 'legacy-secret',
    SP_REFRESH_TOKEN: 'legacy-refresh',
  }
  const credentials = {
    SP_CLIENT_ID: 'replacement-id',
    SP_CLIENT_SECRET: 'replacement-secret',
    SP_REFRESH_TOKEN: 'replacement-refresh',
  }
  await setup()
  const admin = cookieOf(await login('owner'))
  const request = (path: string, data?: unknown) =>
    req(
      '/connections' + path,
      {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Cookie: admin, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      site,
      bindings,
    )
  let rotate = false
  const ids: (string | null)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
      if (String(input).includes('auth/o2/token')) {
        ids.push((init.body as URLSearchParams).get('client_id'))
        return Response.json({ access_token: 'fixture-amazon-access-' + ids.at(-1) })
      }
      expect(new Headers(init.headers).get('x-amz-access-token')).toBe(
        'fixture-amazon-access-' + ids.at(-1),
      )
      if (rotate) {
        expect(await (await request('/amazon/credentials', { credentials })).json()).toEqual({
          ok: true,
        })
        rotate = false
      }
      return Response.json({ items: [] })
    }),
  )
  expect((await request('/amazon/test', {})).status).toBe(200)
  expect(await (await request('')).json()).toMatchObject({ amazon: { status: 'catalog_verified' } })
  rotate = true
  expect((await request('/amazon/test', {})).status).toBe(409)
  expect(await (await request('')).json()).toMatchObject({
    amazon: { status: 'untested', lastTestedAt: null },
  })
  expect((await request('/amazon/test', {})).status).toBe(200)
  expect(ids).toEqual(['legacy-id', 'legacy-id', 'replacement-id'])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: credentials.SP_REFRESH_TOKEN }, { status: 401 })),
  )
  const rejected = await request('/amazon/test', {})
  expect(rejected.status).toBe(403)
  expect(await rejected.text()).not.toContain(credentials.SP_REFRESH_TOKEN)
})

it('permits a single owner setup and requires both verified owner identity and same-origin forms', async () => {
  const headers = { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' }
  for (const path of ['/auth/setup', '/session', '/auth/me', '/accounts', '/products']) {
    expect((await req(path, { headers })).status).toBe(401)
  }
  const shortFirst = await req('/accounts', {
    method: 'POST',
    headers: { Origin: local, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', role: 'admin', password: 'pass1234' }),
  }, local)
  expect(shortFirst.status).toBe(400)
  const form = await req('/auth/setup', undefined, local)
  expect(form.headers.get('Content-Type')).toContain('text/html')
  expect(await form.text()).toContain('type="password"')
  for (const origin of ['', 'https://evil.example']) {
    expect(
      (
        await req(
          '/auth/setup',
          {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'owner', password }),
          },
          local,
        )
      ).status,
    ).toBe(403)
  }
  const results = await Promise.all([setup(), setup('second')])
  expect(results.map((r) => r.status).sort()).toEqual([303, 409])
  expect(results.find((r) => r.status === 303)?.headers.get('Location')).toBe('/login')
  expect((await req('/session', undefined, local)).status).toBe(401)
})

it('signs in, expires sessions, and revokes the exact session on logout', async () => {
  expect((await setup()).status).toBe(303)
  expect((await login('owner', password.trim())).status).toBe(401)
  const response = await login(' OWNER ')
  expect(await response.clone().json()).toMatchObject({ username: 'owner', role: 'admin', local: false })
  const first = cookieOf(response)
  const second = cookieOf(await login('owner'))
  expect(first).not.toBe(second)
  expect((await get('/auth/me', first)).status).toBe(200)
  expect((await post('/auth/logout', {}, first)).status).toBe(200)
  expect((await get('/session', first)).status).toBe(401)
  expect((await get('/session', second)).status).toBe(200)
  db.exec('UPDATE account_sessions SET expires_at=0')
  expect((await get('/session', second)).status).toBe(401)
})

it('restricts account administration and invalidates prior sessions on reset or disable', async () => {
  expect((await setup()).status).toBe(303)
  const admin = cookieOf(await login('owner'))
  const account = { username: 'Reader', password: 'pass1234', role: 'viewer' }
  expect((await post('/accounts', { ...account, password: 'pass123' }, admin)).status).toBe(400)
  const created = await post('/accounts', account, admin)
  expect(created.status).toBe(201)
  const row = (await created.json()) as { id: string }
  expect(row).toEqual({
    id: expect.any(String),
    username: 'reader',
    active: true,
    role: 'viewer',
    position: null,
  })
  expect((await post('/accounts', { ...account, username: 'READER' }, admin)).status).toBe(409)
  const target = '/accounts/' + row.id
  const viewer = cookieOf(await login('reader', account.password))
  expect((await get('/accounts', viewer)).status).toBe(403)
  expect((await post(target, { role: 'admin' }, viewer, 'PATCH')).status).toBe(403)
  expect((await get('/accounts', admin)).status).toBe(200)
  expect(
    (
      await req(target, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: admin, Origin: 'https://evil.example' },
        body: JSON.stringify({ role: 'admin' }),
      })
    ).status,
  ).toBe(403)
  expect(
    (await post(target, { role: 'operator', password: 'changed only for test' }, admin, 'PATCH')).status,
  ).toBe(200)
  expect((await get('/auth/me', viewer)).status).toBe(401)
  expect((await login('reader', account.password)).status).toBe(401)
  const operator = cookieOf(await login('reader', 'changed only for test'))
  expect((await post(target, { active: false }, admin, 'PATCH')).status).toBe(200)
  expect((await login('reader', 'changed only for test')).status).toBe(401)
  expect((await post(target, { active: true }, admin, 'PATCH')).status).toBe(200)
  expect((await get('/session', operator)).status).toBe(401)
})

it('uses the default password for new operators and accepts eight-character member resets', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  const created = await post('/accounts', { username: 'operator1', role: 'operator' }, admin)
  expect(created.status).toBe(201)
  const account = await created.json() as { id: string }
  const initial = await login('operator1', '12345678')
  expect(initial.status).toBe(200)
  const path = '/accounts/' + account.id
  expect((await post(path, { password: '1234567' }, admin, 'PATCH')).status).toBe(400)
  expect((await post(path, { role: 'admin', password: '87654321' }, admin, 'PATCH')).status).toBe(400)
  expect((await post(path, { password: '87654321' }, admin, 'PATCH')).status).toBe(200)
  expect((await login('operator1', '87654321')).status).toBe(200)
  expect((await login('operator1', '12345678')).status).toBe(401)
  expect((await post('/accounts', { username: 'reader1', role: 'viewer' }, admin)).status).toBe(400)
})

it('migrates existing roles and sessions without assigning positions', () => {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec(readFileSync('migrations/0008_accounts.sql', 'utf8'))
    legacy.exec(
      "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('A','staff','operator','salt','hash')",
    )
    legacy.exec("INSERT INTO account_sessions VALUES('fixture','A',1,123456789)")
    legacy.exec(readFileSync('migrations/0010_account_positions.sql', 'utf8'))
    expect(legacy.prepare('SELECT role,position,active,auth_version FROM accounts').get()).toEqual({
      role: 'operator',
      position: null,
      active: 1,
      auth_version: 1,
    })
    expect(legacy.prepare('SELECT account_id FROM account_sessions').get()?.account_id).toBe('A')
    expect(() => legacy.exec("UPDATE accounts SET position='admin'")).toThrow()
  } finally {
    legacy.close()
  }
})

it('keeps all positions independent of permissions across account and session APIs', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  expect(await (await get('/session', admin)).json()).toMatchObject({ role: 'admin', position: null })
  const invalid = await post('/accounts', { username: 'employee', password, position: 'admin' }, admin)
  expect(invalid.status).toBe(400)
  const response = await post(
    '/accounts',
    { username: 'employee', password, position: 'product_lead' },
    admin,
  )
  expect(response.status).toBe(201)
  const employee = (await response.json()) as { id: string }
  expect(employee).toMatchObject({ role: 'viewer', position: 'product_lead' })
  const loginResponse = await login('employee')
  expect(await loginResponse.clone().json()).toMatchObject({ role: 'viewer', position: 'product_lead' })
  const cookie = cookieOf(loginResponse)
  const path = '/accounts/' + employee.id
  for (const position of [...positions, null]) {
    const patch = await post(path, { position }, admin, 'PATCH')
    expect(patch.status).toBe(200)
    expect(await patch.json()).toMatchObject({ role: 'viewer', position })
    expect(await (await get('/accounts', admin)).json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: employee.id, role: 'viewer', position }),
      ]),
    })
    for (const read of ['/session', '/auth/me'])
      expect(await (await get(read, cookie)).json()).toMatchObject({ role: 'viewer', position })
    expect(await (await post('/rpc/session', { json: null }, cookie)).json()).toMatchObject({
      json: { role: 'viewer', position },
    })
    expect((await get('/connections', cookie)).status).toBe(403)
    expect(
      (await post(path, { role: 'admin', position: 'operations_lead' }, cookie, 'PATCH')).status,
    ).toBe(403)
    expect(
      (await post('/jobs', { kind: 'research', inputs: { mode: 'cache', goal: '查阅' } }, cookie))
        .status,
    ).toBe(403)
  }
  await post(path, { position: 'operations_assistant' }, admin, 'PATCH')
  expect(await (await post(path, { role: 'operator' }, admin, 'PATCH')).json()).toMatchObject({
    role: 'operator',
    position: 'operations_assistant',
  })
  expect((await post(path, { position: 'other' }, admin, 'PATCH')).status).toBe(400)
  expect(
    (await post('/jobs', { kind: 'research', inputs: { mode: 'cache', goal: '业务操作' } }, cookie))
      .status,
  ).toBe(201)
  expect((await get('/connections', cookie)).status).toBe(403)
  expect((await post('/strategy', {}, cookie)).status).toBe(403)
})

it('keeps an active administrator when competing requests demote or disable admins', async () => {
  expect((await setup()).status).toBe(303)
  const admin = cookieOf(await login('owner'))
  const owner = (await (await get('/session', admin)).json()) as { id: string }
  const other = (await (
    await post('/accounts', { username: 'second', password, role: 'admin' }, admin)
  ).json()) as { id: string }
  const results = await Promise.all([
    post('/accounts/' + owner.id, { role: 'viewer' }, admin, 'PATCH'),
    post('/accounts/' + other.id, { active: false }, admin, 'PATCH'),
  ])
  expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1)
  expect(results.some((r) => [403, 409].includes(r.status))).toBe(true)
})

it('allows only the signed-in member’s personal writes through the normal API middleware', async () => {
  await setup()
  const admin = cookieOf(await login('owner'))
  await post('/accounts', { username: 'member', password }, admin)
  const viewer = cookieOf(await login('member'))
  const preferences = { view: 'grid', pageSize: 50 }
  expect((await post('/me/preferences', preferences)).status).toBe(401)
  expect((await post('/me/preferences', preferences, viewer)).status).toBe(200)
  expect(await (await get('/me/preferences', viewer)).json()).toMatchObject(preferences)
  const created = await post('/me/presets', { name: '本人的筛选', filters: { market: 'US' } }, viewer)
  expect(created.status).toBe(201)
  const preset = (await created.json()) as { id: string }
  const path = '/me/presets/' + preset.id
  expect((await post(path + '/delete', {}, admin)).status).toBe(404)
  expect((await post(path + '/rename', { name: '新名称' }, viewer)).status).toBe(200)
  expect((await post(path + '/delete', {}, viewer)).status).toBe(200)
  expect((await post('/strategy', {}, viewer)).status).toBe(403)
  expect((await get('/accounts', viewer)).status).toBe(403)
})

it('limits unknown username guesses without relying on isolate memory or caller-provided forwarding headers', async () => {
  for (let i = 0; i < 10; i++) {
    expect((await login(i % 2 ? 'Nobody' : 'nobody')).status).toBe(401)
  }
  expect((await login('nobody')).status).toBe(429)
  expect((await login('someone.else')).status).toBe(401)
  expect(
    (await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }))
      .status,
  ).toBe(415)
})
