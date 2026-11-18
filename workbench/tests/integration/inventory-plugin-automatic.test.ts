import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { receiveFile } from '../../packages/inventory-sync/receive-file'

const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const owner = 'tab:1:document:one'
const identity = (job: any) => ({ jobId: job.id, leaseId: job.leaseId })
async function harness(existing?: any, count = 10) {
  const rows = Array.from({ length: count }, (_, i) => ({
    rowId: `r${i}`,
    sku: `SKU-${i}-JIT`,
    binCode: 'Default',
    quantity: 5,
    disposition: 'GOOD' as const,
  }))
  const job: any = {
    id: 'auto1',
    leaseId: 'lease1',
    mode: 'AUTO_REPLENISH',
    state: 'CLAIMED',
    rows,
    warehouseCode: 'A1C5',
    expiresAt: Date.now() + 600000,
    filename: 'receive-auto1.csv',
    ...(await receiveFile(rows)),
  }
  let state = existing || { token: 'private', scope: { warehouseCode: 'A1C5' } }
  const calls: any[] = []
  const replies: any = {}
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
    manifest: async (value: any) => receiveFile(value.rows),
    request: async (_state: any, path: string, body: any) => {
      calls.push({ path, body, persisted: structuredClone(state) })
      if (Object.hasOwn(replies, path)) {
        if (replies[path] instanceof Error) throw replies[path]
        return typeof replies[path] === 'function' ? replies[path](body) : structuredClone(replies[path])
      }
      if (path === 'live/claim') return { job: null }
      if (path === 'automatic/claim') return { job: structuredClone(job) }
      if (path.endsWith('/prepare')) return { job: structuredClone(job) }
      if (path.endsWith('/results'))
        return {
          accepted: true,
          job: { id: body.jobId },
          receipt: {
            id: body.jobId,
            leaseId: body.leaseId,
            eventId: body.eventId,
            state: 'RECORDED',
            submitted: true,
          },
        }
      return { accepted: true }
    },
  })
  const result = (status = 'COMPLETED') => ({
    ...identity(job),
    filename: job.filename,
    sha256: job.sha256,
    warehouseCode: job.warehouseCode,
    status,
    errorCount: status === 'COMPLETED' ? 0 : null,
    evidence: { rowText: status, observedAt: Date.now() },
  })
  return { connector, job, calls, replies, state: () => state, result }
}
it('polls manual first then grants exactly one checked automatic 10-row permit across competing tabs', async () => {
  const h = await harness()
  expect((await h.connector.poll()).job.mode).toBe('AUTO_REPLENISH')
  expect(h.calls.map((c) => c.path)).toEqual(['live/claim', 'automatic/claim'])
  const permits = await Promise.all([
    h.connector.prepare(identity(h.job), owner),
    h.connector.prepare(identity(h.job), 'tab:2:document:two'),
  ])
  expect(permits.filter((p) => p.job.csv)).toHaveLength(1)
  expect(permits[0].ownedFile).toMatchObject({
    filename: h.job.filename,
    sha256: h.job.sha256,
    owner,
    size: new TextEncoder().encode(h.job.csv).length,
  })
  expect(h.calls.find((c) => c.path === 'automatic/prepare').persisted.live.stage).toBe('PREPARING')
  const restart = await harness(h.state())
  expect((await restart.connector.poll()).needsReconciliation).toBe(true)
  expect((await restart.connector.prepare(identity(h.job), owner)).job.csv).toBeUndefined()
})
it('rejects 11-row automatic batches and mismatched CSV checksum without releasing PREPARING', async () => {
  const oversized = await harness(undefined, 11)
  await expect(oversized.connector.poll()).rejects.toThrow()
  const h = await harness()
  await h.connector.poll()
  h.job.csv += 'tampered'
  await expect(h.connector.prepare(identity(h.job), owner)).rejects.toThrow()
  expect(h.state().live.stage).toBe('PREPARING')
})
it('replays lost automatic receipt verbatim on restart, releases UNKNOWN, and advances without full archives', async () => {
  const h = await harness()
  await h.connector.poll()
  await h.connector.prepare(identity(h.job), owner)
  h.replies['automatic/results'] = new Error('lost ack')
  await expect(h.connector.results(h.result('UNKNOWN'))).rejects.toThrow()
  const pending = structuredClone(h.state().live.pending)
  const restart = await harness(h.state())
  restart.job.id = 'auto2'
  restart.job.leaseId = 'lease2'
  restart.job.filename = 'receive-auto2.csv'
  const work = await restart.connector.poll()
  expect(restart.calls.find((c) => c.path === 'automatic/results').body).toEqual(pending)
  expect(work.job.id).toBe('auto2')
  expect(work.needsReconciliation).toBe(false)
  expect(work.cleanupProof.receipt.eventId).toBe(pending.eventId)
  expect(work.cleanupProof.ownedFile.filename).toBe('receive-auto1.csv')
  expect(restart.state().archivedLive || []).toHaveLength(0)
  expect(restart.state().lastAutomaticReceipt.receipt.state).toBe('RECORDED')
})
it('uses only exact RECORDED event proof when receipt replay fails', async () => {
  for (const wrong of ['', 'id', 'leaseId', 'eventId', 'submitted', 'state']) {
    const h = await harness()
    await h.connector.poll()
    await h.connector.prepare(identity(h.job), owner)
    h.replies['automatic/results'] = new Error('lost ack')
    await expect(h.connector.results(h.result())).rejects.toThrow()
    const before = structuredClone(h.state())
    const proof: any = {
      id: h.job.id,
      leaseId: h.job.leaseId,
      eventId: before.live.pending.eventId,
      state: 'RECORDED',
      submitted: true,
    }
    if (wrong) proof[wrong] = wrong === 'submitted' ? false : 'wrong'
    h.replies['automatic/claim'] = {
      job: { ...h.job, id: 'auto2', leaseId: 'lease2' },
      previousJob: proof,
    }
    if (wrong) {
      await expect(h.connector.poll()).rejects.toThrow()
      expect(h.state()).toEqual(before)
    } else {
      expect((await h.connector.poll()).job.id).toBe('auto2')
      expect(h.state().live.pending).toBeNull()
    }
  }
})
it('rejects an inexact automatic result ack and never resubmits the same acknowledged batch', async () => {
  const h = await harness()
  await h.connector.poll()
  await h.connector.prepare(identity(h.job), owner)
  h.replies['automatic/results'] = {
    accepted: true,
    job: { id: h.job.id },
    receipt: {
      id: h.job.id,
      leaseId: h.job.leaseId,
      eventId: 'wrong',
      state: 'RECORDED',
      submitted: true,
    },
  }
  await expect(h.connector.results(h.result())).rejects.toThrow()
  delete h.replies['automatic/results']
  const work = await h.connector.poll()
  expect(work.job).toBeNull()
  expect((await h.connector.prepare(identity(h.job), owner)).job.csv).toBeUndefined()
  expect(h.calls.filter((c) => c.path === 'automatic/prepare')).toHaveLength(1)
})
it('acknowledged old trials move to automatic but UNKNOWN trials remain on their protocol', async () => {
  for (const stage of ['ACKNOWLEDGED', 'UNKNOWN']) {
    const h = await harness({
      token: 'private',
      scope: { warehouseCode: 'A1C5' },
      live: {
        job: {
          id: 'trial1',
          leaseId: 'trial-lease',
          mode: 'REAL_TRIAL',
          rows: [],
          warehouseCode: 'A1C5',
        },
        stage,
      },
    })
    const work = await h.connector.poll()
    expect(work.job.id).toBe(stage === 'ACKNOWLEDGED' ? 'auto1' : 'trial1')
    expect(h.calls.some((c) => c.path === 'automatic/claim')).toBe(stage === 'ACKNOWLEDGED')
  }
})
it('allows zero-row SKIPPED automatic prepare and preserves durable PREPARING after uncertain prepare', async () => {
  const h = await harness()
  await h.connector.poll()
  h.replies['automatic/prepare'] = {
    job: { ...h.job, state: 'SKIPPED', rows: [], csv: undefined, filename: null, sha256: null },
  }
  expect((await h.connector.prepare(identity(h.job), owner)).job.csv).toBeUndefined()
  expect(h.state().live.stage).toBe('ACKNOWLEDGED')
  const h2 = await harness()
  await h2.connector.poll()
  h2.replies['automatic/prepare'] = new Error('timeout')
  await expect(h2.connector.prepare(identity(h2.job), owner)).rejects.toThrow()
  expect(h2.state().live.stage).toBe('PREPARING')
  const restart = await harness(h2.state())
  expect((await restart.connector.prepare(identity(h2.job), owner)).job.csv).toBeUndefined()
  expect(restart.calls).toHaveLength(0)
})
it('retains separate compact file proofs for two tabs and removes only an exact clearing acknowledgement', async () => {
  const h = await harness()
  await h.connector.poll()
  await h.connector.prepare(identity(h.job), owner)
  await h.connector.results(h.result())
  const first = structuredClone(h.state().lastAutomaticReceipt)
  h.job.id = 'auto2'
  h.job.leaseId = 'lease2'
  h.job.filename = 'receive-auto2.csv'
  await h.connector.poll()
  await h.connector.prepare(identity(h.job), 'tab:2:document:two')
  await h.connector.results(h.result())
  expect(Object.keys(h.state().automaticCleanup)).toHaveLength(2)
  await expect(h.connector.cleared(first.receipt, 'tab:2:document:two')).rejects.toThrow()
  await expect(
    h.connector.cleared({ ...first.receipt, eventId: 'wrong' }, 'tab:1:document:new'),
  ).rejects.toThrow()
  await h.connector.cleared(first.receipt, 'tab:1:document:new')
  expect(Object.keys(h.state().automaticCleanup)).toEqual(['tab:2'])
  expect(h.state().lastAutomaticReceipt.receipt.id).toBe('auto2')
})
it('progresses more than ten normal batches without filling transfer archives', async () => {
  const h = await harness()
  for (let i = 0; i < 12; i++) {
    h.job.id = `auto${i}`
    h.job.leaseId = `lease${i}`
    h.job.filename = `receive-auto${i}.csv`
    await h.connector.poll()
    await h.connector.prepare(identity(h.job), owner)
    await h.connector.results(h.result(i % 2 ? 'UNKNOWN' : 'COMPLETED'))
  }
  expect(h.state().archivedLive || []).toHaveLength(0)
  expect(Object.keys(h.state().automaticCleanup)).toHaveLength(1)
  expect(h.state().lastAutomaticReceipt.receipt.id).toBe('auto11')
})
it('reports the active execution mode and allows automatic prepare up to sixty seconds', async () => {
  const timeouts: number[] = []
  const state: any = {
    token: 'private',
    baseUrl: 'https://htcerp.app',
    live: { job: { id: 'auto1', mode: 'AUTO_REPLENISH' }, stage: 'PREPARING' },
  }
  const context: any = {
    URL,
    TextEncoder,
    AbortSignal: {
      timeout: (ms: number) => {
        timeouts.push(ms)
        return undefined
      },
    },
  }
  runInNewContext(readFileSync(new URL('connector.js', directory), 'utf8'), context)
  const connector = context.SellerFlexConnector.create({
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async () => ({ 'sf-erp-v2': state }),
          set: async () => {},
        },
      },
      alarms: { get: async () => ({}) },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    crypto: webcrypto,
    liveFactory: ({ request, read }: any) => ({
      prepare: async () => request(await read(), 'automatic/prepare', {}),
    }),
  })
  expect((await connector.status()).mode).toBe('AUTO_REPLENISH')
  expect((await connector.status()).liveTrial.mode).toBe('AUTO_REPLENISH')
  await connector.live.prepare()
  expect(timeouts).toEqual([60000])
})
it('does not recreate a consumed file cleanup proof on repeated durable claim proofs', async () => {
  const h = await harness()
  await h.connector.poll()
  await h.connector.prepare(identity(h.job), owner)
  await h.connector.results(h.result())
  const proof = structuredClone(h.state().lastAutomaticReceipt.receipt)
  await h.connector.cleared(proof, owner)
  h.replies['automatic/claim'] = { job: null, previousJob: proof }
  await h.connector.poll()
  expect(h.state().automaticCleanup).toEqual({})
})
it('does not accept wrong identity or mode in a reconciliation-only prepare response', async () => {
  for (const mutation of [{ id: 'wrong' }, { leaseId: 'wrong' }, { mode: 'REAL_TRIAL', rows: [] }]) {
    const h = await harness()
    await h.connector.poll()
    h.replies['automatic/prepare'] = {
      job: { ...h.job, ...mutation, csv: undefined },
      needsReconciliation: true,
    }
    await expect(h.connector.prepare(identity(h.job), owner)).rejects.toThrow()
    expect(h.state().live.stage).toBe('PREPARING')
    expect(h.state().live.job.id).toBe('auto1')
  }
})
