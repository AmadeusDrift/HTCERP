import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { receiveFile } from '../../packages/inventory-sync/receive-file'

const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const rows = [
  {
    rowId: 'r1',
    sku: 'SKU,"JIT"',
    binCode: 'Default',
    quantity: 2,
    disposition: 'GOOD' as const,
    expiryDate: '2027-02-28',
  },
]
const job = { id: 'j1', nonce: 'nonce-1', mode: 'SIMULATION', rows }

it('automatically splits valid large Receive CSVs into deterministic files with at most 3000 records', async () => {
  const inspect = runInNewContext(
    readFileSync(new URL('preflight.js', directory), 'utf8') + '\nInventoryFiles.inspect',
    { File, TextDecoder, TextEncoder, crypto: webcrypto },
  ) as (file: File, mode: string) => Promise<{
    rows: number; hash: string; issueCount: number; parts?: { file: File; rows: number; hash: string }[]
  }>
  const header = (await receiveFile(rows)).csv.split('\r\n')[0]
  const record = 'Default,"SKU,quoted ""name""",1,GOOD,,'
  const original = new File([[header, ...Array(100005).fill(record), ''].join('\r\n')], 'inventory.csv')
  const result = await inspect(original, 'receive')
  expect(result).toMatchObject({ rows: 100005, issueCount: 0 })
  expect(result.parts?.map((part) => part.rows)).toEqual([...Array(33).fill(3000), 1005])
  expect(new Set(result.parts?.map((part) => part.hash)).size).toBe(34)
  expect((await inspect(original, 'receive')).parts?.map((part) => part.hash)).toEqual(
    result.parts?.map((part) => part.hash),
  )
  for (const part of result.parts!) {
    expect(await part.file.text()).toBe([header, ...Array(part.rows).fill(record), ''].join('\r\n'))
    const child = await inspect(part.file, 'receive')
    expect(child).toMatchObject({ rows: part.rows, issueCount: 0 })
    expect(child.parts).toBeUndefined()
  }
})
type State = Record<string, any>
function harness(state: State = {}, allowLocalTest = false) {
  const calls: { url: string; body?: any; auth?: string }[] = []
  const results: any[] = []
  const alarms: Record<string, any> = {}
  let offline = false
  let authStatus = 0
  let work: any = job
  let heartbeatMode = 'SIMULATION'
  let ack = { state: 'PASSED', mode: 'SIMULATION' }
  let identity = { deviceId: 'dev1', token: 'private-token' }
  let access = ''
  const chrome = {
    storage: {
      local: {
        setAccessLevel: async ({ accessLevel }: any) => {
          access = accessLevel
        },
        get: async (key: string) => ({ [key]: structuredClone(state[key]) }),
        set: async (value: any) => {
          Object.assign(state, structuredClone(value))
        },
        remove: async (key: string) => {
          delete state[key]
        },
      },
    },
    alarms: {
      get: async (name: string) => alarms[name],
      create: async (name: string, value: any) => {
        alarms[name] = value
      },
    },
  }
  const fetch = async (url: string, options: any) => {
    calls.push({
      url,
      body: options.body ? JSON.parse(options.body) : undefined,
      auth: options.headers.Authorization,
    })
    if (url.endsWith('/pair'))
      return {
        ok: true,
        json: async () => ({
          ...identity,
          mode: 'SIMULATION',
          scope: { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5' },
          pollSeconds: 60,
        }),
      }
    if (!url.endsWith('/pair') && authStatus) return { ok: false, status: authStatus }
    if (url.endsWith('/heartbeat'))
      return { ok: true, json: async () => ({ mode: heartbeatMode, status: 'ACTIVE' }) }
    if (url.endsWith('/work')) return { ok: true, json: async () => ({ job: work }) }
    if (url.endsWith('/results')) {
      results.push(JSON.parse(options.body))
      if (offline) throw new Error('network private-token secret detail')
      work = null
      return { ok: true, json: async () => ack }
    }
    throw new Error('Unexpected URL')
  }
  const context: any = { URL, TextEncoder, crypto: webcrypto, AbortSignal, setTimeout, clearTimeout }
  runInNewContext(readFileSync(new URL('connector.js', directory), 'utf8'), context)
  const connector = context.SellerFlexConnector.create({
    chrome,
    fetch,
    crypto: webcrypto,
    allowLocalTest,
  })
  return {
    connector,
    state,
    calls,
    results,
    alarms,
    identity: (value: typeof identity) => {
      identity = value
    },
    ack: (value: any) => {
      ack = value
    },
    auth: (value: number) => {
      authStatus = value
    },
    access: () => access,
    offline: (value: boolean) => {
      offline = value
    },
    work: (value: any) => {
      work = value
    },
    mode: (value: string) => {
      heartbeatMode = value
    },
  }
}
const pair = (h: ReturnType<typeof harness>, baseUrl = 'https://htcerp.app') =>
  h.connector.pair({ baseUrl, code: 'PAIRCODE', name: 'Edge 仓库' })

it('pairs with scoped SIMULATION and computes exactly the ERP canonical CSV hash', async () => {
  const h = harness()
  await pair(h)
  await h.connector.poll()
  expect(h.access()).toBe('TRUSTED_CONTEXTS')
  expect(h.results).toEqual([
    {
      jobId: job.id,
      nonce: job.nonce,
      sha256: (await receiveFile(rows)).sha256,
      rowCount: 1,
      mode: 'SIMULATION',
    },
  ])
  expect(h.calls[0].body).toEqual({ code: 'PAIRCODE', name: 'Edge 仓库' })
  expect(JSON.stringify(await h.connector.status())).not.toContain('private-token')
  expect(Object.values(h.alarms)).toContainEqual({ periodInMinutes: 1, delayInMinutes: 1 })
})

it('persists before sending, sanitizes offline errors, and replays identical result after worker restart', async () => {
  const h = harness()
  await pair(h)
  h.offline(true)
  await h.connector.poll()
  expect(h.state['sf-erp-v2'].pending).toEqual(h.results[0])
  expect(JSON.stringify(await h.connector.status())).not.toContain('private-token')
  const restarted = harness(h.state)
  await restarted.connector.poll()
  expect(restarted.results[0]).toEqual(h.results[0])
  expect(h.state['sf-erp-v2'].pending).toBeNull()
  expect(restarted.calls.findIndex((c) => c.url.endsWith('/results'))).toBeLessThan(
    restarted.calls.findIndex((c) => c.url.endsWith('/work')),
  )
})

it('rejects REAL work, malformed rows and REAL heartbeat without any result submission', async () => {
  for (const badJob of [
    { ...job, mode: 'REAL' },
    { ...job, rows: [{ ...rows[0], quantity: 0 }] },
    { ...job, rows: [rows[0], rows[0]] },
    { ...job, rows: [{ ...rows[0], disposition: 'BAD' }] },
  ]) {
    const h = harness()
    await pair(h)
    h.work(badJob)
    await h.connector.poll()
    expect(h.results).toHaveLength(0)
    expect((await h.connector.status()).error).toBeTruthy()
  }
  const h = harness()
  await pair(h)
  h.mode('REAL')
  await h.connector.poll()
  expect(h.calls.filter((c) => c.url.endsWith('/work'))).toHaveLength(0)
})

it('serializes overlapping polls and forbids destination changes with a pending result', async () => {
  const h = harness()
  await pair(h)
  h.offline(true)
  await Promise.all([h.connector.poll(), h.connector.poll(), h.connector.poll()])
  expect(h.results).toHaveLength(1)
  await expect(pair(h)).rejects.toThrow()
  expect(h.state['sf-erp-v2'].pending).toBeTruthy()
})

it('restricts production endpoints, permits loopback only with an explicit test harness option', async () => {
  for (const base of [
    'http://127.0.0.1:8787',
    'https://evil.example',
    'https://htcerp.app.evil.example',
    'https://user@htcerp.app',
    'https://htcerp.app/path',
  ]) {
    const h = harness()
    await expect(pair(h, base)).rejects.toThrow()
    expect(h.calls).toHaveLength(0)
  }
  const h = harness({}, true)
  await pair(h, 'http://127.0.0.1:8787')
  expect(h.calls[0].url).toBe('http://127.0.0.1:8787/api/inventory-device/pair')
})

it('does not discard pending evidence when result acknowledgement is not PASSED SIMULATION', async () => {
  const h = harness()
  await pair(h)
  h.ack({ state: 'PASSED', mode: 'REAL' })
  await h.connector.poll()
  expect(h.state['sf-erp-v2'].pending).toEqual(h.results[0])
  expect((await h.connector.status()).error).toBeTruthy()
})

it('restricts content script messages to manual records and does not disclose credentials', async () => {
  const data: State = {
    'sf-erp-v2': { token: 'private-token' },
    'sf-inventory-v1:A1C5:receive:hash': { state: 'complete' },
  }
  let listener: any
  const openedTabs: any[] = []
  const context: any = {
    URL,
    TextEncoder,
    crypto: webcrypto,
    AbortSignal,
    fetch: async (url: string) => {
      if (url.endsWith('/claim')) return { ok: true, json: async () => ({ job: null }) }
      throw new Error('No network expected')
    },
    chrome: {
      tabs: {
        query: async () => [],
        create: async (options: any) => {
          openedTabs.push(options)
        },
      },
      runtime: {
        id: 'extension-id',
        getURL: (path: string) => 'chrome-extension://extension-id/' + path,
        onMessage: {
          addListener: (value: any) => {
            listener = value
          },
        },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
      },
      alarms: { get: async () => ({}), onAlarm: { addListener: () => {} } },
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (key: string) => ({ [key]: data[key] }),
          set: async (value: any) => Object.assign(data, value),
          remove: async (key: string) => {
            delete data[key]
          },
        },
      },
    },
  }
  const vm = createContext(context)
  context.importScripts = (path: string) =>
    runInContext(readFileSync(new URL(path, directory), 'utf8'), vm)
  runInContext(readFileSync(new URL('background.js', directory), 'utf8'), vm)
  const sender = { id: 'extension-id', tab: { id: 1 }, url: 'https://sellerflex.amazon.com/receive' }
  const invoke = (message: any, from = sender) =>
    new Promise<any>((resolve) => {
      const accepted = listener(message, from, resolve)
      if (!accepted) resolve({ rejected: true })
    })
  expect(await invoke({ type: 'erp-status' })).toEqual({ rejected: true })
  expect(await invoke({ type: 'erp-pair', input: {} })).toEqual({ rejected: true })
  expect(await invoke({ type: 'erp-archive-pending' })).toEqual({ rejected: true })
  for (const badSender of [
    { ...sender, frameId: 0, documentId: 'doc', url: 'https://evil.example/receive' },
    { ...sender, frameId: 0, documentId: 'doc', url: 'https://sellerflex.amazon.com/inventory/adjust' },
    { ...sender, frameId: 1, documentId: 'doc' },
    { ...sender, frameId: 0 },
  ])
    expect(await invoke({ type: 'sf-live', operation: 'poll' }, badSender)).toEqual({ rejected: true })
  expect(await invoke({ type: 'sf-manual-storage', operation: 'get', key: 'sf-erp-v2' })).toMatchObject({
    ok: false,
  })
  expect(
    await invoke({
      type: 'sf-manual-storage',
      operation: 'get',
      key: 'sf-inventory-v1:A1C5:receive:hash',
    }),
  ).toMatchObject({ ok: true, value: { 'sf-inventory-v1:A1C5:receive:hash': { state: 'complete' } } })
  expect(
    await invoke(
      { type: 'sf-manual-storage', operation: 'get', key: 'sf-inventory-v1:any' },
      { ...sender, url: 'https://evil.example' },
    ),
  ).toEqual({ rejected: true })
  const publicReply = await invoke({ type: 'erp-status' }, {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/connection.html',
  } as any)
  expect(
    await invoke({ type: 'erp-detect' }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/connection.html',
    } as any),
  ).toMatchObject({ ok: true, value: { status: 'no-tab' } })
  expect(await invoke({ type: 'erp-connect', input: { name: 'No' } })).toEqual({ rejected: true })
  await invoke({ type: 'erp-open' }, {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/connection.html',
  } as any)
  expect(openedTabs).toEqual([{ url: 'https://htcerp.app/settings?tab=inventory' }])
  expect(publicReply.ok).toBe(true)
  expect(JSON.stringify(publicReply)).not.toContain('private-token')
  data['sf-erp-v2'].baseUrl = 'https://htcerp.app'
  data['sf-erp-v2'].lastAutomaticReceipt = {
    receipt: { id: 'auto1', leaseId: 'lease1', eventId: 'event1', state: 'RECORDED', submitted: true },
    ownedFile: {
      owner: 'tab:1:document:previous',
      filename: 'receive-auto1.csv',
      sha256: 'a'.repeat(64),
      size: 20,
      lastModified: 123,
    },
  }
  data['sf-erp-v2'].automaticCleanup = { 'tab:1': data['sf-erp-v2'].lastAutomaticReceipt }
  const own = await invoke({ type: 'sf-live', operation: 'poll' }, {
    ...sender,
    frameId: 0,
    documentId: 'new',
  } as any)
  expect(own.value.cleanupProof.receipt.eventId).toBe('event1')
  const other = await invoke({ type: 'sf-live', operation: 'poll' }, {
    ...sender,
    tab: { id: 10 },
    frameId: 0,
    documentId: 'other',
  } as any)
  expect(other.value.cleanupProof).toBeUndefined()
})

it('ships no localhost or broad browser permissions in the trial-capable extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
  expect(manifest.content_scripts[1]).toMatchObject({
    matches: ['https://htcerp.app/*'],
    js: ['erp-relay.js'],
    all_frames: false,
  })
  expect(manifest.permissions).toEqual(['storage', 'alarms'])
  expect(manifest.host_permissions).toEqual(['https://htcerp.app/*'])
  expect(manifest.content_scripts.map(({ matches }: { matches: string[] }) => matches)).toEqual([
    ['https://sellerflex.amazon.com/*'],
    ['https://htcerp.app/*'],
    ['https://sellerflex.amazon.com/*'],
  ])
  expect(readFileSync(new URL('background.js', directory), 'utf8')).toContain(
    'const LOCAL_TEST = false;',
  )
})

it('archives a revoked device receipt only on explicit recovery and never replays it under a new pairing', async () => {
  const h = harness()
  await pair(h)
  h.offline(true)
  await h.connector.poll()
  const pending = structuredClone(h.state['sf-erp-v2'].pending)
  await expect(h.connector.archivePending()).rejects.toThrow()
  h.auth(401)
  await h.connector.poll()
  expect((await h.connector.status()).recoveryAvailable).toBe(true)
  await expect(pair(h)).rejects.toThrow()
  const recovered = await h.connector.archivePending()
  expect(recovered.connected).toBe(false)
  expect(recovered.archivedReceiptCount).toBe(1)
  expect(h.state['sf-erp-v2'].pending).toBeUndefined()
  expect(h.state['sf-erp-v2'].token).toBeUndefined()
  expect(h.state['sf-erp-v2'].archivedReceipts[0]).toMatchObject({
    deviceId: 'dev1',
    baseUrl: 'https://htcerp.app',
    receipt: pending,
    reason: 'AUTH_REVOKED',
  })
  expect(JSON.stringify(h.state['sf-erp-v2'].archivedReceipts)).not.toContain('private-token')
  const restarted = harness(h.state)
  restarted.identity({ deviceId: 'dev2', token: 'new-private-token' })
  restarted.work(null)
  await pair(restarted)
  await restarted.connector.poll()
  expect(restarted.results).toHaveLength(0)
  expect(h.state['sf-erp-v2'].deviceId).toBe('dev2')
  expect(h.state['sf-erp-v2'].archivedReceipts[0].receipt).toEqual(pending)
  await restarted.connector.disconnect()
  expect(h.state['sf-erp-v2'].archivedReceipts).toHaveLength(1)
})

it('keeps all evidence when the recovery archive reaches its bounded capacity', async () => {
  const h = harness()
  await pair(h)
  h.offline(true)
  await h.connector.poll()
  h.auth(403)
  await h.connector.poll()
  h.state['sf-erp-v2'].archivedReceipts = Array.from({ length: 10 }, (_, i) => ({
    deviceId: 'old-' + i,
  }))
  const before = structuredClone(h.state)
  await expect(h.connector.archivePending()).rejects.toThrow()
  expect(h.state).toEqual(before)
})

it('rejects more than 3000 rows before creating a receipt', async () => {
  const h = harness()
  await pair(h)
  h.work({ ...job, rows: Array.from({ length: 3001 }, (_, i) => ({ ...rows[0], rowId: 'row-' + i })) })
  await h.connector.poll()
  expect(h.results).toHaveLength(0)
  expect((await h.connector.status()).error).toBeTruthy()
})

it('preserves v0.3 live evidence and source identity through revoked-device recovery', async () => {
  const live = {
    job: { id: 'j1', leaseId: 'lease1' },
    stage: 'DISPATCHED',
    owner: 'tab:1',
    pending: { eventId: 'receipt' },
    lastReceipt: { status: 'UNKNOWN' },
  }
  const h = harness({
    'sf-erp-v2': {
      token: 'private-token',
      deviceId: 'original',
      baseUrl: 'https://htcerp.app',
      scope: { warehouseCode: 'A1C5' },
      live,
      errorCode: 'auth',
    },
  })
  expect((await h.connector.status()).recoveryAvailable).toBe(true)
  await h.connector.archivePending()
  expect(h.state['sf-erp-v2'].archivedReceipts[0]).toMatchObject({
    deviceId: 'original',
    live,
    reason: 'AUTH_REVOKED',
  })
  expect(JSON.stringify(h.state)).not.toContain('private-token')
})

it('rejects pairing before consuming a one-use code when acknowledged live archive is full', async () => {
  const h = harness({
    'sf-erp-v2': {
      token: 'original-token',
      deviceId: 'original-device',
      baseUrl: 'https://htcerp.app',
      scope: { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5' },
      live: {
        job: { id: 'old-job', leaseId: 'old-lease' },
        stage: 'ACKNOWLEDGED',
        lastReceipt: { eventId: 'old-receipt' },
      },
      archivedLive: Array.from({ length: 10 }, (_, index) => ({ deviceId: 'archive-' + index })),
    },
  })
  const before = structuredClone(h.state)
  await expect(pair(h)).rejects.toThrow()
  expect(h.calls).toHaveLength(0)
  expect(h.state).toEqual(before)
})
