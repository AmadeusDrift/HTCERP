import { afterEach, beforeEach, expect, it } from 'vitest'
import { investigationUsage, reserveInvestigationModel } from '../../packages/assistant/budget'
import { confirmAssistantProposal, createAssistantProposal } from '../../packages/assistant/online'
import { createAssistantRun } from '../../packages/assistant/runs'
import { investigationFixture } from './assistant-run-fixture'

let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
  f.db.exec(
    "UPDATE accounts SET role='operator' WHERE id='alice'; UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.dataDailyPoints',100,'$.aiDailyMicros',1000000)",
  )
})
afterEach(() => f.db.close())
const spec = (id: string) => ({
  maxDataPoints: 10,
  maxAiMicros: 120000,
  actions: [
    {
      operation: 'product_refresh',
      productId: id,
      pages: 1,
      calls: 1,
      childResearch: 0,
      maxDataPoints: 10,
      maxAiMicros: 0,
      writeWatchPool: false,
    },
  ],
})
it('concurrent confirmations compete atomically for the last run allocation', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {})
  const p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1')),
    q = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:2'))
  const confirmed = await Promise.allSettled([
    confirmAssistantProposal(f.env, 'alice', run.id, p.id),
    confirmAssistantProposal(f.env, 'alice', run.id, q.id),
  ])
  expect(confirmed.filter((v) => v.status === 'fulfilled')).toHaveLength(1)
  expect(f.db.prepare('SELECT sum(allocated_points) n FROM assistant_job_links').get()?.n).toBe(10)
})
it('parent model requests retain child commitments; actual child spend offsets allocations without double counting', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  const link = f.db.prepare('SELECT id FROM assistant_job_links').get()!.id
  f.db
    .prepare(
      "INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,actual,state,created_at,assistant_run_id,assistant_link_id) VALUES('test-child','source','points','2026-11-01',10,4,'confirmed','2026-11-01',?,?)",
    )
    .run(run.id, link)
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
  f.db.exec("UPDATE assistant_job_links SET state='settled'")
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(4)
  f.db.exec("UPDATE usage_reservations SET actual=NULL,state='uncertain'")
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
})
it('cross-day parent budget does not reset allocations and newly lowered daily budgets stop new reservations', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  f.db.exec(
    "UPDATE assistant_job_links SET business_date='2000-01-01'; UPDATE assistant_runs SET status='running'; UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',0)",
  )
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
  expect(await reserveInvestigationModel(f.env.DB, run.id, 'model-2', 1)).toBeNull()
})
it('linked child reservations inherit investigation ownership, caps and current authority atomically', async () => {
  const { reserve } = await import('../../packages/operations/execution')
  const { currentStrategy, getRun } = await import('../../packages/operations/model')
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  const link = f.db.prepare('SELECT id FROM assistant_job_links').get()!
  f.db.exec(
    "INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at) VALUES('child','research','running','child',1,'{}','alice','child','2026-11-01','2026-11-01'); UPDATE assistant_runs SET status='waiting_jobs'",
  )
  f.db.prepare("UPDATE assistant_job_links SET job_id='child',state='submitted' WHERE id=?").run(link.id)
  const c = {
    env: f.env,
    job: await getRun(f.env.DB, 'child'),
    input: { mode: 'live' as const, maxDataPoints: 10, maxAiMicros: 0 },
    settings: (await currentStrategy(f.env.DB)).settings,
    attempt: 0,
  }
  await reserve(c, 'source', 'points', 10)
  expect(
    f.db.prepare('SELECT assistant_run_id,assistant_link_id FROM usage_reservations').get(),
  ).toEqual({ assistant_run_id: run.id, assistant_link_id: link.id })
  expect(f.db.prepare('SELECT calls_used FROM assistant_job_links').get()?.calls_used).toBe(1)
  await expect(reserve(c, 'source2', 'points', 10)).rejects.toThrow()
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
})
it('revoked roles and pending scope messages prevent child reservation before any send', async () => {
  const { reserve } = await import('../../packages/operations/execution')
  const { currentStrategy, getRun } = await import('../../packages/operations/model')
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  f.db.exec(
    "INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at) VALUES('child','research','running','child',1,'{}','alice','child','2026-11-01','2026-11-01'); UPDATE assistant_job_links SET job_id='child',state='submitted'; UPDATE assistant_runs SET status='waiting_jobs'; UPDATE accounts SET role='viewer' WHERE id='alice'",
  )
  const c = {
    env: f.env,
    job: await getRun(f.env.DB, 'child'),
    input: { mode: 'live' as const, maxDataPoints: 10, maxAiMicros: 0 },
    settings: (await currentStrategy(f.env.DB)).settings,
    attempt: 0,
  }
  await expect(reserve(c, 'source', 'points', 10)).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('cancellation releases unsent allocations atomically while in-flight unknown ledger charges remain occupied', async () => {
  const { controlAssistantRun } = await import('../../packages/assistant/runs')
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  const link = f.db.prepare('SELECT id FROM assistant_job_links').get()!
  f.db
    .prepare(
      "INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id,assistant_link_id) VALUES('in-flight','source','points','2026-11-02',10,'reserved','2026-11-02',?,?)",
    )
    .run(run.id, link.id)
  await controlAssistantRun(f.env, 'alice', run.id, 'cancel')
  expect(f.db.prepare('SELECT state FROM assistant_job_links').get()?.state).toBe('settled')
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
  f.db.exec("UPDATE usage_reservations SET actual=4,state='confirmed'")
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(4)
  expect((await investigationUsage(f.env.DB, run.id)).allocatedDataPoints).toBe(0)
})
it('cancel before any child submission releases its entire commitment without spending', async () => {
  const { controlAssistantRun } = await import('../../packages/assistant/runs')
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  await controlAssistantRun(f.env, 'alice', run.id, 'cancel')
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(0)
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
it('scope messages and conversation reassignment block parent requests and online confirmations at their SQL boundary', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '在线补查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  f.db
    .prepare(
      "INSERT INTO assistant_messages(run_id,id,message,intent,state,created_at) VALUES(?,?,'改条件','continue','pending',?)",
    )
    .run(run.id, crypto.randomUUID(), new Date().toISOString())
  f.db.exec("UPDATE assistant_runs SET status='running'")
  expect(await reserveInvestigationModel(f.env.DB, run.id, 'model-1', 1, 1)).toBeNull()
  await expect(confirmAssistantProposal(f.env, 'alice', run.id, p.id)).rejects.toThrow()
  f.db.exec("DELETE FROM assistant_messages; UPDATE assistant_conversations SET account_id='bob'")
  expect(await reserveInvestigationModel(f.env.DB, run.id, 'model-1', 1, 1)).toBeNull()
  await expect(confirmAssistantProposal(f.env, 'alice', run.id, p.id)).rejects.toThrow()
})
it('a pending explicitly new goal never blocks the original run reservation or approval', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '原调查', {}),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:1'))
  f.db
    .prepare(
      "INSERT INTO assistant_messages(run_id,id,message,intent,state,created_at) VALUES(?,?,'另开一个新调查','new','pending',?)",
    )
    .run(run.id, crypto.randomUUID(), new Date().toISOString())
  f.db.exec("UPDATE assistant_runs SET status='running'")
  expect(await reserveInvestigationModel(f.env.DB, run.id, 'model-1', 1, 1)).not.toBeNull()
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  expect(f.db.prepare('SELECT status FROM assistant_proposals').get()?.status).toBe('confirmed')
  expect(f.db.prepare('SELECT scope_version FROM assistant_runs').get()?.scope_version).toBe(1)
})
it('an investigation cannot reserve a controller request with only 50000 micros left', async () => {
  const run = await createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '控制器预算', {})
  f.db.exec(
    "UPDATE assistant_runs SET status='running',limits_json=json_set(limits_json,'$.aiMicros',50000)",
  )
  expect(await reserveInvestigationModel(f.env.DB, run.id, 'controller-bound', 1, 1)).toBeNull()
  expect(f.db.prepare('SELECT count(*) n FROM usage_reservations').get()?.n).toBe(0)
})
