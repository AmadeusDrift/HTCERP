import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { afterEach, expect, it } from 'vitest'
import { PackOrders } from '../../packages/order-sorting/pack-service'
import type { OrderRow } from '../../packages/order-sorting/rules'
import { OrderSorting } from '../../packages/order-sorting/service'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const device = {
  id: 'device-1',
  scope_json: JSON.stringify({
    sellerAccountId: 'seller',
    marketplaceId: 'ATVPDKIKX0DER',
    warehouseCode: 'A1C5',
  }),
}
const row = (sku = 'HUVT.MP-18Y-JIT-496', transfer = 'T1', units = 2): OrderRow => [
  'Product',
  sku,
  `F-${sku}`,
  transfer,
  units,
]
async function source(rows: OrderRow[], overrides: Record<string, string | undefined> = {}) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Order List')
  sheet.getCell('A2').value =
    `Orders: ${new Set(rows.map((r) => r[3])).size} SKUs: ${new Set(rows.map((r) => r[1])).size} Units: ${rows.reduce((sum, r) => sum + r[4], 0)}`
  sheet.getCell('A3').value = 'Warehouse: A1C5'
  sheet.getCell('A4').value = 'Shipout: 2026-11-16 10:00:00'
  sheet.getRow(6).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  rows.forEach((r, i) => {
    sheet.getRow(i + 7).values = r
  })
  sheet.getCell('G1').value = 'Preserve extra metadata'
  for (const [key, value] of Object.entries(overrides)) sheet.getCell(key).value = value ?? null
  return {
    requestId: crypto.randomUUID(),
    filename: 'Order List.xlsx',
    base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64'),
    warehouse: 'A1C5',
  }
}
async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(readFileSync('migrations/0049_order_sorting.sql', 'utf8'))
  db.exec(readFileSync('migrations/0052_pack_orders.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = db.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: async () => s.get(...values) ?? null,
      all: async () => ({ results: s.all(...values) }),
      run: async () => ({ meta: s.run(...values) }),
      sync: () => s.run(...values),
    }
  }
  const hooks: { beforeBatch?: () => Promise<void> } = {}
  const DB = {
    prepare,
    batch: async (ss: ReturnType<typeof prepare>[]) => {
      await hooks.beforeBatch?.()
      db.exec('BEGIN')
      try {
        const out = ss.map((s) => s.sync())
        db.exec('COMMIT')
        return out
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  const objects = new Map<string, Uint8Array>()
  const ARCHIVE = {
    put: async (key: string, value: string | Uint8Array) => {
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value.slice())
    },
    get: async (key: string) => {
      const value = objects.get(key)
      return value
        ? {
            body: new Response(value.slice().buffer).body,
            arrayBuffer: async () => value.slice().buffer,
            json: async () => JSON.parse(new TextDecoder().decode(value)),
          }
        : null
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
  } as unknown as R2Bucket
  const sorting = new OrderSorting({ DB, ARCHIVE }),
    service = new PackOrders({ DB, ARCHIVE })
  const template = new ExcelJS.Workbook()
  template.addWorksheet('Details')
  template.addWorksheet('Raw')
  const file = {
    name: 'template.xlsx',
    base64: Buffer.from(await template.xlsx.writeBuffer()).toString('base64'),
  }
  await sorting.configure(
    'admin',
    { revision: 0, rows: [], attributeFile: file, templateFile: file },
    'admin',
  )
  return { db, objects, hooks, sorting, service }
}
it('archives complete original bytes, sorts server rows, and preserves original row indexes', async () => {
  const f = await fixture(),
    input = await source([row(), row('HUAB-X', 'T2', 3)])
  const batch = await f.service.import(device, input)
  expect(batch).toMatchObject({
    totalRows: 2,
    newRows: 2,
    skippedRows: 0,
    state: 'LABELS_PENDING',
    date: '2026-11-16',
  })
  expect(batch.labels.map((l) => l.rowIndex)).toEqual([0, 1])
  expect(batch.plan?.totalUnits).toBe(5)
  expect(Buffer.from(await (await f.service.source(batch.id)).object.arrayBuffer())).toEqual(
    Buffer.from(input.base64, 'base64'),
  )
  expect((await f.sorting.state()).config?.revision).toBe(2)
  expect((await f.sorting.state()).runs).toHaveLength(0)
  expect(await f.service.view(batch.id)).toEqual(batch)
  expect((await f.service.list()).batches.map((b) => b.id)).toContain(batch.id)
})
it('replays requests and semantic exports across devices without changing attributes', async () => {
  const f = await fixture(),
    input = await source([row()]),
    batch = await f.service.import(device, input)
  expect(await f.service.import(device, input)).toEqual(batch)
  expect(
    (await f.service.import({ ...device, id: 'device-2' }, { ...input, requestId: crypto.randomUUID() }))
      .id,
  ).toBe(batch.id)
  expect((await f.service.import(device, await source([row()]))).id).toBe(batch.id)
  await expect(
    f.service.import(device, { ...(await source([row('DIFFERENT')])), requestId: input.requestId }),
  ).rejects.toThrow('请求')
  expect((await f.sorting.state()).config?.revision).toBe(2)
})
it('skips overlap, quarantines quantity changes, and only sorts truly new rows', async () => {
  const f = await fixture()
  await f.service.import(device, await source([row(), row('HUAB-X', 'T2')]))
  const batch = await f.service.import(
    device,
    await source([row(), row('HUAB-X', 'T2', 5), row('HUNI-LP', 'T3')]),
  )
  expect(batch).toMatchObject({
    totalRows: 3,
    newRows: 1,
    skippedRows: 1,
    conflicts: [{ rowIndex: 1, previousUnits: 2, units: 5 }],
  })
  expect(batch.labels).toMatchObject([{ rowIndex: 2, sku: 'HUNI-LP' }])
  expect(batch.plan?.totalRows).toBe(1)
  const noNew = await f.service.import(device, await source([row()], { G1: 'new snapshot' }))
  expect(noNew).toMatchObject({ state: 'NO_NEW', newRows: 0, skippedRows: 1, plan: null, labels: [] })
})
it.each([
  { A2: 'Orders: 1 SKUs: 1 Units: 8' },
  { A3: 'Warehouse: OTHER' },
  { A4: 'Shipout: 2026-02-30' },
  { B6: 'bad header' },
])('rejects invalid exported summaries and warehouse/date/header: %j', async (overrides) => {
  const f = await fixture()
  await expect(f.service.import(device, await source([row()], overrides))).rejects.toThrow()
  expect((await f.sorting.state()).config?.revision).toBe(1)
})
it('uses authenticated seller scope and never accepts seller overrides', async () => {
  const f = await fixture(),
    input = await source([row()]),
    batch = await f.service.import(device, input)
  const other = { ...device, scope_json: device.scope_json.replace('seller"', 'other"') }
  await expect(f.service.get(other, batch.id)).rejects.toThrow()
  await expect(f.service.import(device, { ...input, seller: 'other' })).rejects.toThrow()
  expect((await f.service.import(other, input)).newRows).toBe(1)
})
it('retries stale snapshots transactionally and retains only one ledger identity per scope', async () => {
  const f = await fixture(),
    input = await source([row()])
  let reached!: () => void, release!: () => void
  const ready = new Promise<void>((r) => {
      reached = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  f.hooks.beforeBatch = async () => {
    f.hooks.beforeBatch = undefined
    reached()
    await gate
  }
  const pending = f.service.import(device, input)
  await ready
  const winner = await f.service.import(
    { ...device, id: 'device-2' },
    { ...input, requestId: crypto.randomUUID() },
  )
  release()
  expect((await pending).id).toBe(winner.id)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM pack_order_rows').get()?.n).toBe(1)
  expect((await f.sorting.state()).config?.revision).toBe(2)
})
it('reclassifies new rows with latest admin config after a transaction race', async () => {
  const f = await fixture(),
    input = await source([row()])
  let reached!: () => void, release!: () => void
  const ready = new Promise<void>((r) => {
      reached = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  f.hooks.beforeBatch = async () => {
    f.hooks.beforeBatch = undefined
    reached()
    await gate
  }
  const pending = f.service.import(device, input)
  await ready
  await f.sorting.configure(
    'admin',
    {
      revision: 1,
      rows: [['OVERRIDE', null, row()[1], row()[1], null, null, null, null, null, null, null]],
    },
    'admin',
  )
  release()
  expect((await pending).labels[0].group).toBe('OVERRIDE')
  expect((await f.sorting.state()).config?.revision).toBe(3)
})
const pdf = async (mark = 'one') => {
  const doc = await PDFDocument.create()
  doc.addPage().drawText(mark)
  return Buffer.from(await doc.save()).toString('base64')
}
it('stores private immutable per-row PDFs, rejects wrong slots, and completes only all labels', async () => {
  const f = await fixture(),
    batch = await f.service.import(device, await source([row(), row('HUAB-X', 'T2')]))
  const input = { rowIndex: 1, filename: 'native.pdf', base64: await pdf() }
  expect((await f.service.label(device, batch.id, input)).state).toBe('LABELS_PENDING')
  expect((await f.service.label(device, batch.id, input)).labels[1].received).toBe(true)
  await expect(
    f.service.label(device, batch.id, { ...input, base64: await pdf('other') }),
  ).rejects.toThrow('标签')
  await expect(f.service.label(device, batch.id, { ...input, rowIndex: 99 })).rejects.toThrow()
  await expect(
    f.service.label(device, batch.id, {
      ...input,
      rowIndex: 0,
      base64: Buffer.from('not pdf').toString('base64'),
    }),
  ).rejects.toThrow()
  await expect(
    f.service.label(
      { ...device, scope_json: device.scope_json.replace('seller"', 'other"') },
      batch.id,
      input,
    ),
  ).rejects.toThrow()
  const done = await f.service.label(device, batch.id, { ...input, rowIndex: 0 })
  expect(done.state).toBe('READY')
  expect(
    Buffer.from(await (await f.service.labelFile(batch.id, 1)).object.arrayBuffer()).toString('base64'),
  ).toBe(input.base64)
})
it('rejects corrupt PDFs with valid header and EOF markers and empty PDFs', async () => {
  const f = await fixture(),
    batch = await f.service.import(device, await source([row()]))
  const corrupt = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Corrupt (yes) >>\nendobj\n%%EOF\n').toString(
    'base64',
  )
  await expect(
    f.service.label(device, batch.id, { rowIndex: 0, filename: 'corrupt.pdf', base64: corrupt }),
  ).rejects.toThrow()
  const empty = await PDFDocument.create()
  await expect(
    f.service.label(device, batch.id, {
      rowIndex: 0,
      filename: 'empty.pdf',
      base64: Buffer.from(await empty.save({ addDefaultPage: false })).toString('base64'),
    }),
  ).rejects.toThrow()
  expect((await f.service.get(device, batch.id)).state).toBe('LABELS_PENDING')
})
it('paginates Pack history without losing old source or label downloads', async () => {
  const f = await fixture(),
    input = await source([row()])
  const first = await f.service.import(device, input)
  for (let i = 0; i < 100; i++)
    await f.service.import(device, await source([row()], { G1: `snapshot ${i}` }))
  const page = await f.service.list()
  expect(page.batches).toHaveLength(100)
  expect(page.next).not.toBeNull()
  const older = await f.service.list(page.next)
  expect(older.batches).toHaveLength(1)
  expect(older.next).toBeNull()
  expect(older.batches[0].id).toBe(first.id)
  expect(Buffer.from(await (await f.service.source(first.id)).object.arrayBuffer())).toEqual(
    Buffer.from(input.base64, 'base64'),
  )
})
it('atomically rolls back all batch/ledger/config writes if the label slots cannot commit', async () => {
  const f = await fixture()
  f.db.exec(
    "CREATE TRIGGER fail_labels BEFORE INSERT ON pack_order_labels BEGIN SELECT RAISE(ABORT, 'private database details'); END",
  )
  await expect(f.service.import(device, await source([row()]))).rejects.toThrow('尚未提交')
  expect((await f.sorting.state()).config).toMatchObject({ revision: 1, rows: [] })
  for (const table of [
    'pack_order_batches',
    'pack_order_requests',
    'pack_order_rows',
    'pack_order_labels',
  ])
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
})
it('concurrent overlapping exports classify the loser against the winning row ledger', async () => {
  const f = await fixture(),
    shared = row(),
    a = row('HUAB-ALPHA', 'TA'),
    b = row('HUAB-BETA', 'TB')
  let reached!: () => void, release!: () => void
  const ready = new Promise<void>((r) => {
      reached = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  f.hooks.beforeBatch = async () => {
    f.hooks.beforeBatch = undefined
    reached()
    await gate
  }
  const pending = f.service.import(device, await source([shared, a]))
  await ready
  const winner = await f.service.import(device, await source([shared, b]))
  release()
  const loser = await pending
  expect(winner.newRows).toBe(2)
  expect(loser).toMatchObject({ newRows: 1, skippedRows: 1 })
  expect(loser.labels).toMatchObject([{ rowIndex: 1, sku: 'HUAB-ALPHA' }])
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM pack_order_rows').get()?.n).toBe(3)
  expect((await f.sorting.state()).config?.rows).toHaveLength(3)
  expect((await f.sorting.state()).config?.revision).toBe(3)
})
it('concurrent differing PDF uploads cannot overwrite the winning private object', async () => {
  const f = await fixture(),
    batch = await f.service.import(device, await source([row()]))
  const first = { rowIndex: 0, filename: 'one.pdf', base64: await pdf('one') },
    second = { ...first, filename: 'two.pdf', base64: await pdf('two') }
  const results = await Promise.allSettled([
    f.service.label(device, batch.id, first),
    f.service.label(device, batch.id, second),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  const winner = results[0].status === 'fulfilled' ? first : second
  const archived = await f.service.labelFile(batch.id, 0)
  expect(archived.name).toBe(winner.filename)
  expect(Buffer.from(await archived.object.arrayBuffer()).toString('base64')).toBe(winner.base64)
})
it('quarantines conflicting repeated identities inside one export and skips identical duplicate rows', async () => {
  const f = await fixture()
  const batch = await f.service.import(
    device,
    await source([row(), row(undefined, undefined, 5), row('NEW', 'T2'), row('NEW', 'T2')]),
  )
  expect(batch).toMatchObject({ totalRows: 4, newRows: 1, skippedRows: 1 })
  expect(batch.conflicts).toHaveLength(2)
  expect(batch.labels[0].rowIndex).toBe(2)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM pack_order_rows').get()?.n).toBe(1)
})

it('rejects oversized label groups before reserving deduplication identities', async () => {
 const f=await fixture()
 await expect(f.service.import(device,await source([row('HUJM-X','T1',5001)]))).rejects.toMatchObject({code:'LABEL_BATCH_TOO_LARGE'})
 expect(f.db.prepare('SELECT COUNT(*) AS n FROM pack_order_rows').get()?.n).toBe(0)
 const batch=await f.service.import(device,await source([row('HUJM-X','T1',2)]))
 expect(batch.newRows).toBe(1)
})
