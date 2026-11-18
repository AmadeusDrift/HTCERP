import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractText } from 'unpdf'
import { afterEach, expect, it, vi } from 'vitest'
import {
  downloadMergedProductLabels,
  type ProductLabelEnvironment,
} from '../../packages/product-labels/download'

const mm = 72 / 25.4
const templateKey = 'product-labels/eu-rep-ceramic-80mm-v1.pdf'
const scope = {
  sellerAccountId: 'seller-a',
  marketplaceId: 'ATVPDKIKX0DER',
  region: 'NA' as const,
  locale: 'en_US',
}
const lines = [
  { sku: 'HUCTCGJ-JIT-00058', fnsku: 'X005EC4Z9R', units: 1 },
  { sku: 'HUCTCGJ-JIT-00079', fnsku: 'X005EC8JYT', units: 2 },
]
const labelUrl = 'https://test-labels.s3.us-east-1.amazonaws.com/items.pdf?token=not-for-client'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function pdf(size: [number, number], texts: string[]) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of texts) {
    const page = doc.addPage(size)
    page.drawText(text, { x: 10, y: 28, size: 10, font })
  }
  return doc.save({ addDefaultPage: false })
}

async function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(
    'CREATE TABLE connection_credentials(provider TEXT PRIMARY KEY, version INTEGER, nonce TEXT, ciphertext TEXT)',
  )
  db.exec(readFileSync('migrations/0053_product_label_cache.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = db.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: async () => statement.get(...values) ?? null,
      run: async () => ({ meta: statement.run(...values) }),
    }
  }
  const objects = new Map<string, Uint8Array>([[templateKey, await pdf([80 * mm, 80 * mm], ['EU REP'])]])
  const hooks: {
    codes?: string[]
    fnskus?: Map<string, string>
    url?: string
    beforeApi?: () => Promise<void>
    beforePut?: (key: string) => Promise<void>
  } = {}
  const downloads = new Map<string, Uint8Array>()
  let downloadId = 0
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('/auth/o2/token')) return Response.json({ access_token: 'lwa-token' })
    if (String(url).endsWith('/items/labels')) {
      await hooks.beforeApi?.()
      const body = JSON.parse(String(init?.body))
      const codes =
        hooks.codes ??
        body.mskuQuantities
          .flatMap(({ msku, quantity }: { msku: string; quantity: number }) => {
            const code = hooks.fnskus?.get(msku) ?? lines.find((line) => line.sku === msku)?.fnsku
            if (!code) throw new Error('Missing fixture FNSKU')
            return Array.from({ length: quantity }, () => code)
          })
          .reverse()
      const uri = hooks.url ?? `${labelUrl}&id=${++downloadId}`
      downloads.set(uri, await pdf([70 * mm, 30 * mm], codes))
      return Response.json({ documentDownloads: [{ uri, downloadType: 'URL' }] })
    }
    const bytes = downloads.get(String(url))
    if (!bytes) throw new Error(`Unexpected URL ${url}`)
    return new Response(bytes.slice().buffer)
  })
  const env = {
    SP_CLIENT_ID: 'client',
    SP_CLIENT_SECRET: 'secret',
    SP_REFRESH_TOKEN: 'refresh',
    DB: { prepare },
    ARCHIVE: {
      get: async (key: string) => {
        const bytes = objects.get(key)
        return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null
      },
      put: async (key: string, value: ArrayBuffer | Uint8Array) => {
        await hooks.beforePut?.(key)
        objects.set(key, new Uint8Array(value).slice())
      },
    },
  } as unknown as ProductLabelEnvironment
  const input = { ...scope, lines, filename: '陶瓷挂件标签', batchId: 'batch-a' }
  const apiBodies = () =>
    send.mock.calls
      .filter(([url]) => String(url).endsWith('/items/labels'))
      .map(([, init]) => JSON.parse(String(init?.body)))
  return { env, send, db, objects, hooks, input, apiBodies }
}

it('reports the upstream label error without exposing tokens or download URLs', async () => {
  const f = await setup()
  f.send.mockImplementation(async (url) => {
    if (String(url).includes('/auth/o2/token')) return Response.json({ access_token: 'lwa-token' })
    return Response.json(
      { errors: [{ code: 'InvalidInput', message: 'SKU is not eligible. lwa-token https://example.test/key' }] },
      { status: 400, headers: { 'x-amzn-requestid': 'request-1234' } },
    )
  })
  const result = downloadMergedProductLabels(f.env, f.input, f.send)
  await expect(result).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_REQUEST_FAILED',
    message: expect.stringContaining('商品标签，HTTP 400，请求 ID request-1234，InvalidInput · SKU is not eligible. [已隐藏] [链接已隐藏]'),
  })
})

it('fetches one original per SKU and prints exact counts on 80 mm pages with the fixed EU rep', async () => {
  const f = await setup()
  const result = await downloadMergedProductLabels(f.env, f.input, f.send)
  expect(result.status).toBe(200)
  expect(result.headers.get('content-type')).toBe('application/pdf')
  expect(result.headers.get('content-disposition')).toContain(encodeURIComponent('陶瓷挂件标签.pdf'))
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(f.apiBodies().flatMap((body) => body.mskuQuantities)).toEqual(
    lines.map(({ sku }) => ({ msku: sku, quantity: 1 })),
  )
  for (const body of f.apiBodies())
    expect(body).toMatchObject({
      marketplaceId: scope.marketplaceId,
      localeCode: scope.locale,
      labelType: 'THERMAL_PRINTING',
      width: 70,
      height: 30,
    })
  for (const [url, init] of f.send.mock.calls)
    if (String(url).startsWith(labelUrl)) expect(init?.headers).toBeUndefined()
  const bytes = await result.arrayBuffer()
  const doc = await PDFDocument.load(bytes)
  expect(doc.getPageCount()).toBe(3)
  for (const page of doc.getPages()) {
    expect(page.getWidth()).toBeCloseTo(80 * mm, 4)
    expect(page.getHeight()).toBeCloseTo(80 * mm, 4)
  }
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false })
  expect(text.map((page) => page.match(/X[A-Z0-9]{9}/g))).toEqual(
    lines.flatMap(({ fnsku, units }) => Array.from({ length: units }, () => [fnsku])),
  )
  expect(text.every((page) => page.includes('EU REP'))).toBe(true)
})

it('reuses originals across batches and changed quantities without auth or Amazon requests', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  f.send.mockClear()
  const result = await downloadMergedProductLabels(
    f.env,
    {
      ...f.input,
      batchId: 'batch-b',
      lines: [
        { ...lines[1], units: 4 },
        { ...lines[0], units: 2 },
        { ...lines[1], units: 1 },
      ],
    },
    f.send,
  )
  expect(f.send).not.toHaveBeenCalled()
  const { text } = await extractText(new Uint8Array(await result.arrayBuffer()), { mergePages: false })
  expect(text.map((page) => page.match(/X[A-Z0-9]{9}/)?.[0])).toEqual([
    ...Array(4).fill(lines[1].fnsku),
    ...Array(2).fill(lines[0].fnsku),
    lines[1].fnsku,
  ])
})

it('fetches only missing SKU originals for mixed cache hits and misses', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, { ...f.input, lines: [lines[0]] }, f.send)
  f.send.mockClear()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  expect(f.apiBodies().flatMap((body) => body.mskuQuantities)).toEqual([
    { msku: lines[1].sku, quantity: 1 },
  ])
})

it('persists composed PDFs and returns byte-identical results for the same ordered quantities', async () => {
  const f = await setup()
  const first = await (await downloadMergedProductLabels(f.env, f.input, f.send)).arrayBuffer()
  f.send.mockClear()
  const second = await (
    await downloadMergedProductLabels(
      f.env,
      { ...f.input, filename: 'new-name', batchId: 'other' },
      f.send,
    )
  ).arrayBuffer()
  expect(new Uint8Array(second)).toEqual(new Uint8Array(first))
  expect(f.send).not.toHaveBeenCalled()
  expect([...f.objects.keys()].some((key) => key.includes('/merged/'))).toBe(true)
})

it('does not cache mismatched FNSKUs and releases failed leases so a retry succeeds', async () => {
  const f = await setup()
  f.hooks.codes = ['X000000000', lines[1].fnsku]
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_MISMATCH',
  })
  expect(f.objects.size).toBe(1)
  f.hooks.codes = undefined
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).resolves.toHaveProperty(
    'status',
    200,
  )
})

it('rejects extra or missing original pages without caching them', async () => {
  const f = await setup()
  for (const codes of [[], [lines[0].fnsku, lines[0].fnsku]]) {
    f.hooks.codes = codes
    await expect(
      downloadMergedProductLabels(f.env, { ...f.input, lines: [lines[0]] }, f.send),
    ).rejects.toMatchObject({ code: 'PRODUCT_LABEL_COUNT_MISMATCH' })
    expect(f.objects.size).toBe(1)
  }
})

it.each([
  { sellerAccountId: 'seller-b' },
  { marketplaceId: 'A1F83G8C2ARO7P' },
  { region: 'EU' as const },
  { locale: 'en_GB' },
])('isolates original cache scope %j', async (change) => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, { ...f.input, lines: [lines[0]] }, f.send)
  f.send.mockClear()
  await downloadMergedProductLabels(f.env, { ...f.input, ...change, lines: [lines[0]] }, f.send)
  expect(f.apiBodies()).toHaveLength(1)
})

it('invalidates merged files when the fixed template changes, retaining original labels', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  f.objects.set(templateKey, await pdf([80 * mm, 80 * mm], ['EU REP UPDATED']))
  f.send.mockClear()
  const result = await downloadMergedProductLabels(f.env, f.input, f.send)
  expect(f.send).not.toHaveBeenCalled()
  const { text } = await extractText(new Uint8Array(await result.arrayBuffer()), { mergePages: false })
  expect(text.every((page) => page.includes('EU REP UPDATED'))).toBe(true)
})

it('rejects missing or invalid templates even when the merged file was previously cached', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  f.send.mockClear()
  f.objects.delete(templateKey)
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_TEMPLATE_UNAVAILABLE',
  })
  f.objects.set(templateKey, await pdf([70 * mm, 30 * mm], ['bad template']))
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_TEMPLATE_UNAVAILABLE',
  })
  expect(f.send).not.toHaveBeenCalled()
})

it('shares durable original leases across overlapping requests with different quantities', async () => {
  const f = await setup()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.hooks.beforeApi = async () => {
    entered()
    await gate
  }
  const first = downloadMergedProductLabels(f.env, { ...f.input, lines: [lines[0]] }, f.send)
  await ready
  const second = downloadMergedProductLabels(
    f.env,
    { ...f.input, lines: [{ ...lines[0], units: 3 }] },
    f.send,
  )
  release()
  const responses = await Promise.all([first, second])
  expect(f.apiBodies()).toHaveLength(1)
  expect(
    await Promise.all(
      responses.map(async (response) =>
        (await PDFDocument.load(await response.arrayBuffer())).getPageCount(),
      ),
    ),
  ).toEqual([1, 3])
})

it('does not fetch a download URL outside Amazon S3', async () => {
  const f = await setup()
  f.hooks.url = 'https://not-amazon.invalid/label.pdf'
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_RESPONSE_INVALID',
  })
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.objects.size).toBe(1)
})

it('requires seller identity even when Amazon credentials exist', async () => {
  const f = await setup()
  await expect(
    downloadMergedProductLabels(f.env, { ...f.input, sellerAccountId: '' }, f.send),
  ).rejects.toMatchObject({ code: 'PRODUCT_LABEL_INPUT_INVALID' })
  expect(f.send).not.toHaveBeenCalled()
})

it('keeps changed FNSKU originals isolated even for the same SKU', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, { ...f.input, lines: [lines[0]] }, f.send)
  f.send.mockClear()
  f.hooks.codes = ['X000000001']
  const result = await downloadMergedProductLabels(
    f.env,
    { ...f.input, lines: [{ ...lines[0], fnsku: 'X000000001' }] },
    f.send,
  )
  expect(f.apiBodies()).toHaveLength(1)
  const { text } = await extractText(new Uint8Array(await result.arrayBuffer()), { mergePages: true })
  expect(text).toContain('X000000001')
})

it('recovers an expired durable lease left by a terminated Worker', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  f.db.exec(
    "UPDATE product_label_cache SET r2_key=NULL,content_sha256=NULL,lease_owner='terminated',lease_until=1",
  )
  f.send.mockClear()
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).resolves.toHaveProperty(
    'status',
    200,
  )
  expect(f.apiBodies()).toHaveLength(1)
})

it('fences an expired producer so it cannot publish after another Worker acquires the lease', async () => {
  const f = await setup()
  f.hooks.beforePut = async (key) => {
    if (key.includes('/original/'))
      f.db.exec(
        "UPDATE product_label_cache SET lease_owner='successor',lease_until=9999999999999 WHERE cache_key LIKE '%/original/%'",
      )
  }
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toMatchObject({
    code: 'PRODUCT_LABEL_CACHE_BUSY',
  })
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM product_label_cache WHERE r2_key IS NOT NULL').get(),
  ).toEqual({ count: 0 })
  f.hooks.beforePut = undefined
  f.db.exec("UPDATE product_label_cache SET lease_until=0 WHERE lease_owner='successor'")
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).resolves.toHaveProperty(
    'status',
    200,
  )
})

it('releases leases after R2 storage fails and retries without publishing partial data', async () => {
  const f = await setup()
  f.hooks.beforePut = async () => {
    throw new Error('R2 unavailable')
  }
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).rejects.toThrow('R2 unavailable')
  expect(
    f.db
      .prepare(
        'SELECT COUNT(*) AS count FROM product_label_cache WHERE r2_key IS NOT NULL OR lease_owner IS NOT NULL',
      )
      .get(),
  ).toEqual({ count: 0 })
  f.hooks.beforePut = undefined
  await expect(downloadMergedProductLabels(f.env, f.input, f.send)).resolves.toHaveProperty(
    'status',
    200,
  )
})

it('rebuilds a damaged merged R2 object using cached originals without Amazon calls', async () => {
  const f = await setup()
  await downloadMergedProductLabels(f.env, f.input, f.send)
  const key = [...f.objects.keys()].find((key) => key.includes('/merged/'))
  if (!key) throw new Error('Missing merged PDF')
  f.objects.set(key, new TextEncoder().encode('damaged'))
  f.send.mockClear()
  const result = await downloadMergedProductLabels(f.env, f.input, f.send)
  expect((await PDFDocument.load(await result.arrayBuffer())).getPageCount()).toBe(3)
  expect(f.send).not.toHaveBeenCalled()
})

it('batches at most 100 missing unique FNSKUs in each Amazon request', async () => {
  const f = await setup()
  const many = Array.from({ length: 101 }, (_, index) => ({
    sku: `SKU-${index}`,
    fnsku: `X${String(index).padStart(9, '0')}`,
    units: 1,
  }))
  f.hooks.fnskus = new Map(many.map((line) => [line.sku, line.fnsku]))
  const response = await downloadMergedProductLabels(f.env, { ...f.input, lines: many }, f.send)
  expect(f.apiBodies().map((body) => body.mskuQuantities.length)).toEqual([100, 1])
  expect((await PDFDocument.load(await response.arrayBuffer())).getPageCount()).toBe(101)
})

it('separates SKUs sharing an FNSKU so every original remains attributable', async () => {
  const f = await setup()
  const shared = [{ ...lines[0] }, { ...lines[1], fnsku: lines[0].fnsku }]
  f.hooks.fnskus = new Map(shared.map((line) => [line.sku, line.fnsku]))
  const response = await downloadMergedProductLabels(f.env, { ...f.input, lines: shared }, f.send)
  expect(f.apiBodies().map((body) => body.mskuQuantities)).toEqual(
    shared.map((line) => [{ msku: line.sku, quantity: 1 }]),
  )
  expect((await PDFDocument.load(await response.arrayBuffer())).getPageCount()).toBe(3)
})

it('renews durable leases while Amazon is still producing the originals', async () => {
  const f = await setup()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.hooks.beforeApi = async () => {
    entered()
    await gate
  }
  const pending = downloadMergedProductLabels(f.env, f.input, f.send)
  try {
    await ready
    await vi.advanceTimersByTimeAsync(120_000)
    const leases = f.db
      .prepare('SELECT lease_until FROM product_label_cache WHERE lease_owner IS NOT NULL')
      .all() as { lease_until: number }[]
    expect(leases).toHaveLength(3)
    expect(leases.every((lease) => lease.lease_until > Date.now())).toBe(true)
    release()
    await expect(pending).resolves.toHaveProperty('status', 200)
  } finally {
    release()
    await pending.catch(() => undefined)
    vi.useRealTimers()
  }
})
