import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, expect, it } from 'vitest'
import { PackFactoryPackages } from '../../packages/order-sorting/pack-factory'
import { PackOrders } from '../../packages/order-sorting/pack-service'
import { OrderSorting } from '../../packages/order-sorting/service'
import { PickingSheets } from '../../packages/order-sorting/picking-service'
import { ProductImages } from '../../packages/product-images/service'
import { PackApiLabels } from '../../packages/order-sorting/pack-api-labels'
import type { OrderRow } from '../../packages/order-sorting/rules'
import { requiredRole } from '../../apps/api/src/access'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
const device = {
  id: 'isolated',
  scope_json: JSON.stringify({
    sellerAccountId: 'seller',
    marketplaceId: 'ATVPDKIKX0DER',
    warehouseCode: 'A1C5',
  }),
}
const rows: OrderRow[] = Array.from({ length: 13 }, (_, i) => [
  'Product ' + i,
  `${i < 9 ? 'HUJM' : 'HUC'}-JIT-${i}`,
  `X${String(i).padStart(9, '0')}`,
  `T${i}`,
  i < 4 ? 2 : 1,
])
async function source(input: OrderRow[]) {
  const book = new ExcelJS.Workbook(),
    s = book.addWorksheet('Order List')
  s.getCell('A2').value =
    `Orders: ${new Set(input.map((r) => r[3])).size}, SKUs: ${new Set(input.map((r) => r[1])).size}, Units: ${input.reduce((n, r) => n + r[4], 0)}`
  s.getCell('A3').value = 'Warehouse: A1C5'
  s.getCell('A4').value = 'Shipout: 2026-11-17 16:00'
  s.getRow(6).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  input.forEach((r, i) => (s.getRow(7 + i).values = r))
  return {
    requestId: crypto.randomUUID(),
    filename: 'orders.xlsx',
    warehouse: 'A1C5',
    base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64'),
  }
}
async function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  for (const f of ['0049_order_sorting', '0052_pack_orders', '0055_product_image_cache'])
    db.exec(readFileSync(`migrations/${f}.sql`, 'utf8'))
  db.exec(
    "CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY,seller TEXT); INSERT INTO title_audit_store VALUES(1,'seller')",
  )
  function prepare(sql: string, values: SQLInputValue[] = []): any {
    const s = db.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: async () => s.get(...values) ?? null,
      all: async () => ({ results: s.all(...values) }),
      run: async () => ({ meta: s.run(...values) }),
      sync: () => s.run(...values),
    }
  }
  const objects = new Map<string, Uint8Array>(),
    env: any = {
      DB: {
        prepare,
        batch: async (ss: any[]) => {
          db.exec('BEGIN')
          try {
            const r = ss.map((s) => ({ meta: s.sync() }))
            db.exec('COMMIT')
            return r
          } catch (e) {
            db.exec('ROLLBACK')
            throw e
          }
        },
      },
      ARCHIVE: {
        get: async (key: string) => {
          const b = objects.get(key)
          return b
            ? {
                size: b.length,
                body: new Response(b.slice().buffer).body,
                arrayBuffer: async () => b.slice().buffer,
                json: async () => JSON.parse(new TextDecoder().decode(b)),
              }
            : null
        },
        put: async (key: string, value: string | Uint8Array) => {
          objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value.slice())
          return { etag: 'test' }
        },
      },
    }
  const template = new ExcelJS.Workbook()
  template.addWorksheet('Details')
  template.addWorksheet('Raw')
  const file = {
    name: 'template.xlsx',
    base64: Buffer.from(await template.xlsx.writeBuffer()).toString('base64'),
  }
  await new OrderSorting(env).configure(
    'admin',
    { revision: 0, rows: [], attributeFile: file, templateFile: file },
    'admin',
  )
  const eu = await PDFDocument.create()
  eu.addPage([226, 226])
  objects.set('product-labels/eu-rep-ceramic-80mm-v1.pdf', await eu.save())
  const orders = new PackOrders(env)
  await orders.import(device, await source(rows.slice(0, 8)))
  const input = await source(rows),
    batch = await orders.import(device, input)
  let labelCalls = 0,
    imageCalls = 0
  const labels = new PackApiLabels(env, async (_env, data) => {
    labelCalls++
    const p = await PDFDocument.create()
    for (const r of data.lines) for (let i = 0; i < r.units; i++) p.addPage([226, 226])
    return new Response((await p.save()).slice().buffer, {
      headers: { 'content-type': 'application/pdf' },
    })
  })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  const images = new ProductImages(
    env,
    {
      productMainImage: async () => ({ asin: 'B000000001', url: 'https://m.media-amazon.com/test.png' }),
    },
    async () => {
      imageCalls++
      return new Response(png)
    },
  )
  const picking = new PickingSheets(env, images)
  const service = new PackFactoryPackages(env, { labels, picking })
  const ledger = () =>
    JSON.stringify(
      [
        'pack_order_batches',
        'pack_order_requests',
        'pack_order_rows',
        'order_sorting_config',
        'order_sorting_versions',
      ].map((t) => db.prepare(`SELECT * FROM ${t}`).all()),
    )
  return {
    db,
    env,
    objects,
    orders,
    batch,
    input,
    service,
    labels,
    picking,
    ledger,
    calls: () => ({ labelCalls, imageCalls }),
  }
}
it('exports all 13 orders / 17 units with three matching outputs, preserves the 8+5 ledger, and reuses the complete ERP package', async () => {
  const f = await setup(),
    before = f.ledger()
  expect(f.batch).toMatchObject({ newRows: 5, skippedRows: 8 })
  const result = await f.service.prepare(f.batch.id)
  expect(result).toMatchObject({ orderCount: 13, rowCount: 13, units: 17, newRows: 5, skippedRows: 8 })
  const zip = await JSZip.loadAsync(
    await (await f.service.download(f.batch.id, result.key)).arrayBuffer(),
  )
  let rawRows = 0,
    units = 0,
    pages = 0,
    images = 0
  for (const group of result.groups) {
    const sheet = new ExcelJS.Workbook()
    await sheet.xlsx.load((await zip.file(`分拣表/${group.filename}`)!.async('nodebuffer')) as never)
    sheet.worksheets[1].eachRow((r, i) => {
      if (i > 1) {
        rawRows++
        units += Number(r.getCell(5).value)
      }
    })
    const pdf = await PDFDocument.load(
      await zip.file(`SKU标签/${group.filename.replace('.xlsx', '.pdf')}`)!.async('uint8array'),
    )
    pages += pdf.getPageCount()
    const picking = new ExcelJS.Workbook()
    await picking.xlsx.load(
      (await zip
        .file(`带图备货单/${group.filename.replace('.xlsx', '-带图备货单.xlsx')}`)!
        .async('nodebuffer')) as never,
    )
    images += picking.worksheets[0].getImages().length
  }
  expect({ rawRows, units, pages, images }).toEqual({ rawRows: 13, units: 17, pages: 17, images: 13 })
  expect(JSON.parse(await zip.file('批次说明.json')!.async('string')).exportScope).toBe('ALL_ORDERS')
  const calls = f.calls()
  expect(await f.service.prepare(f.batch.id)).toEqual(result)
  expect(f.calls()).toEqual(calls)
  expect(f.ledger()).toBe(before)
  expect((await f.orders.view(f.batch.id)).plan?.totalRows).toBe(5)
  expect((await f.orders.import(device, { ...f.input, requestId: crypto.randomUUID() })).id).toBe(
    f.batch.id,
  )
}, 30000)
it('allows an all-duplicate batch and still produces its complete factory package', async () => {
  const f = await setup(),
    batch = await f.orders.import(device, await source([rows[0]])),
    before = f.ledger()
  expect(batch.newRows).toBe(0)
  expect(await f.service.prepare(batch.id)).toMatchObject({
    rowCount: 1,
    units: 2,
    newRows: 0,
    skippedRows: 1,
  })
  expect(f.ledger()).toBe(before)
})
it('blocks quantity conflicts rather than silently producing a partial all-orders package', async () => {
  const f = await setup(),
    batch = await f.orders.import(device, await source([[...rows[0].slice(0, 4), 9] as OrderRow])),
    before = f.ledger()
  await expect(f.service.prepare(batch.id)).rejects.toThrow(/数量|核对/)
  expect(f.ledger()).toBe(before)
  expect(f.calls().labelCalls).toBe(0)
})
it('isolates package caches by batch and rejects stale seller scope before any cached download', async () => {
  const f = await setup(),
    result = await f.service.prepare(f.batch.id)
  const other = await f.orders.import(device, await source([rows[0]]))
  await expect(f.service.download(other.id, result.key)).rejects.toThrow()
  f.db.exec("UPDATE title_audit_store SET seller='different'")
  await expect(f.service.prepare(f.batch.id)).rejects.toThrow(/店铺/)
  await expect(f.service.download(f.batch.id, result.key)).rejects.toThrow(/店铺/)
})
it('does not publish a complete ZIP when images are unavailable, and retries successfully', async () => {
  const f = await setup(),
    before = f.ledger()
  const broken = new PackFactoryPackages(f.env, {
    labels: f.labels,
    picking: {
      download: async () => {
        throw Error('missing image')
      },
    } as any,
  })
  await expect(broken.prepare(f.batch.id)).rejects.toThrow()
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM product_image_cache WHERE cache_key LIKE '%pack-factory%' AND object_key IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0)
  expect(await f.service.prepare(f.batch.id)).toMatchObject({ rowCount: 13, units: 17 })
  expect(f.ledger()).toBe(before)
})
it('deduplicates repeated source lines within the full export without multiplying printed units', async () => {
  const f = await setup(),
    batch = await f.orders.import(device, await source([...rows, rows[0]])),
    before = f.ledger()
  expect(batch.totalRows).toBe(14)
  expect(await f.service.prepare(batch.id)).toMatchObject({
    orderCount: 13,
    rowCount: 13,
    units: 17,
    newRows: 0,
  })
  expect(f.ledger()).toBe(before)
})
it('rejects a damaged archived source and refreshes the package when the attribute revision changes', async () => {
  const f = await setup(),
    first = await f.service.prepare(f.batch.id),
    calls = f.calls()
  f.db.exec('UPDATE order_sorting_config SET revision=revision+1')
  const second = await f.service.prepare(f.batch.id)
  expect(second.key).not.toBe(first.key)
  expect(second.attributeRevision).toBe(first.attributeRevision + 1)
  expect(f.calls()).toEqual(calls)
  const sourceKey = f.db.prepare('SELECT source_key FROM pack_order_batches WHERE id=?').get(f.batch.id)!
    .source_key as string
  f.objects.set(sourceKey, new Uint8Array([1, 2, 3, 4]))
  await expect(f.service.prepare(f.batch.id)).rejects.toThrow('校验失败')
})
it('allows operators to prepare factory packages while preserving config/admin and read permission boundaries', () => {
  const path = '/api/order-sorting/pack/00000000-0000-4000-8000-000000000001/factory-package'
  expect(requiredRole('POST', path)).toBe('operator')
  expect(requiredRole('GET', path + '/a'.repeat(64))).toBe('viewer')
  expect(requiredRole('POST', '/api/order-sorting/config')).toBe('admin')
})
it('stops a factory package whose accumulated generated files exceed the output-size guard', async () => {
  const f = await setup(),
    before = f.ledger()
  const oversized = new PackFactoryPackages(f.env, {
    labels: f.labels,
    picking: { download: async () => new Response(new Uint8Array(25 * 1024 * 1024)) } as any,
  })
  await expect(oversized.prepare(f.batch.id)).rejects.toThrow('分批导出')
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM product_image_cache WHERE cache_key LIKE '%pack-factory%' AND object_key IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0)
  expect(f.ledger()).toBe(before)
})
