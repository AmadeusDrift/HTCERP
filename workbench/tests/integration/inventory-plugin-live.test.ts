import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { receiveFile } from '../../packages/inventory-sync/receive-file'

const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const rows = [
  { rowId: 'r1', sku: 'SKU,"JIT"', binCode: 'Default', quantity: 1, disposition: 'GOOD' as const },
]
const owner = 'tab:1:document:one'
async function harness(existing?: any) {
  const file = await receiveFile(rows)
  const job: any = {
    id: 'j1',
    leaseId: 'lease1',
    mode: 'REAL_TRIAL',
    state: 'CLAIMED',
    rows,
    warehouseCode: 'A1C5',
    expiresAt: Date.now() + 600000,
    filename: 'receive-j1.csv',
    ...file,
  }
  let state = existing || { token: 'private', scope: { warehouseCode: 'A1C5' } }
  let offline = false
  let conflict = false
  let claimResponse: any
  const calls: any[] = []
  let tail = Promise.resolve()
  const context: any = { TextEncoder, Date }
  runInNewContext(readFileSync(new URL('live-connector.js', directory), 'utf8'), context)
  const connector = context.SellerFlexLiveConnector.create({
    serial: (task: any) => {
      const result = tail.then(task)
      tail = result.catch(() => {})
      return result
    },
    read: async () => structuredClone(state),
    save: async (value: any) => {
      state = structuredClone(value)
    },
    crypto: webcrypto,
    manifest: async (value: any) => ({ ...(await receiveFile(value.rows)), mode: 'SIMULATION' }),
    request: async (_state: any, path: string, body: any) => {
      calls.push({ path, body, persisted: structuredClone(state) })
      if (path === 'live/results') {
        if (offline) throw new Error('offline')
        if (conflict) throw Object.assign(new Error('stale lease'), { status: 409 })
        return { accepted: true, job: { id: job.id, state: 'SUCCEEDED' } }
      }
      if (path === 'live/prepare') return { job: structuredClone(job) }
      if (path === 'automatic/claim') return { job: null }
      if (path === 'live/claim') return structuredClone(claimResponse ?? { job })
      return { accepted: true }
    },
  })
  return {
    connector,
    job,
    calls,
    state: () => state,
    offline: (value: boolean) => {
      offline = value
    },
    conflict: () => {
      conflict = true
    },
    claimResponse: (value: any) => {
      claimResponse = value
    },
  }
}

it('persists dispatch before returning one bounded CSV permit; competing tabs cannot reupload', async () => {
  const h = await harness()
  await h.connector.poll()
  const permits = await Promise.all([
    h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner),
    h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, 'tab:2'),
  ])
  expect(permits.filter((p: any) => p.job.csv)).toHaveLength(1)
  expect(h.state().live.stage).toBe('DISPATCHING')
  expect(h.calls.find((c) => c.path === 'live/prepare').persisted.live.stage).toBe('PREPARING')
  expect(permits[0].job.sha256).toBe((await receiveFile(rows)).sha256)
  expect(JSON.stringify(permits)).not.toContain('private')
  const restarted = await harness(h.state())
  expect((await restarted.connector.poll()).needsReconciliation).toBe(true)
  expect(
    (await restarted.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)).job.csv,
  ).toBeUndefined()
  expect(restarted.calls.filter((c) => c.path === 'live/prepare')).toHaveLength(0)
})

it('rejects mismatched warehouse, hash and oversized trial before granting upload', async () => {
  for (const mutation of [
    { warehouseCode: 'OTHER' },
    { sha256: '0'.repeat(64) },
    { rows: [rows[0], { ...rows[0], rowId: 'r2' }, { ...rows[0], rowId: 'r3' }] },
  ]) {
    const h = await harness()
    await h.connector.poll()
    Object.assign(h.job, mutation)
    await expect(h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)).rejects.toThrow()
    expect(h.state().live.stage).toBe('PREPARING')
  }
})

it('persists result before network, replays the identical event after lost acknowledgement, and forbids reupload', async () => {
  const h = await harness()
  await h.connector.poll()
  const { job } = await h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)
  h.offline(true)
  const result = {
    jobId: job.id,
    leaseId: job.leaseId,
    filename: job.filename,
    sha256: job.sha256,
    warehouseCode: job.warehouseCode,
    status: 'UNKNOWN',
    errorCount: null,
    evidence: { rowText: 'No matching row', observedAt: Date.now() },
  }
  await expect(h.connector.results(result)).rejects.toThrow()
  const first = h.calls.find((c) => c.path === 'live/results')
  expect(first.persisted.live.pending).toEqual(first.body)
  const restarted = await harness(h.state())
  await restarted.connector.poll()
  expect(restarted.calls.find((c) => c.path === 'live/results').body).toEqual(first.body)
  expect(restarted.state().live.pending).toBeNull()
  expect(
    (await restarted.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)).job.csv,
  ).toBeUndefined()
})

it('rejects reports that contradict the persisted manifest', async () => {
  const h = await harness()
  await h.connector.poll()
  const { job } = await h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)
  await expect(
    h.connector.results({
      jobId: job.id,
      leaseId: job.leaseId,
      filename: job.filename,
      sha256: 'wrong',
      warehouseCode: 'A1C5',
      status: 'COMPLETED',
      errorCount: 0,
      evidence: { rowText: 'Completed 0', observedAt: Date.now() },
    }),
  ).rejects.toThrow()
  expect(h.calls.filter((c) => c.path === 'live/results')).toHaveLength(0)
})

it('never retries a prepare call after a crash at the PREPARING latch', async () => {
  const h = await harness()
  await h.connector.poll()
  h.state().live.stage = 'PREPARING'
  const restarted = await harness(h.state())
  expect((await restarted.connector.poll()).needsReconciliation).toBe(true)
  expect(
    (await restarted.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)).job.csv,
  ).toBeUndefined()
  expect(restarted.calls.filter((c) => c.path === 'live/prepare')).toHaveLength(0)
})

it('releases a server-skipped preflight without ever granting CSV or claiming an upload occurred', async () => {
  const h = await harness()
  await h.connector.poll()
  Object.assign(h.job, { state: 'SKIPPED', rows: [], csv: undefined, sha256: null, filename: null })
  const response = await h.connector.prepare({ jobId: 'j1', leaseId: 'lease1' }, owner)
  expect(response.job.csv).toBeUndefined()
  expect(h.state().live.stage).toBe('ACKNOWLEDGED')
  expect(h.calls.filter((c) => c.path === 'live/results')).toHaveLength(0)
})

it('replaces an expired unsubmitted CLAIMED or PREPARING job only with matching server proof', async () => {
  for (const stage of ['CLAIMED', 'PREPARING']) {
    const h = await harness()
    await h.connector.poll()
    h.state().live.stage = stage
    const restarted = await harness(h.state())
    restarted.claimResponse({
      job: { ...h.job, id: 'j2', leaseId: 'lease2', filename: 'receive-j2.csv' },
      previousJob: { id: 'j1', leaseId: 'lease1', state: 'EXPIRED', submitted: false },
    })
    const work = await restarted.connector.poll()
    expect(restarted.calls.find((call) => call.path === 'live/claim').body).toEqual({
      previousJobId: 'j1',
      previousLeaseId: 'lease1',
    })
    expect(work).toMatchObject({ job: { id: 'j2' }, needsReconciliation: false })
    expect(restarted.state().live.stage).toBe('CLAIMED')
    expect(restarted.state().live.priorRetirementProof).toEqual({
      id: 'j1',
      leaseId: 'lease1',
      state: 'EXPIRED',
      submitted: false,
    })
    expect(restarted.calls.filter((call) => call.path === 'live/prepare')).toHaveLength(0)
  }
})

it('can retire a proven expired unsubmitted job even when there is no replacement work', async () => {
  const h = await harness()
  await h.connector.poll()
  h.state().live.stage = 'PREPARING'
  h.claimResponse({
    job: null,
    previousJob: { id: 'j1', leaseId: 'lease1', state: 'EXPIRED', submitted: false },
  })
  expect(await h.connector.poll()).toEqual({ job: null })
  expect(h.state().live.stage).toBe('ACKNOWLEDGED')
  expect(h.state().live.job.state).toBe('EXPIRED')
  expect(h.state().live.retirementProof).toEqual({
    id: 'j1',
    leaseId: 'lease1',
    state: 'EXPIRED',
    submitted: false,
  })
  expect(h.calls.filter((call) => call.path === 'live/prepare')).toHaveLength(0)
})

it('rejects a replacement without exact unsubmitted-expired proof and retains the old latch', async () => {
  const badProofs = [
    undefined,
    { id: 'other', leaseId: 'lease1', state: 'EXPIRED', submitted: false },
    { id: 'j1', leaseId: 'other', state: 'EXPIRED', submitted: false },
    { id: 'j1', leaseId: 'lease1', state: 'CLAIMED', submitted: false },
    { id: 'j1', leaseId: 'lease1', state: 'EXPIRED', submitted: true },
    { id: 'j1', leaseId: 'lease1', state: 'EXPIRED' },
  ]
  for (const previousJob of badProofs) {
    const h = await harness()
    await h.connector.poll()
    h.state().live.stage = 'PREPARING'
    const before = structuredClone(h.state())
    h.claimResponse({ job: { ...h.job, id: 'j2', leaseId: 'lease2' }, previousJob })
    await expect(h.connector.poll()).rejects.toThrow()
    expect(h.state()).toEqual(before)
  }
})

it('never replaces a possible upload even if the server returns an expiry proof', async () => {
  for (const stage of ['DISPATCHING', 'DISPATCHED', 'SUBMITTING', 'UNKNOWN']) {
    const h = await harness()
    await h.connector.poll()
    h.state().live.stage = stage
    const before = structuredClone(h.state())
    h.claimResponse({
      job: { ...h.job, id: 'j2', leaseId: 'lease2' },
      previousJob: { id: 'j1', leaseId: 'lease1', state: 'EXPIRED', submitted: false },
    })
    await expect(h.connector.poll()).rejects.toThrow()
    expect(h.state()).toEqual(before)
  }
})

it('recovers a lost SKIPPED preflight response using the same unsubmitted terminal proof', async () => {
  for (const replacement of [false, true]) {
    const h = await harness()
    await h.connector.poll()
    h.state().live.stage = 'PREPARING'
    h.claimResponse({
      job: replacement ? { ...h.job, id: 'j2', leaseId: 'lease2', filename: 'receive-j2.csv' } : null,
      previousJob: { id: 'j1', leaseId: 'lease1', state: 'SKIPPED', submitted: false },
    })
    const result = await h.connector.poll()
    expect(result.job?.id ?? null).toBe(replacement ? 'j2' : null)
    expect(h.state().live.stage).toBe(replacement ? 'CLAIMED' : 'ACKNOWLEDGED')
    expect(h.calls.filter((call) => call.path === 'live/prepare')).toHaveLength(0)
  }
})

it('never uses a submitted SKIPPED proof or releases a possible upload with SKIPPED proof', async () => {
  for (const [stage, submitted] of [
    ['PREPARING', true],
    ['DISPATCHING', false],
    ['UNKNOWN', false],
  ]) {
    const h = await harness()
    await h.connector.poll()
    h.state().live.stage = stage
    const before = structuredClone(h.state())
    h.claimResponse({
      job: { ...h.job, id: 'j2', leaseId: 'lease2' },
      previousJob: { id: 'j1', leaseId: 'lease1', state: 'SKIPPED', submitted },
    })
    await expect(h.connector.poll()).rejects.toThrow()
    expect(h.state()).toEqual(before)
  }
})

it('archives entire transferred live evidence despite a stale receipt 409 and permits a same-job fresh lease', async () => {
  const h = await harness()
  await h.connector.poll()
  Object.assign(h.state(), { deviceId: 'a'.repeat(64), baseUrl: 'https://htcerp.app' })
  Object.assign(h.state().live, {
    stage: 'DISPATCHED',
    owner,
    pending: { eventId: 'old-receipt' },
    lastReceipt: { eventId: 'previous-receipt' },
  })
  const old = structuredClone(h.state().live)
  const proof = {
    id: 'j1',
    leaseId: 'lease1',
    state: 'TRANSFERRED',
    submitted: true,
    newDeviceId: 'b'.repeat(64),
  }
  h.conflict()
  h.claimResponse({
    job: { ...h.job, leaseId: 'lease-new', state: 'SUBMITTING', needsReconciliation: true },
    previousJob: proof,
  })
  expect((await h.connector.poll()).needsReconciliation).toBe(true)
  expect(h.state().archivedLive[0]).toMatchObject({ live: old, deviceId: 'a'.repeat(64), proof })
  expect(h.state().live.job.leaseId).toBe('lease-new')
  expect(
    (await h.connector.prepare({ jobId: 'j1', leaseId: 'lease-new' }, owner)).job.csv,
  ).toBeUndefined()
  await expect(h.connector.dispatched({ jobId: 'j1', leaseId: 'lease1' }, owner)).rejects.toThrow()
})
it('requests transfer proof even for ACKNOWLEDGED WAITING_API receipts', async () => {
  const h = await harness()
  await h.connector.poll()
  Object.assign(h.state(), { deviceId: 'a'.repeat(64) })
  h.state().live.stage = 'ACKNOWLEDGED'
  h.state().live.lastReceipt = { status: 'COMPLETED' }
  h.claimResponse({
    job: null,
    previousJob: {
      id: 'j1',
      leaseId: 'lease1',
      state: 'TRANSFERRED',
      submitted: true,
      newDeviceId: 'b'.repeat(64),
    },
  })
  expect(await h.connector.poll()).toEqual({ job: null })
  expect(h.calls.findLast((call) => call.path === 'live/claim').body).toEqual({
    previousJobId: 'j1',
    previousLeaseId: 'lease1',
  })
  expect(h.state().archivedLive[0].live.lastReceipt.status).toBe('COMPLETED')
  expect(h.state().live).toBeNull()
})
it('does not release evidence for wrong transfer proof, full archive, or generic replay error', async () => {
  for (const bad of ['lease', 'job', 'target', 'self', 'submitted', 'capacity', 'offline']) {
    const h = await harness()
    await h.connector.poll()
    Object.assign(h.state(), { deviceId: 'a'.repeat(64) })
    Object.assign(h.state().live, { stage: 'UNKNOWN', pending: { eventId: 'keep' } })
    const proof: any = {
      id: 'j1',
      leaseId: 'lease1',
      state: 'TRANSFERRED',
      submitted: true,
      newDeviceId: 'b'.repeat(64),
    }
    if (bad === 'lease') proof.leaseId = 'wrong'
    if (bad === 'job') proof.id = 'wrong'
    if (bad === 'target') proof.newDeviceId = ''
    if (bad === 'self') proof.newDeviceId = 'a'.repeat(64)
    if (bad === 'submitted') delete proof.submitted
    if (bad === 'capacity') h.state().archivedLive = Array.from({ length: 10 }, (_, i) => ({ id: i }))
    if (bad === 'offline') h.offline(true)
    else h.conflict()
    const before = structuredClone(h.state())
    h.claimResponse({ job: null, previousJob: proof })
    await expect(h.connector.poll()).rejects.toThrow()
    expect(h.state()).toEqual(before)
  }
})
it('keeps transferred issued CSV watch-only even if a replacement advertises CLAIMED', async () => {
  const h = await harness()
  await h.connector.poll()
  Object.assign(h.state(), { deviceId: 'a'.repeat(64) })
  h.state().live.stage = 'DISPATCHING'
  h.claimResponse({
    job: { ...h.job, leaseId: 'lease-new' },
    previousJob: {
      id: 'j1',
      leaseId: 'lease1',
      state: 'TRANSFERRED',
      submitted: true,
      newDeviceId: 'b'.repeat(64),
    },
  })
  await h.connector.poll()
  expect(
    (await h.connector.prepare({ jobId: 'j1', leaseId: 'lease-new' }, owner)).job.csv,
  ).toBeUndefined()
})
it('accepts fresh same-job lease after a proven unsubmitted PREPARING handoff', async () => {
  const h = await harness()
  await h.connector.poll()
  Object.assign(h.state(), { deviceId: 'a'.repeat(64) })
  h.state().live.stage = 'PREPARING'
  h.job.leaseId = 'lease-new'
  h.claimResponse({
    job: h.job,
    previousJob: {
      id: 'j1',
      leaseId: 'lease1',
      state: 'TRANSFERRED',
      submitted: false,
      newDeviceId: 'b'.repeat(64),
    },
  })
  expect((await h.connector.poll()).needsReconciliation).toBe(false)
  expect((await h.connector.prepare({ jobId: 'j1', leaseId: 'lease-new' }, owner)).job.csv).toBeTruthy()
})
