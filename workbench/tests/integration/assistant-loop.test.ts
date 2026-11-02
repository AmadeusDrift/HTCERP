import { afterEach, beforeEach, expect, it } from 'vitest'
import { advanceAssistantRun } from '../../packages/assistant/loop'
import { controlAssistantRun, createAssistantRun, readAssistantRun } from '../../packages/assistant/runs'
import { investigationFixture, modelAction } from './assistant-run-fixture'

let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
})
afterEach(() => f.db.close())
const start = () => createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '比较库存商品', {})
it('recognizes omitted and explicit defaults as the same cached read', async () => {
  f.fetch.mockResolvedValueOnce(
    modelAction({ type: 'tool', name: 'search_inventory', args: { platform: 'temu' } }),
  )
  f.fetch.mockResolvedValueOnce(
    modelAction({ type: 'tool', name: 'search_inventory', args: { platform: 'temu', page: 1 } }),
  )
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(result.toolSteps).toBe(1)
  expect(result.answer).toContain('相同工具参数')
  expect(f.fetch).toHaveBeenCalledTimes(2)
})
it('rejects a full serialized model payload above its reserved input bound before spending', async () => {
  const first = await start(),
    time = new Date().toISOString()
  const result = {
    version: 1,
    status: 'ok',
    data: { text: '"'.repeat(20000) },
    evidence: [],
    missing: [],
    warnings: [],
  }
  f.db
    .prepare(
      "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,result_json,created_at,updated_at) VALUES(?,1,'existing','tool','my_jobs','{}','completed',?,?,?)",
    )
    .run(first.id, JSON.stringify(result), time, time)
  await advanceAssistantRun(f.env, first.id, 1)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT COUNT(*) n FROM usage_reservations').get()?.n).toBe(0)
  expect((await readAssistantRun(f.env, 'alice', first.id)).summary).toContain('模型输入上限')
})
it('records an anomalous fee above the request reservation and refuses the returned action', async () => {
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'tool', name: 'my_jobs', args: {} }, 0.09))
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(result.toolSteps).toBe(0)
  expect(result.usage.aiMicros).toBe(90000)
  expect(result.answer).toContain('费用超过')
  expect(f.fetch).toHaveBeenCalledTimes(1)
})
async function run(id: string, n = 20) {
  for (let i = 0; i < n; i++) if (!(await advanceAssistantRun(f.env, id, 1)).continue) break
  return readAssistantRun(f.env, 'alice', id)
}
it('performs cached list and repeated detail tools for different products, then persists the report to the original turn', async () => {
  f.db.exec(
    "INSERT INTO products(id,platform,market,external_id,title,currency,min_price,total_sold) VALUES('temu:US:1','temu','US','1','纸架一','USD',2,100),('temu:US:2','temu','US','2','纸架二','USD',3,200)",
  )
  const actions = [
    {
      type: 'tool',
      name: 'search_inventory',
      args: { platform: 'temu', keyword: '纸架', category: 'all' },
    },
    { type: 'tool', name: 'read_product', args: { productId: 'temu:US:1' } },
    { type: 'tool', name: 'read_product', args: { productId: 'temu:US:2' } },
    {
      type: 'report',
      report: {
        summary: '已比较两款缓存商品，仍需核实规格。',
        recommendations: [],
        excluded: [],
        missing: ['未在线补查'],
      },
    },
  ]
  for (const action of actions) f.fetch.mockResolvedValueOnce(modelAction(action))
  const result = await run((await start()).id)
  expect(result).toMatchObject({ status: 'succeeded', modelSteps: 4, toolSteps: 3 })
  expect(result.usage.aiMicros).toBe(40)
  expect(f.archive.size).toBe(4)
  expect(f.db.prepare('SELECT answer FROM assistant_turns WHERE id=?').get(f.turnId)?.answer).toContain(
    '已比较两款',
  )
  expect(f.fetch).toHaveBeenCalledTimes(4)
})
it('ambiguous provider cost stays reserved and a replay cannot resend the model request', async () => {
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'tool', name: 'my_jobs', args: {} }, null))
  const first = await start()
  const result = await run(first.id)
  expect(result.status).toBe('partial')
  expect(result.usage).toMatchObject({ aiMicros: 80000, unconfirmedAiMicros: 80000 })
  await advanceAssistantRun(f.env, first.id, 1)
  expect(f.fetch).toHaveBeenCalledTimes(1)
})
it('unknown model evidence references cannot produce verified recommendations', async () => {
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: {
        summary: '推荐不存在的商品',
        recommendations: [{ productId: 'temu:US:999', reason: '臆造', evidenceIds: ['fake'] }],
        excluded: [],
        missing: [],
      },
    }),
  )
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(result.report.recommendations).toEqual([])
  expect(result.report.missing.join(' ')).toContain('证据')
})
it('enforces cancellation during in-flight model archival and settles exactly once', async () => {
  let release!: (value: Response) => void
  f.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const first = await start(),
    pending = advanceAssistantRun(f.env, first.id, 1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect((await controlAssistantRun(f.env, 'alice', first.id, 'cancel')).status).toBe('cancelling')
  release(modelAction({ type: 'tool', name: 'my_jobs', args: {} }))
  await pending
  expect((await readAssistantRun(f.env, 'alice', first.id)).status).toBe('cancelled')
  expect(f.db.prepare('SELECT state,actual FROM usage_reservations').all()).toEqual([
    { state: 'confirmed', actual: 10 },
  ])
})
it('stops deactivated accounts and unavailable credentials without model sends', async () => {
  const first = await start()
  f.db.exec("UPDATE accounts SET active=0 WHERE id='alice'")
  await advanceAssistantRun(f.env, first.id, 1)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT status FROM assistant_runs').get()?.status).toBe('failed')
})

it('recovers a durably archived model response without sending it a second time', async () => {
  const first = await start(),
    timestamp = new Date().toISOString()
  f.db.prepare("UPDATE assistant_runs SET status='running',model_steps=1 WHERE id=?").run(first.id)
  f.db
    .prepare(
      "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,created_at,updated_at) VALUES(?,1,'model-1','model','decision','{}','sending',?,?)",
    )
    .run(first.id, timestamp, timestamp)
  f.db
    .prepare(
      "INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id) VALUES(?,'model-1','micros','2026-11-01',30000,'reserved',?,?)",
    )
    .run('assistant-run:' + first.id, timestamp, first.id)
  f.archive.set(
    'assistant-runs/' + first.id + '/model-1.json',
    JSON.stringify({
      body: await modelAction({ type: 'tool', name: 'my_jobs', args: {} }).json(),
      status: 200,
      points: null,
      fetchedAt: timestamp,
    }),
  )
  await advanceAssistantRun(f.env, first.id, 1)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT status FROM assistant_steps').get()?.status).toBe('completed')
  expect((await readAssistantRun(f.env, 'alice', first.id)).usage.aiMicros).toBe(10)
})
it('requires a completed cached read before a successful final report', async () => {
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '声称已经完成调查', recommendations: [], excluded: [], missing: [] },
    }),
  )
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(result.report.missing.join(' ')).toContain('证据')
})
it('a persisted sending marker without an archive becomes uncertain and is never resent', async () => {
  const first = await start(),
    timestamp = new Date().toISOString()
  f.db.prepare("UPDATE assistant_runs SET status='running',model_steps=1 WHERE id=?").run(first.id)
  f.db
    .prepare(
      "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,created_at,updated_at) VALUES(?,1,'model-1','model','decision','{}','sending',?,?)",
    )
    .run(first.id, timestamp, timestamp)
  f.db
    .prepare(
      "INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id) VALUES(?,'model-1','micros','2026-11-01',30000,'reserved',?,?)",
    )
    .run('assistant-run:' + first.id, timestamp, first.id)
  await advanceAssistantRun(f.env, first.id, 1)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT state FROM usage_reservations').get()?.state).toBe('uncertain')
})
it('current daily budget and pinned run cap stop the send without resetting counters', async () => {
  const first = await start()
  f.db.exec("UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',0)")
  const result = await run(first.id)
  expect(result.status).toBe('partial')
  expect(result.modelSteps).toBe(1)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('denied or unavailable tools cannot support a successful final report', async () => {
  f.fetch.mockResolvedValueOnce(
    modelAction({ type: 'tool', name: 'read_job', args: { jobId: 'unowned-job' } }),
  )
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '声称已经完成受限任务调查', recommendations: [], excluded: [], missing: [] },
    }),
  )
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(result.report.missing.join(' ')).toContain('证据')
})
it('a clarification waits for input in the original investigation and preserves the question', async () => {
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'clarify', question: '需要哪个平台？' }))
  const result = await run((await start()).id)
  expect(result.status).toBe('awaiting_input')
  expect(result.answer).toContain('需要哪个平台')
  await expect(controlAssistantRun(f.env, 'alice', result.id, 'resume')).rejects.toThrow()
})
it('cancellation while waiting for the AI lane removes the ticket without sending or spending', async () => {
  f.db.exec(
    "INSERT INTO service_tickets(token,lane,owner,active,expires) VALUES('busy','ai','other',1,unixepoch()+120)",
  )
  const first = await start(),
    pending = advanceAssistantRun(f.env, first.id, 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  await controlAssistantRun(f.env, 'alice', first.id, 'cancel')
  await Promise.race([
    pending,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('queue cancellation timed out')), 1800),
    ),
  ])
  expect(f.fetch).not.toHaveBeenCalled()
  expect((await readAssistantRun(f.env, 'alice', first.id)).status).toBe('cancelled')
  expect(f.db.prepare("SELECT count(*) n FROM service_tickets WHERE owner='alice'").get()?.n).toBe(0)
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('pinned model and active-time limits generate deterministic partial reports without a final model resend', async () => {
  const first = await start()
  f.db
    .prepare("UPDATE assistant_runs SET limits_json=json_set(limits_json,'$.modelSteps',1) WHERE id=?")
    .run(first.id)
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'tool', name: 'my_jobs', args: {} }))
  const result = await run(first.id)
  expect(result.status).toBe('partial')
  expect(result.modelSteps).toBe(1)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(result.report.coverage.tools).toBe(1)
})
it('two concurrent investigations cannot reserve the last daily allowance twice', async () => {
  const { reserveInvestigationModel } = await import('../../packages/assistant/budget')
  const one = await start(),
    turn = crypto.randomUUID()
  f.db
    .prepare(
      "INSERT INTO assistant_turns(conversation_id,id,question,context_json,created_at) VALUES(?,?,'第二次','{}',?)",
    )
    .run(f.conversationId, turn, new Date().toISOString())
  const two = await createAssistantRun(f.env, 'alice', f.conversationId, turn, '第二次', {})
  f.db.exec(
    "UPDATE assistant_runs SET status='running'; UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',80000)",
  )
  const reserved = await Promise.all([
    reserveInvestigationModel(f.env.DB, one.id, 'model-1', 1),
    reserveInvestigationModel(f.env.DB, two.id, 'model-1', 1),
  ])
  expect(reserved.filter(Boolean)).toHaveLength(1)
  expect(f.db.prepare('SELECT sum(reserved) n FROM usage_reservations').get()?.n).toBe(80000)
})
it('investigation job evidence stays owner-only even while the account is an administrator', async () => {
  f.db.exec(
    "UPDATE accounts SET role='admin' WHERE id='alice'; INSERT INTO job_runs(id,kind,actor,request_key,status,title,strategy_version,inputs_json,created_at,updated_at) VALUES('bob-private','research','bob','bob-private','succeeded','private',1,'{}','2026-11-01','2026-11-01')",
  )
  f.fetch.mockResolvedValueOnce(
    modelAction({ type: 'tool', name: 'read_job', args: { jobId: 'bob-private' } }),
  )
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '无法查看他人任务', recommendations: [], excluded: [], missing: [] },
    }),
  )
  const result = await run((await start()).id)
  expect(result.status).toBe('partial')
  expect(JSON.stringify(result.report)).not.toContain('private')
  expect(result.report.linkedJobs).toEqual([])
})
