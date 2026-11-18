import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const rows = [{ title: 'Product', sku: 'SKU', fnsku: 'FN', transferId: 'TR', units: 2 }]
const source = { requestId: 'bd415a88-8d6a-4776-bbf7-721f1f935845', filename: 'transshipment-order-list-2026-11-16.xlsx', base64: Buffer.from('PK\x03\x04xlsx').toString('base64'), rows }
const batch = { id: 'batch-1', createdAt: 'now', filename: source.filename, date: '2026-11-16', labelSource: 'AMAZON_API', labelGroups: [{ group: 'Group', ready: false }], state: 'LABELS_PENDING', totalRows: 1, newRows: 1, skippedRows: 0, conflicts: [], plan: null, templateKey: 'key', sourceHash: 'hash', labels: [{ rowIndex: 0, ...rows[0], group: 'Group', filename: '', received: false }] }
function harness(records = new Map<string, any>()) {
  let state: any = { baseUrl: 'https://htcerp.app', deviceId: 'device', token: 'SECRET', scope: { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5' } }
  let lose = false
  let returned = structuredClone(batch)
  const calls: any[] = []
  const context: any = { crypto: webcrypto, atob, btoa, Uint8Array, TextDecoder, URL }
  const file = new URL('pack-connector.js', directory)
  if (existsSync(file)) runInNewContext(readFileSync(file, 'utf8'), context)
  const connector = context.SellerFlexPackConnector?.create({
    crypto: webcrypto, serial: (fn: any) => fn(), read: async () => state,
    store: { all: async () => structuredClone([...records.values()]), get: async (id: string) => structuredClone(records.get(id)), put: async (value: any) => { records.set(value.requestId, structuredClone(value)) } },
    request: async (_state: any, path: string, body: any) => {
      expect(records.size).toBeGreaterThan(0)
      calls.push({ path, body: structuredClone(body) })
      if (lose) throw new Error('lost response')
      return structuredClone(returned)
    },
  })
  return { connector, records, calls, lose: (v: boolean) => { lose = v }, state: (v: any) => { state = v }, returned: (v: any) => { returned = v } }
}
it('persists native XLSX and stable id before upload, then replays after a lost response and restart', async () => {
  const h = harness()
  expect(h.connector).toBeDefined()
  h.lose(true)
  const pending = await h.connector.enqueue(source, 'document-one')
  expect(pending.pending).toBe(true)
  expect(pending.error).toContain('原始订单已保存在本机')
  expect(pending.error).toContain('尚未确认')
  expect(pending.error).toContain('自动重试')
  expect(h.records.get(source.requestId).base64).toBe(source.base64)
  const restarted = harness(h.records)
  await restarted.connector.synchronize()
  expect(restarted.calls[0].body.requestId).toBe(source.requestId)
  expect(restarted.calls[0].body.base64).toBe(source.base64)
  expect(JSON.stringify(await restarted.connector.resume({ rows }, 'document-two'))).not.toContain('SECRET')
})
it('freezes pending files under their original identity after disconnect or seller/device changes', async () => {
  const h = harness(); expect(h.connector).toBeDefined(); h.lose(true)
  await h.connector.enqueue(source, 'one')
  h.state({})
  await h.connector.synchronize()
  h.state({ baseUrl: 'https://htcerp.app', token: 'NEW', deviceId: 'other', scope: { sellerAccountId: 'other', marketplaceId: 'US', warehouseCode: 'A1C5' } })
  await h.connector.synchronize()
  expect(h.calls).toHaveLength(1)
  expect(h.records.size).toBe(1)
  expect(await h.connector.resume({ rows }, 'two')).toBeNull()
})
it('polls ERP API labels until all groups are ready without uploading PDF bytes', async () => {
  const h = harness()
  const pending = await h.connector.enqueue(source, 'one')
  expect(pending.pending).toBe(true)
  expect(h.connector.label).toBeUndefined()
  expect(h.records.get(source.requestId).pdfs).toBeUndefined()
  h.returned({ ...batch, state: 'READY', labelGroups: [{ group: 'Group', ready: true }] })
  await h.connector.synchronize()
  expect((await h.connector.resume({ rows }, 'two')).pending).toBe(false)
  expect(h.calls.every(call => !call.path.endsWith('/labels'))).toBe(true)
})
it('requires an ERP upgrade when labelSource is absent, even when legacy labels are received', async () => {
  const h = harness()
  const legacy: any = { ...batch, state: 'READY', labels: [{ ...batch.labels[0], received: true }] }
  delete legacy.labelSource
  h.returned(legacy)
  const result = await h.connector.enqueue(source, 'one')
  expect(result.pending).toBe(true)
  expect(result.batch).toBeNull()
  expect(result.error).toContain('\u5347\u7ea7 ERP')
  expect(h.connector.label).toBeUndefined()
})
it('rejects PDF input and inconsistent ERP API group readiness', async () => {
  const h = harness()
  await expect(h.connector.enqueue({ ...source, base64: Buffer.from('%PDF-file').toString('base64') }, 'one')).rejects.toThrow()
  h.returned({ ...batch, state: 'READY' })
  const result = await h.connector.enqueue(source, 'one')
  expect(result.batch).toBeNull()
  expect(result.pending).toBe(true)
})
it('does not overwrite a request id with a different native source or snapshot', async () => {
  const h = harness(); expect(h.connector).toBeDefined()
  await h.connector.enqueue(source, 'one')
  await expect(h.connector.enqueue({ ...source, rows: [{ ...rows[0], units: 9 }] }, 'one')).rejects.toThrow()
  expect(h.records.get(source.requestId).rows).toEqual(rows)
})
it('rejects native files larger than the ERP 12,000,000 byte limit before persisting or uploading', async () => {
  const h = harness(); expect(h.connector).toBeDefined()
  const bytes = Buffer.alloc(12_000_001, 65)
  bytes.write('PK\x03\x04')
  await expect(h.connector.enqueue({ ...source, base64: bytes.toString('base64') }, 'one')).rejects.toThrow()
  expect(h.records.size).toBe(0)
  expect(h.calls).toHaveLength(0)
})
it('purges all legacy queued PDFs, including other scopes, without replaying or losing original XLSX', async () => {
  const h = harness()
  await h.connector.enqueue(source, 'one')
  const record = h.records.get(source.requestId)
  record.pdfs = { '0': { filename: 'fnsku-labels-FN.pdf', base64: Buffer.from('%PDF-OLD').toString('base64') } }
  record.batch = { ...batch, state: 'READY' }
  delete record.batch.labelSource
  h.records.set('other', { ...structuredClone(record), requestId: 'other', identity: { ...record.identity, sellerAccountId: 'other' } })
  await h.connector.synchronize()
  expect(h.calls.map(call => call.path)).toEqual(['pack-orders/import', 'pack-orders/batch-1'])
  expect([...h.records.values()].every(item => item.pdfs === undefined)).toBe(true)
  expect(h.records.get(source.requestId).base64).toBe(source.base64)
  expect(JSON.stringify([...h.records.values()])).not.toContain(Buffer.from('%PDF-OLD').toString('base64'))
})
it('never polls or resumes cached orders under a different marketplace, warehouse or endpoint', async () => {
  const h = harness()
  await h.connector.enqueue(source, 'one')
  for (const patch of [{ marketplaceId: 'CA' }, { warehouseCode: 'OTHER' }, { sellerAccountId: 'other' }]) {
    h.state({ baseUrl: 'https://htcerp.app', deviceId: 'device', token: 'NEW', scope: { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5', ...patch } })
    await h.connector.synchronize()
    expect(await h.connector.resume({ rows }, 'two')).toBeNull()
  }
  h.state({ baseUrl: 'https://other.example', deviceId: 'device', token: 'NEW', scope: { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5' } })
  await h.connector.synchronize()
  expect(h.calls).toHaveLength(1)
})
it('runs local PDF cleanup during background polls even after ERP disconnection, without network requests', async () => {
  const h = harness()
  await h.connector.enqueue(source, 'one')
  h.records.get(source.requestId).pdfs = { '0': { base64: 'stale-pdf' } }
  h.state({})
  const context: any = { URL }
  runInNewContext(readFileSync(new URL('connector.js', directory), 'utf8'), context)
  const connector = context.SellerFlexConnector.create({
    chrome: { storage: { local: { setAccessLevel: async () => {}, get: async () => ({}) } }, alarms: { get: async () => ({}), create: async () => {} } },
    fetch: () => { throw Error('Network forbidden while disconnected') },
    packFactory: () => h.connector,
  })
  await connector.poll()
  expect(h.records.get(source.requestId).pdfs).toBeUndefined()
  expect(h.calls).toHaveLength(1)
})
it('keeps Pack import and batch requests alive beyond 12 seconds but aborts at 180 seconds without changing inventory timeouts', async () => {
  vi.useFakeTimers()
  try {
    let request: any
    const signals = new Map<string, AbortSignal>()
    const context: any = { URL, AbortSignal: { timeout: (milliseconds: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    } } }
    runInNewContext(readFileSync(new URL('connector.js', directory), 'utf8'), context)
    context.SellerFlexConnector.create({
      chrome: { storage: { local: { setAccessLevel: async () => {} } }, alarms: { get: async () => ({}) } },
      packFactory: (dependencies: any) => { request = dependencies.request; return {} },
      fetch: (url: string, options: any) => new Promise((_, reject) => {
        signals.set(url.split('/api/inventory-device/')[1], options.signal)
        options.signal.addEventListener('abort', () => reject(new Error('Request aborted')))
      }),
    })
    const paths = ['pack-orders/import', 'pack-orders/batch-1', 'heartbeat', 'automatic/prepare', 'pack-orders/batch-1/labels']
    const pending = paths.map(path => request({ baseUrl: 'https://htcerp.app', token: 'current-token' }, path, path === 'pack-orders/import' ? { requestId: source.requestId, base64: source.base64 } : undefined).catch((error: any) => error.safeCode))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(signals.get('heartbeat')?.aborted).toBe(true)
    expect(signals.get('pack-orders/batch-1/labels')?.aborted).toBe(true)
    expect(signals.get('pack-orders/import')?.aborted).toBe(false)
    expect(signals.get('pack-orders/batch-1')?.aborted).toBe(false)
    expect(signals.get('automatic/prepare')?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(48_000)
    expect(signals.get('automatic/prepare')?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(signals.get('pack-orders/import')?.aborted).toBe(false)
    expect(signals.get('pack-orders/batch-1')?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals.get('pack-orders/import')?.aborted).toBe(true)
    expect(signals.get('pack-orders/batch-1')?.aborted).toBe(true)
    expect(await Promise.all(pending)).toEqual(paths.map(() => 'offline'))
  } finally { vi.useRealTimers() }
})
