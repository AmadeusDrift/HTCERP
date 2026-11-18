import { streamPackLabelResult } from '../../packages/order-sorting/pack-routes'
import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { expect, it, vi } from 'vitest'
import { connectionDigest } from '../../packages/inventory-sync/connection'
import { PackApiLabels } from '../../packages/order-sorting/pack-api-labels'
import type { PackBatch } from '../../packages/order-sorting/pack-types'
import { sortOrders } from '../../packages/order-sorting/rules'

async function fixture() {
  const scope = { sellerAccountId: 'seller', marketplaceId: 'ATVPDKIKX0DER', warehouseCode: 'A1C5' }
  let storedScope = await connectionDigest(JSON.stringify(Object.values(scope)))
  const objects = new Map<string, Uint8Array>()
  const reads: string[]=[]
  const etag=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
  objects.set('product-labels/eu-rep-ceramic-80mm-v1.pdf', new Uint8Array([1, 2, 3]))
  const env = {
    DB: {
      prepare: (sql: string) => ({
        first: async () => ({ seller: 'seller' }),
        bind: () => ({ first: async () => ({ scope_key: storedScope }) }),
      }),
    },
    ARCHIVE: {
      head: async(key:string)=>{const b=objects.get(key);return b?{size:b.length,etag:etag(b)}:null},
      get: async (key: string) => {
        reads.push(key)
        const bytes = objects.get(key)
        return bytes
          ? {
              size: bytes.length,
              arrayBuffer: async () => bytes.slice().buffer,
              json: async () => JSON.parse(new TextDecoder().decode(bytes)),
              body: new Response(bytes.slice().buffer).body,
            }
          : null
      },
      put: async (key: string, bytes: Uint8Array | ArrayBuffer | string) => {
        objects.set(
          key,
          typeof bytes === 'string'
            ? new TextEncoder().encode(bytes)
            : new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes).slice(),
        )
        return {etag:etag(objects.get(key)!)}
      },
    },
  }
  const plan = sortOrders(
    { date: '2026-11-17', rows: [['Wallet', 'HUJM-ABC-JIT-1', 'X005EVJ3LD', 'T1', 2]] },
    [],
  )
  const batch: PackBatch = {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: 1,
    filename: 'order.xlsx',
    date: plan.date,
    state: 'READY',
    totalRows: 1,
    newRows: 1,
    skippedRows: 0,
    conflicts: [],
    plan,
    templateKey: 'sort.xlsx',
    labels: [
      {
        rowIndex: 0,
        sku: 'HUJM-ABC-JIT-1',
        fnsku: 'X005EVJ3LD',
        transferId: 'T1',
        units: 2,
        group: 'HUJM',
        filename: 'flex.pdf',
        received: true,
      },
    ],
    sourceHash: 'source',
  }
  const generate = vi.fn(async (_env, input) => {
    const pdf = await PDFDocument.create()
    for (
      let i = 0;
      i < input.lines.reduce((n: number, line: { units: number }) => n + line.units, 0);
      i++
    )
      pdf.addPage([226.77, 226.77])
    return new Response(new Uint8Array(await pdf.save()).buffer, {
      headers: { 'content-type': 'application/pdf' },
    })
  })
  const service = new PackApiLabels(env as never, generate)
  return {
    objects, reads,
    batch,
    generate,
    service,
    changeSeller: () => {
      storedScope = 'different'
    },
  }
}

it('does not treat saved Flex PDFs as API-ready, prepares from server plan and persists composed output', async () => {
  const f = await fixture()
  expect(await f.service.view(f.batch)).toMatchObject({
    state: 'LABELS_PENDING',
    labelSource: 'AMAZON_API',
  })
  const ready = await f.service.prepare(f.batch)
  expect(ready).toMatchObject({ state: 'READY', labelGroups: [{ group: 'HUJM', ready: true }] })
  expect(f.generate.mock.calls[0][1]).toMatchObject({
    sellerAccountId: 'seller',
    lines: [{ sku: 'HUJM-ABC-JIT-1', fnsku: 'X005EVJ3LD', units: 2 }],
  })
  const first = new Uint8Array(await (await f.service.download(f.batch, 'HUJM')).arrayBuffer())
  const second = new Uint8Array(await (await f.service.download(f.batch, 'HUJM')).arrayBuffer())
  expect(first).toEqual(second)
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect((await PDFDocument.load(first)).getPageCount()).toBe(2)
})

it('changes of fixed template invalidate only composed artifacts; failed generation stays pending', async () => {
  const f = await fixture()
  await f.service.prepare(f.batch)
  f.objects.set('product-labels/eu-rep-ceramic-80mm-v1.pdf', new Uint8Array([4]))
  expect((await f.service.view(f.batch)).state).toBe('LABELS_PENDING')
  f.generate.mockRejectedValueOnce(new Error('Amazon unavailable'))
  expect(await f.service.prepare(f.batch)).toMatchObject({
    state: 'LABELS_PENDING',
    labelError: expect.any(String),
  })
  expect((await f.service.prepare(f.batch)).state).toBe('READY')
})

it('rejects a mismatched seller or a group not in the immutable plan without calling Amazon', async () => {
  const f = await fixture()
  await expect(f.service.download(f.batch, 'OTHER')).rejects.toThrow()
  f.changeSeller()
  await expect(f.service.download(f.batch, 'HUJM')).rejects.toThrow()
  expect(f.generate).not.toHaveBeenCalled()
})

it('recovers a corrupt outer PDF instead of marking it ready', async () => {
  const f = await fixture()
  await f.service.prepare(f.batch)
  const key = [...f.objects.keys()].find(
    (k) => k.startsWith('order-sorting/pack/api-labels/') && k.endsWith('.pdf'),
  )!
  f.objects.set(key, new TextEncoder().encode('%PDF-corrupt'))
  expect((await f.service.view(f.batch)).state).toBe('LABELS_PENDING')
  expect((await f.service.prepare(f.batch)).state).toBe('READY')
  expect(f.generate).toHaveBeenCalledTimes(2)
})
it('splits groups exceeding 1000 labels without losing quantities or order', async () => {
  const f = await fixture()
  f.batch.plan!.groups[0].raw[0][4] = 1001
  f.batch.plan!.groups[0].units = 1001
  const bytes = await (await f.service.download(f.batch, 'HUJM')).arrayBuffer()
  expect(
    f.generate.mock.calls.map((call) =>
      call[1].lines.reduce((n: number, line: { units: number }) => n + line.units, 0),
    ),
  ).toEqual([1000, 1])
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1001)
})

it('checks history readiness without downloading cached PDF bodies', async()=>{
 const f=await fixture();await f.service.prepare(f.batch);f.reads.length=0
 expect((await f.service.view(f.batch)).state).toBe('READY')
 expect(f.reads.filter(key=>key.startsWith('order-sorting/pack/api-labels/')&&key.endsWith('.pdf'))).toEqual([])
})

it('sends response headers and JSON whitespace before slow label generation finishes', async()=>{
 const f=await fixture();let finish!:(batch:PackBatch)=>void
 const pending=new Promise<PackBatch>(resolve=>{finish=resolve})
 const response=streamPackLabelResult(()=>pending)
 const reader=response.body!.getReader()
 const first=await reader.read()
 expect(new TextDecoder().decode(first.value).trim()).toBe('')
 finish(f.batch)
 const last=await reader.read()
 expect(JSON.parse(new TextDecoder().decode(last.value)).id).toBe(f.batch.id)
 expect((await reader.read()).done).toBe(true)
})
