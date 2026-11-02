import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import app from '../../apps/api/src'
import type { Bindings } from '../../apps/api/src/bindings'
import * as assistantModel from '../../packages/assistant/model'
import { businessClock, usage } from '../../packages/operations/model'

const key = 'test-chat-secret',
  owner = 'a'.repeat(64),
  other = 'b'.repeat(64)
const conv = crypto.randomUUID(),
  path = '/conversations/' + conv
const picture =
  'data:image/jpeg;base64,' +
  Buffer.from([
    255, 216, 255, 225, 0, 6, 65, 66, 67, 68, 255, 192, 0, 11, 8, 0, 100, 0, 110, 1, 1, 17, 0, 255, 218,
    0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217,
  ]).toString('base64')
let db: DatabaseSync, DB: D1Database
const relay = vi.fn<(request: Request) => Promise<Response>>()
const answer = () =>
  Response.json({ choices: [{ message: { content: '模型原文 ' + key } }], usage: { cost: 0.00001 } })
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const f of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync('migrations/' + f, 'utf8'))
  for (const [id, token] of [
    ['alice', owner],
    ['bob', other],
  ]) {
    db.prepare(
      "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES(?,?,'viewer','','')",
    ).run(id, id)
    db.prepare('INSERT INTO account_sessions VALUES(?,?,1,?)').run(
      createHash('sha256').update(token).digest('hex'),
      id,
      Math.floor(Date.now() / 1000) + 600,
    )
  }
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = db.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: (field?: string) => {
        const row = s.get(...values)
        return (field ? row?.[field] : row) ?? null
      },
      all: () => ({ results: s.all(...values) }),
      run: () => ({ meta: s.run(...values) }),
      execute: () => ({
        results: s.all(...values),
        meta: { changes: Number(db.prepare('SELECT changes() AS n').get()?.n ?? 0) },
      }),
    }
  }
  DB = {
    prepare,
    batch: (stmts: ReturnType<typeof prepare>[]) => {
      db.exec('BEGIN')
      try {
        const out = stmts.map((s) => s.execute())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  relay.mockReset().mockImplementation(async () => answer())
})
afterEach(() => db.close())
const budget = (n: number) =>
  db
    .prepare("UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',?)")
    .run(n)
function req(suffix: string, token = owner, body?: unknown, extra: Partial<Bindings> = {}) {
  return app.request(
    'https://work.test/api/assistant' + suffix,
    {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: '__Host-workbench_session=' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { DB, OPENROUTER_API_KEY: key, OPENROUTER_US: { fetch: relay }, ...extra },
  )
}
const input = (question = '问题') => ({ id: crypto.randomUUID(), question, page: '发现商品' })
it('uses inventory tools without model credit and protects confirmed job plans', async () => {
  db.prepare(
    "INSERT INTO products(id,platform,market,external_id,title,category_id,currency,min_price,total_sold) VALUES('temu:US:15','temu','US','15','厨房纸架','9711','USD',3.99,100)",
  ).run()
  const lookup = await req(path + '/turns', owner, input('查 Temu 家居，4 美元以内，销量至少 10 件'))
  expect(await lookup.json()).toMatchObject({ answer: expect.stringContaining('厨房纸架') })
  db.prepare("UPDATE accounts SET role='operator' WHERE id='alice'").run()
  const turn = input('在线找 Temu 家居，4 美元以内，销量至少 10 件，10 页')
  const plan = await req(path + '/turns', owner, turn)
  expect(await plan.json()).toMatchObject({ hasPlan: 1, answer: expect.stringContaining('100 积分') })
  expect((await req(path + '/turns/' + turn.id + '/run', owner, {})).status).toBe(409)
  expect((await req(path + '/turns/' + turn.id + '/run', other, {})).status).toBe(403)
  expect(db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(0)
  expect(relay).not.toHaveBeenCalled()
})
it('lets the model select a real tool and feeds observed results back to it', async () => {
  budget(100000)
  relay.mockResolvedValueOnce(
    Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'tool-1', type: 'function', function: { name: 'my_jobs', arguments: '{}' } },
            ],
          },
        },
      ],
      usage: { cost: 0.00001 },
    }),
  )
  const turn = await req(path + '/turns', owner, input('刚才我的选品调查做完了吗'))
  expect(await turn.json()).toMatchObject({ answer: expect.stringContaining('你还没有选品任务') })
  const payload = (await relay.mock.calls[1][0].json()) as {
    messages: { role: string; content: string }[]
  }
  expect(payload.messages.at(-1)?.role).toBe('tool')
  expect(JSON.parse(payload.messages.at(-1)!.content)).toMatchObject({
    version: 1,
    status: 'empty',
    data: { items: [] },
  })
  expect((await usage(DB)).aiMicros).toBe(20)
})
it('creates a confirmed cache discovery exactly once and returns its real run id', async () => {
  budget(100000)
  db.prepare("UPDATE accounts SET role='operator' WHERE id='alice'").run()
  const turn = input('帮我在库存里建一个选品计划')
  const args = {
    platform: 'temu',
    keyword: '',
    category: 'home',
    maxPrice: 4,
    minSold: 10,
    pages: 1,
    mode: 'cache',
  }
  relay.mockResolvedValueOnce(
    Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'q',
                type: 'function',
                function: { name: 'prepare_discovery', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage: { cost: 0.00001 },
    }),
  )
  expect(await (await req(path + '/turns', owner, turn)).json()).toMatchObject({ hasPlan: 1 })
  const confirm = () => req(path + '/turns/' + turn.id + '/run', owner, {})
  const first = await confirm()
  expect(first.status).toBe(200)
  const job = (await first.json()) as { id: string }
  expect(await (await confirm()).json()).toMatchObject({ id: job.id })
  expect(db.prepare('SELECT actor,status FROM job_runs').all()).toEqual([
    { actor: 'alice', status: 'succeeded' },
  ])
})
it('authenticates, keeps account transcripts and images private, and reuses actual turns when continuing a chat', async () => {
  budget(200000)
  expect((await req('/conversations', '')).status).toBe(401)
  const first = { ...input('图中有什么'), image: picture }
  const response = await req(path + '/turns', owner, first)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    question: '图中有什么',
    answer: '模型原文 [redacted]',
    hasImage: 1,
  })
  expect(await (await req(path + '/turns', owner, first)).json()).toMatchObject({ id: first.id })
  expect(relay).toHaveBeenCalledTimes(1)
  expect(await (await req('/conversations')).json()).toMatchObject({
    items: [{ id: conv, title: '图中有什么' }],
    unavailable: null,
  })
  expect(await (await req('/conversations', other)).json()).toMatchObject({ items: [] })
  expect((await req(path, other)).status).toBe(404)
  expect((await req(path + '/turns', other, first)).status).toBe(404)
  expect((await req(path + '/images/' + first.id, other)).status).toBe(404)
  const img = await req(path + '/images/' + first.id)
  expect(img.headers.get('Content-Type')).toBe('image/jpeg')
  expect([...new Uint8Array(await img.arrayBuffer())]).not.toContain(225)
  await req(path + '/turns', owner, input('继续看那张图'))
  const upstream = relay.mock.calls[1][0]
  expect(upstream.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(upstream.headers.get('authorization')).toBe('Bearer ' + key)
  const payload = (await upstream.json()) as { messages: { role: string; content: unknown }[] }
  expect(payload.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  expect(JSON.stringify(payload.messages[1])).toContain('data:image/jpeg;base64,')
  expect(JSON.stringify(payload.messages.at(-1))).toContain('继续看那张图')
  expect((await usage(DB)).aiMicros).toBe(20)
  const newChat = '/conversations/' + crypto.randomUUID()
  await req(newChat + '/turns', owner, input('新话题'))
  expect(JSON.stringify(await relay.mock.calls[2][0].json())).not.toContain('图中有什么')
  expect(await (await req(path)).json()).toMatchObject({
    items: [{ id: first.id }, { question: '继续看那张图' }],
    more: false,
  })
})
it('stops missing credentials and zero budgets; ambiguous provider cost remains reserved across accounts and jobs', async () => {
  expect(await (await req('/conversations')).json()).toMatchObject({
    unavailable: expect.stringContaining('预算'),
  })
  expect(await (await req(path + '/turns', owner, input())).json()).toMatchObject({
    answer: null,
    issue: expect.stringContaining('预算'),
  })
  budget(30000)
  expect(
    await (await req(path + '/turns', owner, input(), { OPENROUTER_API_KEY: undefined })).json(),
  ).toMatchObject({ issue: expect.stringContaining('模型') })
  expect(relay).not.toHaveBeenCalled()
  relay.mockRejectedValueOnce(new Error('connection lost'))
  expect(await (await req(path + '/turns', owner, input())).json()).toMatchObject({
    answer: null,
    issue: expect.any(String),
  })
  expect(await usage(DB)).toMatchObject({ aiMicros: 30000, unconfirmedAiMicros: 30000 })
  expect(
    await (await req('/conversations/' + crypto.randomUUID() + '/turns', other, input())).json(),
  ).toMatchObject({ issue: expect.stringContaining('预算') })
  expect(relay).toHaveBeenCalledTimes(1)
})
it('rejects parallel messages and never sends a duplicated pending request twice', async () => {
  budget(90000)
  let release!: (response: Response) => void
  relay.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  )
  const first = input()
  const pending = req(path + '/turns', owner, first)
  await vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(1))
  expect((await req(path + '/turns', owner, input())).status).toBe(409)
  expect(await (await req(path + '/turns', owner, first)).json()).toMatchObject({
    id: first.id,
    answer: null,
  })
  release(answer())
  expect((await pending).status).toBe(200)
  expect(relay).toHaveBeenCalledTimes(1)
})
it('filters progress to the selected team daily selection task and reports actual qualifying products', async () => {
  const day = businessClock().slice(0, 10)
  const args = [
    ['t', 'discovery', 'scheduler', 'cron:daily:US:' + day],
    ['old', 'discovery', 'scheduler', 'cron:daily:US:2020-01-01'],
    ['custom', 'discovery', 'alice', 'alice:1'],
    ['unrelated', 'research', 'alice', 'alice:2'],
  ]
  for (const row of args)
    db.prepare(
      "INSERT INTO job_runs(id,kind,actor,request_key,status,title,strategy_version,inputs_json,created_at,updated_at) VALUES(?,?,?,?,'running','每日任务',1,'{}','2026-10-01','2026-10-01')",
    ).run(...row)
  db.exec(
    "INSERT INTO job_seen(run_id,product_id,tier,first_page) VALUES('t','temu:US:12',0,1),('t','temu:US:13',NULL,1)",
  )
  expect(await (await req('/daily-tasks?date=' + day)).json()).toMatchObject({
    date: day,
    task: { id: 't', status: 'running', selected: 1 },
  })
  expect(await (await req('/daily-tasks?date=2022-01-01')).json()).toMatchObject({ task: null })
})

it('starts an owned cached investigation once and exposes only its owner controls', async () => {
  budget(500000)
  const launches = vi.fn(async () => ({ id: 'workflow' }))
  const binding = { ASSISTANT_RUNNER: { create: launches } } as unknown as Partial<Bindings>
  const turn = input('调查已有商品并给我报告')
  const started = await req(path + '/investigations', owner, turn, binding)
  expect(started.status).toBe(200)
  const body = (await started.json()) as ChatRun
  expect(body.runId).toBeTruthy()
  expect((await req(path + '/investigations', owner, turn, binding)).status).toBe(200)
  expect(launches).toHaveBeenCalledTimes(1)
  expect((await req('/investigations/' + body.runId, other)).status).toBe(404)
  expect((await req('/investigations/' + body.runId, owner)).status).toBe(200)
  expect((await req('/investigations/' + body.runId + '/cancel', other, {})).status).toBe(404)
  expect((await req('/investigations/' + body.runId + '/cancel', owner, {})).status).toBe(200)
  expect(relay).not.toHaveBeenCalled()
})
type ChatRun = { runId: string }

it('reads two different products through repeated tool names in bounded chat', async () => {
  budget(200000)
  for (const [id, title] of [
    ['21', '第一款纸架'],
    ['22', '第二款纸架'],
  ])
    db.prepare(
      "INSERT INTO products(id,platform,market,external_id,title,currency,min_price,total_sold) VALUES(?,'temu','US',?,?,'USD',3,100)",
    ).run('temu:US:' + id, id, title)
  for (const id of ['21', '22'])
    relay.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-' + id,
                  type: 'function',
                  function: {
                    name: 'read_product',
                    arguments: JSON.stringify({ productId: 'temu:US:' + id }),
                  },
                },
              ],
            },
          },
        ],
        usage: { cost: 0.00001 },
      }),
    )
  const response = await req(path + '/turns', owner, input('比较两款纸架'))
  const body = (await response.json()) as { answer: string }
  expect(body.answer).toContain('第一款纸架')
  expect(body.answer).toContain('第二款纸架')
})

it('bounds complete chat text and tool schemas in UTF8 while preserving one low-detail image', () => {
  expect(typeof assistantModel.checkedChatPayload).toBe('function')
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(200000)
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '商品问题' },
          { type: 'image_url', image_url: { url: image, detail: 'low' } },
        ],
      },
    ],
    tools: [],
  }
  expect(JSON.parse(assistantModel.checkedChatPayload(body))).toEqual(body)
  expect(() =>
    assistantModel.checkedChatPayload({ messages: [{ content: '中'.repeat(6000) }] }),
  ).toThrow()
  expect(() =>
    assistantModel.checkedChatPayload({ messages: [], tools: [{ description: 'x'.repeat(18000) }] }),
  ).toThrow()
})

it('rejects an oversized first chat request before reserving or sending', async () => {
  budget(200000)
  const filters = Object.fromEntries(
    Array.from({ length: 30 }, (_, n) => ['filter' + n, '测试'.repeat(150)]),
  )
  const response = await req(path + '/turns', owner, { ...input('查看这些条件'), filters })
  expect(await response.json()).toMatchObject({
    answer: null,
    issue: expect.stringContaining('输入上限'),
  })
  expect(relay).not.toHaveBeenCalled()
  expect(db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})

it('keeps readable tool facts and skips an oversized followup without an unused reservation', async () => {
  budget(200000)
  db.prepare(
    "INSERT INTO products(id,platform,market,external_id,title,currency,min_price,total_sold,variants_json) VALUES('temu:US:31','temu','US','31','带长规格的纸架','USD',3,100,?)",
  ).run(
    JSON.stringify([
      { sku_id: 'one', specs: [{ specKey: '说明', specValue: '较长的来源规格'.repeat(4000) }] },
    ]),
  )
  relay.mockResolvedValueOnce(
    Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'read-one',
                type: 'function',
                function: {
                  name: 'read_product',
                  arguments: JSON.stringify({ productId: 'temu:US:31' }),
                },
              },
            ],
          },
        },
      ],
      usage: { cost: 0.00001 },
    }),
  )
  const body = await (await req(path + '/turns', owner, input('看看纸架的规格资料'))).json()
  expect(body).toMatchObject({ answer: expect.stringContaining('带长规格的纸架'), issue: null })
  expect(relay).toHaveBeenCalledTimes(1)
  expect(db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(1)
  expect(await usage(DB)).toMatchObject({ aiMicros: 10, unconfirmedAiMicros: 0 })
})
