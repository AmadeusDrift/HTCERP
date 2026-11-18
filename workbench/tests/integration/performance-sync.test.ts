import type { WorkflowStep } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import { PublicError } from '../../packages/contracts/errors'
import { sourceConnection } from '../../packages/inventory-sync/source'
import { launchPerformanceSync, performanceSyncWorkflow } from '../../packages/store-sales/sync'
import { investigationFixture } from './assistant-run-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const now = Date.parse('2026-11-17T12:00:00Z')
function fixture() {
  const f = investigationFixture()
  f.db.exec("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'STORE')")
  const create = vi.fn(async ({ id }: { id: string }) => ({ id }))
  const env = {
    ...f.env,
    SP_CLIENT_ID: 'app',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
    RUNNER: {
      create,
      get: vi.fn(async () => ({ status: async () => ({ status: 'running' }) })),
    } as unknown as typeof f.env.RUNNER,
  }
  return { ...f, env, create }
}
const step = {
  do: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    typeof options === 'function' ? options() : callback!(),
} as unknown as WorkflowStep

it('requests full money/status fields with the correct exclusive time basis and a 100-order page', async () => {
  const send = vi.fn(async (url: URL | RequestInfo) =>
    String(url).includes('auth/o2/token')
      ? Response.json({ access_token: 'server' })
      : Response.json({ orders: [] }),
  )
  const api = new AmazonUS(
    { SP_CLIENT_ID: 'app', SP_CLIENT_SECRET: 'secret', SP_REFRESH_TOKEN: 'refresh' },
    send,
  )
  await api.performanceOrders('2026-11-10T08:00:00.000Z', '2026-11-17T11:57:00.000Z', 'created', 'page2')
  const params = new URL(String(send.mock.calls[1][0])).searchParams
  expect(params.get('createdAfter')).toBe('2026-11-10T08:00:00.000Z')
  expect(params.has('lastUpdatedAfter')).toBe(false)
  expect(params.get('includedData')).toBe('PROCEEDS,FULFILLMENT,CANCELLATION')
  expect(params.get('maxResultsPerPage')).toBe('100')
  expect(params.get('paginationToken')).toBe('page2')
})

it('claims only one active run and advances an overlapping watermark only after all pages succeed', async () => {
  const { db, env, create } = fixture()
  vi.spyOn(AmazonUS.prototype, 'searchListingsItems').mockResolvedValue({} as never)
  const fetchPage = vi
    .spyOn(AmazonUS.prototype, 'performanceOrders')
    .mockResolvedValueOnce({ orders: [], pagination: { nextToken: 'next' } })
    .mockRejectedValueOnce(new Error('source outage'))
  try {
    const first = await launchPerformanceSync(env, now)
    expect(first?.basis).toBe('created')
    expect(first?.from_at).toBe('2026-11-10T08:00:00.000Z')
    expect((await launchPerformanceSync(env, now))?.id).toBe(first?.id)
    expect(create).toHaveBeenCalledTimes(1)
    await expect(performanceSyncWorkflow(env, step, first!.id)).rejects.toThrow('source outage')
    expect(db.prepare('SELECT through_at FROM performance_sync_state').get()).toMatchObject({
      through_at: null,
    })
    expect(db.prepare('SELECT status,pages FROM performance_sync_runs').get()).toMatchObject({
      status: 'failed',
      pages: 1,
    })
    fetchPage.mockResolvedValue({ orders: [] })
    const second = await launchPerformanceSync(env, now + 3600000)
    expect(second?.from_at).toBe(first?.from_at)
    await performanceSyncWorkflow(env, step, second!.id)
    const state = db.prepare('SELECT through_at FROM performance_sync_state').get()!
    expect(state.through_at).toBe(second?.through_at)
    const third = await launchPerformanceSync(env, now + 7200000)
    expect(third?.basis).toBe('updated')
    expect(Date.parse(third!.from_at)).toBe(Date.parse(String(state.through_at)) - 3600000)
  } finally {
    db.close()
  }
})

it('waits through repeated quota contention without failing or advancing the watermark', async () => {
  const { db, env } = fixture()
  vi.spyOn(AmazonUS.prototype, 'searchListingsItems').mockResolvedValue({} as never)
  let calls = 0
  vi.spyOn(AmazonUS.prototype, 'performanceOrders').mockImplementation(async () => {
    if (++calls <= 7) throw new PublicError('SOURCE_THROTTLED', 'quota busy', 429, 'amazon', true, 19)
    return { orders: [] }
  })
  const sleep = vi.fn(async () => {
    expect(db.prepare('SELECT through_at FROM performance_sync_state').get()?.through_at).toBeNull()
    expect(db.prepare('SELECT status FROM performance_sync_runs').get()?.status).toBe('running')
  })
  try {
    const run = await launchPerformanceSync(env, now)
    await performanceSyncWorkflow(env, { ...step, sleep } as unknown as WorkflowStep, run!.id)
    expect(calls).toBe(8)
    expect(sleep).toHaveBeenCalledTimes(7)
    expect(sleep.mock.calls[0]).toEqual(['performance-quota-1-0', '20 seconds'])
    expect(db.prepare('SELECT status,error FROM performance_sync_runs').get()).toMatchObject({
      status: 'complete',
      error: null,
    })
  } finally {
    db.close()
  }
})

it('does a 24-hour reconciliation only on the first successful window of a new Pacific day', async () => {
  const { db, env } = fixture()
  vi.spyOn(AmazonUS.prototype, 'searchListingsItems').mockResolvedValue({} as never)
  vi.spyOn(AmazonUS.prototype, 'performanceOrders').mockResolvedValue({ orders: [] })
  try {
    const before = Date.parse('2026-11-18T07:30:00Z')
    const first = await launchPerformanceSync(env, before)
    await performanceSyncWorkflow(env, step, first!.id)
    const midnight = await launchPerformanceSync(env, Date.parse('2026-11-18T08:30:00Z'))
    expect(Date.parse(midnight!.from_at)).toBe(Date.parse(first!.through_at) - 86400000)
    await performanceSyncWorkflow(env, step, midnight!.id)
    const next = await launchPerformanceSync(env, Date.parse('2026-11-18T09:00:00Z'))
    expect(Date.parse(next!.from_at)).toBe(Date.parse(midnight!.through_at) - 3600000)
  } finally {
    db.close()
  }
})

it('rejects repeated page tokens without publishing complete coverage', async () => {
  const { db, env } = fixture()
  vi.spyOn(AmazonUS.prototype, 'searchListingsItems').mockResolvedValue({} as never)
  vi.spyOn(AmazonUS.prototype, 'performanceOrders').mockResolvedValue({
    orders: [],
    pagination: { nextToken: 'same' },
  })
  try {
    const run = await launchPerformanceSync(env, now)
    await expect(performanceSyncWorkflow(env, step, run!.id)).rejects.toThrow(/分页/)
    expect(db.prepare('SELECT through_at FROM performance_sync_state').get()?.through_at).toBeNull()
  } finally {
    db.close()
  }
})

it('refuses an old run after credentials change and scopes the new baseline to the new connection', async () => {
  const { db, env } = fixture()
  const api = vi.spyOn(AmazonUS.prototype, 'performanceOrders')
  try {
    const first = await launchPerformanceSync(env, now)
    const original = (await sourceConnection(env)).identity.revision
    env.SP_REFRESH_TOKEN = 'rotated'
    await expect(performanceSyncWorkflow(env, step, first!.id)).rejects.toThrow(
      'SOURCE_CONNECTION_CHANGED',
    )
    expect(api).not.toHaveBeenCalled()
    const second = await launchPerformanceSync(env, now + 3600000)
    expect(second?.connection_revision).not.toBe(original)
    expect(second?.basis).toBe('created')
  } finally {
    db.close()
  }
})

it('does not enable synchronization without a saved seller and valid credentials', async () => {
  const { db, env } = investigationFixture()
  try {
    expect(await launchPerformanceSync(env, now)).toBeNull()
  } finally {
    db.close()
  }
})

it('recovers a queued database claim if workflow creation was interrupted', async () => {
  const { db, env, create } = fixture()
  try {
    const run = await launchPerformanceSync(env, now)
    vi.spyOn(env.RUNNER, 'get').mockRejectedValue(new Error('instance not found'))
    const recovered = await launchPerformanceSync(env, now + 180000)
    expect(recovered?.id).toBe(run?.id)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0].id).toBe(run?.id)
  } finally {
    db.close()
  }
})

it('keeps an uncertain workflow creation claimed instead of failing a potentially running instance', async () => {
  const { db, env, create } = fixture()
  try {
    create.mockRejectedValueOnce(new Error('lost create response'))
    vi.spyOn(env.RUNNER, 'get').mockRejectedValue(new Error('temporary status outage'))
    const run = await launchPerformanceSync(env, now)
    expect(run?.status).toBe('queued')
    expect(db.prepare('SELECT status FROM performance_sync_runs').get()?.status).toBe('queued')
    expect((await launchPerformanceSync(env, now + 180000))?.id).toBe(run?.id)
    expect(create).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})
