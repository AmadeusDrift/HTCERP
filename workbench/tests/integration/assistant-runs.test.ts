import { afterEach, beforeEach, expect, it } from 'vitest'
import { controlAssistantRun, createAssistantRun, readAssistantRun } from '../../packages/assistant/runs'
import { investigationFixture } from './assistant-run-fixture'

let f: ReturnType<typeof investigationFixture>
beforeEach(() => {
  f = investigationFixture()
})
afterEach(() => f.db.close())
const create = () => createAssistantRun(f.env, 'alice', f.conversationId, f.turnId, '比较库存商品', {})
it('persists a viewer cached investigation once per owned original turn and uses one stable workflow id', async () => {
  const first = await create(),
    duplicate = await create()
  expect(first.id).toBe(duplicate.id)
  expect(first.status).toBe('queued')
  expect(first.limits).toMatchObject({
    modelSteps: 12,
    toolSteps: 24,
    products: 10,
    activeMs: 1200000,
    dataPoints: 0,
  })
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.create.mock.calls[0][0]).toMatchObject({
    id: 'assistant-' + first.id + '-1',
    params: { runId: first.id, attempt: 1 },
  })
  await expect(readAssistantRun(f.env, 'bob', first.id)).rejects.toThrow()
})
it('pause and resume retain usage and stable action identity while cancel is final', async () => {
  const first = await create()
  expect((await controlAssistantRun(f.env, 'alice', first.id, 'pause')).status).toBe('paused')
  const resume = await controlAssistantRun(f.env, 'alice', first.id, 'resume')
  expect(resume.attempt).toBe(2)
  expect(resume.modelSteps).toBe(0)
  expect((await controlAssistantRun(f.env, 'alice', first.id, 'cancel')).status).toBe('cancelled')
  await expect(controlAssistantRun(f.env, 'alice', first.id, 'resume')).rejects.toThrow()
})
it('checks current account state instead of a browser role snapshot', async () => {
  f.db.exec("UPDATE accounts SET active=0 WHERE id='alice'")
  await expect(create()).rejects.toThrow()
  expect(f.create).not.toHaveBeenCalled()
})
it('a stale workflow attempt cannot overwrite a resumed attempt report or transcript', async () => {
  const { assistantRunRow } = await import('../../packages/assistant/runs')
  const { persistInvestigationReport } = await import('../../packages/assistant/report')
  const first = await create(),
    stale = await assistantRunRow(f.env.DB, first.id)
  f.db
    .prepare("UPDATE assistant_runs SET attempt=2,status='running',version=version+1 WHERE id=?")
    .run(first.id)
  await persistInvestigationReport(f.env, stale, 'succeeded', 'old attempt', {
    summary: '过期结果',
    recommendations: [],
    excluded: [],
    missing: [],
  })
  expect(f.db.prepare('SELECT status,report_json FROM assistant_runs').get()).toEqual({
    status: 'running',
    report_json: null,
  })
  expect(f.db.prepare('SELECT answer FROM assistant_turns').get()?.answer).toBeNull()
})
it('final report publication preserves a current cancellation decision', async () => {
  const { assistantRunRow } = await import('../../packages/assistant/runs')
  const { persistInvestigationReport } = await import('../../packages/assistant/report')
  const first = await create(),
    stale = await assistantRunRow(f.env.DB, first.id)
  f.db
    .prepare("UPDATE assistant_runs SET status='cancelling',version=version+1 WHERE id=?")
    .run(first.id)
  await persistInvestigationReport(f.env, stale, 'succeeded', '', {
    summary: '已保存结论',
    recommendations: [],
    excluded: [],
    missing: [],
  })
  expect(f.db.prepare('SELECT status FROM assistant_runs').get()?.status).toBe('cancelled')
})
it('does not mark an unknown workflow as successfully started after a lost create acknowledgement', async () => {
  f.create.mockRejectedValueOnce(new Error('lost acknowledgement'))
  f.env.ASSISTANT_RUNNER!.get = async () =>
    ({ status: async () => ({ status: 'unknown' }) }) as WorkflowInstance
  await expect(create()).rejects.toThrow('lost acknowledgement')
  expect(f.db.prepare('SELECT workflow_started FROM assistant_runs').get()?.workflow_started).toBe(0)
})
