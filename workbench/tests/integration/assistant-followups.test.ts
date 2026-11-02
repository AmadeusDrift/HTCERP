import { afterEach, beforeEach, expect, it } from 'vitest'
import { applyAssistantMessages, submitAssistantMessage } from '../../packages/assistant/followups'
import { advanceAssistantRun } from '../../packages/assistant/loop'
import { persistInvestigationReport } from '../../packages/assistant/report'
import { assistantRunRow, createAssistantRun, readAssistantRun } from '../../packages/assistant/runs'
import { investigationFixture, modelAction } from './assistant-run-fixture'

let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
})
afterEach(() => f.db.close())
const create = () => createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '比较库存商品', {})
const message = (text = '排除第二款，重点比较第一款和第三款') => ({
  id: crypto.randomUUID(),
  message: text,
  intent: 'continue' as const,
})

it('queues owned followups once and applies the changed scope at the step boundary without resetting limits', async () => {
  const run = await create(),
    input = message()
  f.db.prepare('UPDATE assistant_runs SET model_steps=3,tool_steps=4 WHERE id=?').run(run.id)
  await submitAssistantMessage(f.env, 'alice', run.id, input)
  await submitAssistantMessage(f.env, 'alice', run.id, input)
  expect(f.db.prepare('SELECT COUNT(*) n FROM assistant_messages').get()?.n).toBe(1)
  expect((await assistantRunRow(f.env.DB, run.id)).scope_version).toBe(1)
  const applied = await applyAssistantMessages(f.env, await assistantRunRow(f.env.DB, run.id))
  expect(applied.scope_version).toBe(2)
  expect(applied.goal).toContain(input.message)
  expect(applied.model_steps).toBe(3)
  expect(applied.tool_steps).toBe(4)
  expect(JSON.parse(applied.limits_json)).toEqual(run.limits)
  expect((await applyAssistantMessages(f.env, applied)).scope_version).toBe(2)
  await expect(
    submitAssistantMessage(f.env, 'alice', run.id, { ...input, message: 'changed' }),
  ).rejects.toThrow()
})

it('does not let another account amend or continue a run, or an inactive owner submit a message', async () => {
  const run = await create()
  await expect(submitAssistantMessage(f.env, 'bob', run.id, message())).rejects.toThrow()
  f.db.exec("UPDATE accounts SET active=0 WHERE id='alice'")
  await expect(submitAssistantMessage(f.env, 'alice', run.id, message())).rejects.toThrow()
  expect(f.db.prepare('SELECT COUNT(*) n FROM assistant_messages').get()?.n).toBe(0)
})

it('continues a delivered investigation and preserves immutable report versions and total usage', async () => {
  const run = await create()
  await persistInvestigationReport(f.env, await assistantRunRow(f.env.DB, run.id), 'partial', '先前结论')
  const first = f.db.prepare('SELECT report_json FROM assistant_report_versions').get()?.report_json
  const input = message('继续刚才的调查，补充比较尺寸')
  const result = await submitAssistantMessage(f.env, 'alice', run.id, input)
  expect(result.runId).toBe(run.id)
  expect((await assistantRunRow(f.env.DB, run.id)).attempt).toBe(2)
  await applyAssistantMessages(f.env, await assistantRunRow(f.env.DB, run.id))
  await persistInvestigationReport(f.env, await assistantRunRow(f.env.DB, run.id), 'partial', '补充结论')
  const versions = f.db
    .prepare('SELECT report_json,scope_version FROM assistant_report_versions ORDER BY revision')
    .all()
  expect(versions).toHaveLength(2)
  expect(versions[0].report_json).toBe(first)
  expect(versions[1].scope_version).toBe(2)
})

it('starts an unrelated new goal in its own investigation and leaves the original intact', async () => {
  const run = await create(),
    input = { ...message('调查另一批宠物商品'), intent: 'new' as const }
  const next = await submitAssistantMessage(f.env, 'alice', run.id, input)
  const replay = await submitAssistantMessage(f.env, 'alice', run.id, input)
  expect(next.runId).not.toBe(run.id)
  expect(replay.runId).toBe(next.runId)
  expect((await assistantRunRow(f.env.DB, run.id)).goal).toBe('比较库存商品')
})

it('keeps cancelled work final and refuses report publication over pending steering', async () => {
  const run = await create(),
    row = await assistantRunRow(f.env.DB, run.id)
  await submitAssistantMessage(f.env, 'alice', run.id, message())
  expect(await persistInvestigationReport(f.env, row, 'succeeded', '过时结论')).toBe(false)
  f.db.prepare("UPDATE assistant_runs SET status='cancelled' WHERE id=?").run(run.id)
  await expect(submitAssistantMessage(f.env, 'alice', run.id, message())).rejects.toThrow()
})

it('replays the same saved followup after a lost Workflow start acknowledgement', async () => {
  const run = await create()
  await persistInvestigationReport(f.env, await assistantRunRow(f.env.DB, run.id), 'partial', '原结果')
  const input = message('继续比较')
  f.create.mockRejectedValueOnce(new Error('create acknowledgement lost'))
  await expect(submitAssistantMessage(f.env, 'alice', run.id, input)).rejects.toThrow()
  const replay = await submitAssistantMessage(f.env, 'alice', run.id, input)
  expect(replay.runId).toBe(run.id)
  expect((await assistantRunRow(f.env.DB, run.id)).workflow_started).toBe(1)
  expect(f.db.prepare('SELECT COUNT(*) n FROM assistant_messages').get()?.n).toBe(1)
})

it('keeps new goal context independent after the original already received steering', async () => {
  const run = await create()
  await submitAssistantMessage(f.env, 'alice', run.id, message('原任务只看厨房'))
  await applyAssistantMessages(f.env, await assistantRunRow(f.env.DB, run.id))
  const next = await submitAssistantMessage(f.env, 'alice', run.id, {
    ...message('调查宠物玩具'),
    intent: 'new',
  })
  await submitAssistantMessage(f.env, 'alice', next.runId, message('仅比较耐用性'))
  const row = await applyAssistantMessages(f.env, await assistantRunRow(f.env.DB, next.runId))
  expect(row.goal).toContain('调查宠物玩具')
  expect(row.goal).toContain('仅比较耐用性')
  expect(row.goal).not.toContain('只看厨房')
})

it('settles an in-flight model response but never executes its old-scope tool after a followup', async () => {
  let release!: (response: Response) => void
  f.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const run = await create(),
    pending = advanceAssistantRun(f.env, run.id, 1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  await submitAssistantMessage(f.env, 'alice', run.id, message('只比较我的任务，不读商品'))
  release(modelAction({ type: 'tool', name: 'read_product', args: { productId: 'temu:US:99' } }))
  await pending
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'tool', name: 'my_jobs', args: {} }))
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '按最新条件完成', recommendations: [], excluded: [], missing: [] },
    }),
  )
  for (let i = 0; i < 10; i++) if (!(await advanceAssistantRun(f.env, run.id, 1)).continue) break
  expect(
    f.db
      .prepare("SELECT COUNT(*) n FROM assistant_steps WHERE kind='tool' AND name='read_product'")
      .get()?.n,
  ).toBe(0)
  expect(
    f.db
      .prepare(
        "SELECT COUNT(*) n FROM assistant_steps WHERE kind='tool' AND name='my_jobs' AND scope_version=2",
      )
      .get()?.n,
  ).toBe(1)
  expect(
    f.db.prepare('SELECT SUM(actual) n FROM usage_reservations WHERE assistant_run_id=?').get(run.id)?.n,
  ).toBe(30)
  expect((await assistantRunRow(f.env.DB, run.id)).status).toBe('succeeded')
})

it('does not reuse a completed old report when continuing the delivered run', async () => {
  const run = await create()
  f.fetch.mockResolvedValueOnce(modelAction({ type: 'tool', name: 'my_jobs', args: {} }))
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '第一版报告', recommendations: [], excluded: [], missing: [] },
    }),
  )
  for (let i = 0; i < 8; i++) if (!(await advanceAssistantRun(f.env, run.id, 1)).continue) break
  await submitAssistantMessage(f.env, 'alice', run.id, message('继续比较，并说明新增条件'))
  f.fetch.mockResolvedValueOnce(
    modelAction({
      type: 'report',
      report: { summary: '第二版报告，包含新增条件', recommendations: [], excluded: [], missing: [] },
    }),
  )
  for (let i = 0; i < 8; i++) if (!(await advanceAssistantRun(f.env, run.id, 2)).continue) break
  const versions = f.db
    .prepare('SELECT report_json FROM assistant_report_versions ORDER BY revision')
    .all()
  expect(versions).toHaveLength(2)
  expect(JSON.parse(String(versions[0].report_json)).summary).toBe('第一版报告')
  expect(JSON.parse(String(versions[1].report_json)).summary).toContain('第二版报告')
  expect(f.fetch).toHaveBeenCalledTimes(3)
})

it('stops instead of spinning when ownership or active account changes after accepting steering', async () => {
  const run = await create()
  await submitAssistantMessage(f.env, 'alice', run.id, message())
  f.db.exec("UPDATE accounts SET active=0 WHERE id='alice'")
  const result = await advanceAssistantRun(f.env, run.id, 1)
  expect(result.continue).toBe(false)
  expect((await assistantRunRow(f.env.DB, run.id)).status).toBe('failed')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('claims one immutable intent before concurrent new-goal and continuation messages can start work', async () => {
  const run = await create(),
    input = message()
  const results = await Promise.allSettled([
    submitAssistantMessage(f.env, 'alice', run.id, input),
    submitAssistantMessage(f.env, 'alice', run.id, { ...input, intent: 'new' }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const claimed = f.db.prepare('SELECT intent FROM assistant_messages').get()?.intent
  expect(f.db.prepare('SELECT COUNT(*) n FROM assistant_runs').get()?.n).toBe(claimed === 'new' ? 2 : 1)
  expect(f.db.prepare('SELECT COUNT(*) n FROM assistant_messages').get()?.n).toBe(1)
})

it('settles an archived old response before applying steering without resending its request', async () => {
  const run = await create(),
    time = new Date().toISOString()
  f.db
    .prepare(
      "UPDATE assistant_runs SET status='running',model_steps=1,limits_json=json_set(limits_json,'$.modelSteps',1) WHERE id=?",
    )
    .run(run.id)
  f.db
    .prepare(
      "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,created_at,updated_at) VALUES(?,1,'model-1','model','decision','{}','sending',?,?)",
    )
    .run(run.id, time, time)
  f.db
    .prepare(
      "INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id) VALUES(?,'model-1','micros','2026-11-01',30000,'reserved',?,?)",
    )
    .run('assistant-run:' + run.id, time, run.id)
  f.archive.set(
    'assistant-runs/' + run.id + '/model-1.json',
    JSON.stringify({
      status: 200,
      body: await modelAction({ type: 'tool', name: 'my_jobs', args: {} }).json(),
      points: null,
      fetchedAt: time,
    }),
  )
  await submitAssistantMessage(f.env, 'alice', run.id, message('修改范围'))
  await advanceAssistantRun(f.env, run.id, 1)
  expect(f.db.prepare('SELECT actual,state FROM usage_reservations').get()).toEqual({
    actual: 10,
    state: 'confirmed',
  })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.db.prepare("SELECT COUNT(*) n FROM assistant_steps WHERE kind='tool'").get()?.n).toBe(0)
})

it('rechecks private job ownership before showing a saved report or its old versions', async () => {
  const run = await create(),
    time = new Date().toISOString(),
    jobId = crypto.randomUUID()
  f.db
    .prepare(
      "INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at) VALUES(?,'research','succeeded','private',1,'{}','alice',?,?,?)",
    )
    .run(jobId, jobId, time, time)
  f.db
    .prepare(
      "INSERT INTO assistant_steps(run_id,seq,action_key,kind,name,input_json,status,result_json,created_at,updated_at) VALUES(?,1,'job','tool','read_job',?,'completed',?,?,?)",
    )
    .run(
      run.id,
      JSON.stringify({ jobId }),
      JSON.stringify({
        status: 'ok',
        data: {},
        evidence: [{ id: 'job-evidence', kind: 'job_report', objectId: jobId }],
        missing: [],
        warnings: [],
      }),
      time,
      time,
    )
  await persistInvestigationReport(
    f.env,
    await assistantRunRow(f.env.DB, run.id),
    'partial',
    '敏感的任务总结',
  )
  expect((await readAssistantRun(f.env, 'alice', run.id)).answer).toContain('敏感的任务总结')
  f.db.prepare("UPDATE job_runs SET actor='bob' WHERE id=?").run(jobId)
  const visible = await readAssistantRun(f.env, 'alice', run.id)
  expect(JSON.stringify(visible)).not.toContain('敏感的任务总结')
  expect(visible.report).toBeNull()
})
