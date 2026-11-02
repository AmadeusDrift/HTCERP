import { afterEach, beforeEach, expect, it } from 'vitest'
import { investigationUsage } from '../../packages/assistant/budget'
import {
  collectAssistantJobs,
  confirmAssistantProposal,
  createAssistantProposal,
  rejectAssistantProposal,
  submitAssistantJobs,
} from '../../packages/assistant/online'
import { assistantRunRow, createAssistantRun } from '../../packages/assistant/runs'
import { investigationFixture } from './assistant-run-fixture'

let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
  f.db.exec(
    "UPDATE accounts SET role='operator' WHERE id='alice'; UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.dataDailyPoints',100,'$.aiDailyMicros',1000000)",
  )
})
afterEach(() => f.db.close())
const spec = (productId = 'temu:US:1') => ({
  maxDataPoints: 20,
  maxAiMicros: 360000,
  actions: [
    {
      operation: 'product_refresh',
      productId,
      pages: 1,
      calls: 1,
      childResearch: 0,
      maxDataPoints: 10,
      maxAiMicros: 0,
      writeWatchPool: false,
    },
  ],
})
async function start() {
  return createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '补查商品', {})
}
it('only an active owner confirms a scope-pinned proposal; repeats retain one allocated action and stable request id', async () => {
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  await expect(confirmAssistantProposal(f.env, 'bob', run.id, p.id)).rejects.toThrow()
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  const links = f.db.prepare('SELECT * FROM assistant_job_links').all()
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({
    allocated_points: 10,
    allocated_micros: 0,
    state: 'pending',
    scope_version: 1,
  })
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('expired, rejected and obsolete scopes cannot submit jobs or make external requests', async () => {
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  await rejectAssistantProposal(f.env, 'alice', run.id, p.id)
  await expect(confirmAssistantProposal(f.env, 'alice', run.id, p.id)).rejects.toThrow()
  const q = await createAssistantProposal(f.env, 'alice', run.id, spec('temu:US:2'))
  f.db.exec('UPDATE assistant_runs SET scope_version=scope_version+1')
  await expect(confirmAssistantProposal(f.env, 'alice', run.id, q.id)).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(0)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('viewers can read cached runs but cannot approve online actions', async () => {
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  f.db.exec("UPDATE accounts SET role='viewer' WHERE id='alice'")
  await expect(confirmAssistantProposal(f.env, 'alice', run.id, p.id)).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) n FROM assistant_job_links').get()?.n).toBe(0)
})
it('submits a confirmed online action once with its budget link persisted before starting ResearchWorkflow', async () => {
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  f.env.GB_APP_KEY = 'fixture'
  f.env.GB_APP_SECRET = 'fixture-secret'
  const starts: unknown[] = []
  f.env.RUNNER.create = async (value) => {
    starts.push(value)
    const link = f.db.prepare('SELECT job_id FROM assistant_job_links').get()
    expect(link?.job_id).toBe((value!.params as { runId: string }).runId)
    return { id: 'child' } as WorkflowInstance
  }
  await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))
  await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))
  expect(starts).toHaveLength(1)
  expect(f.db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(1)
  expect(f.db.prepare('SELECT state FROM assistant_job_links').get()?.state).toBe('submitted')
  expect(f.fetch).not.toHaveBeenCalled()
})
it('terminal child usage is collected without model polling, retaining unknown charges and actual cached evidence', async () => {
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  const link = f.db.prepare('SELECT id FROM assistant_job_links').get()!
  f.db.exec(
    "INSERT INTO products(id,platform,market,external_id,title,currency,min_price) VALUES('temu:US:1','temu','US','1','纸架','USD',3)",
  )
  f.db
    .prepare(
      "INSERT INTO job_runs(id,kind,status,title,strategy_version,inputs_json,actor,request_key,created_at,updated_at) VALUES('child','research','partial','详情更新',1,'{}','alice','child','2026-11-01','2026-11-01')",
    )
    .run()
  f.db.prepare("UPDATE assistant_job_links SET job_id='child',state='submitted' WHERE id=?").run(link.id)
  f.db
    .prepare(
      "INSERT INTO usage_reservations(run_id,step_key,unit,business_date,reserved,state,created_at,assistant_run_id,assistant_link_id) VALUES('child','focus','points','2026-11-01',10,'uncertain','2026-11-01',?,?)",
    )
    .run(run.id, link.id)
  const result = await collectAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))
  expect(result).toMatchObject({ waiting: false, collected: 1 })
  expect((await investigationUsage(f.env.DB, run.id)).dataPoints).toBe(10)
  expect(
    f.db.prepare("SELECT count(*) n FROM assistant_steps WHERE kind='tool' AND status='completed'").get()
      ?.n,
  ).toBeGreaterThan(0)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('replays an unacknowledged child submission before insertion using the same persisted request id', async () => {
  const { vi } = await import('vitest')
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  await confirmAssistantProposal(f.env, 'alice', run.id, p.id)
  f.env.GB_APP_KEY = 'fixture'
  f.env.GB_APP_SECRET = 'fixture-secret'
  f.env.RUNNER.create = async () => ({ id: 'child' }) as WorkflowInstance
  vi.spyOn(f.env.DB, 'batch').mockRejectedValueOnce(new Error('D1 transient'))
  expect(await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))).toBe(0)
  expect(f.db.prepare('SELECT state FROM assistant_job_links').get()?.state).toBe('uncertain')
  await submitAssistantJobs(f.env, await assistantRunRow(f.env.DB, run.id))
  expect(f.db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(1)
})
it('rejects contradictory platform and product scopes without creating any job', async () => {
  const run = await start()
  await expect(
    createAssistantProposal(f.env, 'alice', run.id, {
      ...spec(),
      actions: [{ ...spec().actions[0], platform: 'amazon' }],
    }),
  ).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) n FROM job_runs').get()?.n).toBe(0)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('same-millisecond duplicate confirmations preserve the accepted run and allocate only once', async () => {
  const { vi } = await import('vitest')
  const run = await start(),
    p = await createAssistantProposal(f.env, 'alice', run.id, spec())
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  await Promise.all([
    confirmAssistantProposal(f.env, 'alice', run.id, p.id),
    confirmAssistantProposal(f.env, 'alice', run.id, p.id),
  ])
  expect(f.db.prepare('SELECT count(*) n FROM assistant_job_links').get()?.n).toBe(1)
  expect(
    f.db.prepare('SELECT confirmation_token FROM assistant_proposals').get()?.confirmation_token,
  ).toEqual(expect.any(String))
  clock.mockRestore()
})
