import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import ExcelJS from 'exceljs'
import { expect, it } from 'vitest'
import { requiredRole } from '../../apps/api/src/access'
import { OrderSorting } from '../../packages/order-sorting/service'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('migrations/0049_order_sorting.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = db.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: async () => s.get(...values) ?? null,
      all: async () => ({ results: s.all(...values) }),
      run: async () => ({ meta: s.run(...values) }),
    }
  }
  const DB = {
    prepare,
    batch: async (ss: ReturnType<typeof prepare>[]) => {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of ss) out.push(await s.run())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  const objects = new Map<string, string | Uint8Array>()
  const hooks: { beforeResultPut?: () => Promise<void> } = {}
  const ARCHIVE = {
    put: async (k: string, v: string | Uint8Array) => {
      if (k.startsWith('order-sorting/results/')) await hooks.beforeResultPut?.()
      objects.set(k, v)
    },
    get: async (k: string) => {
      const v = objects.get(k)
      if (v === undefined) return null
      const b = typeof v === 'string' ? new TextEncoder().encode(v) : v
      return {
        body: new Response(b.slice().buffer as ArrayBuffer).body,
        arrayBuffer: async () => b.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(b)),
      }
    },
  } as unknown as R2Bucket
  return { db, objects, hooks, service: new OrderSorting({ DB, ARCHIVE }) }
}
async function templateFile(header = '名称', styled = false) {
  const book = new ExcelJS.Workbook()
  const detail = book.addWorksheet('订单明细')
  detail.getCell('B3').value = header
  detail.getCell('A4').value = 'old order'
  if (styled) detail.getCell('B3').font = { bold: true }
  book.addWorksheet('亚马逊订单').getCell('A1').value = 'Product title'
  return { name: 'fixture.xlsx', base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64') }
}
const file = await templateFile()
const rows = [
  ['HUAB-GL', 'AB', 'HUAB-MKB', 'HUAB-MKB-JIT-001', '杯子', null, null, 2, 'OPP', null, null],
]
const order = { date: '2026-11-16', rows: [['Mug', 'HUAB-MKB-JIT-001', 'FNSKU', 'TRANSFER', 3]] }
const init = (f: ReturnType<typeof fixture>) =>
  f.service.configure('admin', { revision: 0, rows, attributeFile: file, templateFile: file }, 'owner')

it('rolls back a generation when another run commits after its snapshot was read', async () => {
  const f = fixture()
  try {
    await init(f)
    let reached!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.hooks.beforeResultPut = async () => {
      f.hooks.beforeResultPut = undefined
      reached()
      await gate
    }
    const stale = f.service.run(
      {
        id: crypto.randomUUID(),
        revision: 1,
        filename: 'stale.xlsx',
        order: { ...order, rows: [...order.rows, ['New', 'NEW-JIT-1', 'F', 'T', 1]] },
      },
      'operator',
    )
    await ready
    const winner = await f.service.run(
      { id: crypto.randomUUID(), revision: 1, filename: 'winner.xlsx', order },
      'operator',
    )
    const rejected = expect(stale).rejects.toThrow('变化')
    release()
    await rejected
    const state = await f.service.state()
    expect(state.config?.rows).toEqual(rows)
    expect(state.config?.revision).toBe(2)
    expect(state.runs.map((run) => run.id)).toEqual([winner.id])
    expect(f.db.prepare('SELECT count(*) AS n FROM order_sorting_outputs').get()?.n).toBe(1)
  } finally {
    f.db.close()
  }
})

it('pages history without losing runs sharing a timestamp and retains older downloads', async () => {
  const f = fixture()
  try {
    await init(f)
    const ids: string[] = []
    for (let revision = 1; revision <= 34; revision++) {
      const id = crypto.randomUUID()
      ids.push(id)
      await f.service.run({ id, revision, filename: 'orders.xlsx', order }, 'operator')
    }
    f.db.exec('UPDATE order_sorting_runs SET created_at=123456')
    const first = await f.service.history(null)
    expect(first.runs).toHaveLength(30)
    const second = await f.service.history(first.next)
    expect(second.runs).toHaveLength(4)
    expect(second.next).toBeNull()
    expect(new Set([...first.runs, ...second.runs].map((r) => r.id))).toEqual(new Set(ids))
    expect((await f.service.getRun(second.runs[3].id)).plan.totalRows).toBe(1)
  } finally {
    f.db.close()
  }
})

it('same-name comparison includes template content but ignores style-only changes', async () => {
  const f = fixture()
  try {
    await init(f)
    await f.service.run(
      { id: crypto.randomUUID(), revision: 1, filename: 'one.xlsx', order },
      'operator',
    )
    await f.service.configure(
      'admin',
      { revision: 2, rows, templateFile: await templateFile('名称', true) },
      'owner',
    )
    await f.service.run(
      { id: crypto.randomUUID(), revision: 3, filename: 'same.xlsx', order },
      'operator',
    )
    await f.service.configure(
      'admin',
      { revision: 4, rows, templateFile: await templateFile('新名称') },
      'owner',
    )
    await expect(
      f.service.run(
        { id: crypto.randomUUID(), revision: 5, filename: 'changed.xlsx', order },
        'operator',
      ),
    ).rejects.toThrow('同名')
    expect((await f.service.state()).runs).toHaveLength(2)
  } finally {
    f.db.close()
  }
})

it('initializes private configuration and requires current revision to edit; only admin configures', async () => {
  const f = fixture()
  try {
    await expect(
      f.service.configure(
        'operator',
        { revision: 0, rows, attributeFile: file, templateFile: file },
        'operator',
      ),
    ).rejects.toThrow()
    await init(f)
    const state = await f.service.state()
    expect(state.config).toMatchObject({ revision: 1, rows })
    expect(await f.service.asset(state.config!.attributeKey)).not.toBeNull()
    await expect(f.service.asset('missing')).rejects.toThrow()
    await f.service.configure('admin', { revision: 1, rows: [['MANUAL', ...rows[0].slice(1)]] }, 'owner')
    await expect(f.service.configure('admin', { revision: 1, rows }, 'owner')).rejects.toThrow('变化')
    expect((await f.service.state()).config?.revision).toBe(2)
  } finally {
    f.db.close()
  }
})
it('preview does not mutate; generating records a stable plan, appends attributes and replays the same request', async () => {
  const f = fixture()
  try {
    await init(f)
    const input = { date: '2026-11-16', rows: [['New', 'HUVT.MP-18Y-JIT-496', 'F', 'T', 2]] }
    const preview = await f.service.preview({ revision: 1, order: input })
    expect(preview.additions).toHaveLength(1)
    expect((await f.service.state()).config?.revision).toBe(1)
    const command = { id: crypto.randomUUID(), revision: 1, filename: 'orders.xlsx', order: input }
    const result = await f.service.run(command, 'operator')
    expect(result.plan.groups[0]).toMatchObject({ name: 'HUVT-WZ', units: 2 })
    expect((await f.service.state()).config?.rows).toHaveLength(2)
    expect((await f.service.run(command, 'operator')).id).toBe(result.id)
    expect((await f.service.getRun(result.id)).plan).toEqual(result.plan)
    await expect(f.service.run({ ...command, order }, 'operator')).rejects.toThrow('请求')
    expect((await f.service.state()).runs).toHaveLength(1)
  } finally {
    f.db.close()
  }
})
it('allows identical same-name results but atomically rejects differing output before attribute changes', async () => {
  const f = fixture()
  try {
    await init(f)
    await f.service.run(
      { id: crypto.randomUUID(), revision: 1, filename: 'one.xlsx', order },
      'operator',
    )
    await f.service.run(
      { id: crypto.randomUUID(), revision: 2, filename: 'again.xlsx', order },
      'operator',
    )
    const changed = {
      date: order.date,
      rows: [
        ...order.rows,
        ['Mug', 'HUAB-MKB-JIT-001', 'FNSKU', 'TRANSFER-2', 1],
        ['New', 'NEW-JIT-1', 'F', 'T', 1],
      ],
    }
    await expect(
      f.service.run(
        { id: crypto.randomUUID(), revision: 3, filename: 'changed.xlsx', order: changed },
        'operator',
      ),
    ).rejects.toThrow('同名')
    const state = await f.service.state()
    expect(state.config?.revision).toBe(3)
    expect(state.config?.rows).toEqual(rows)
    expect(state.runs).toHaveLength(2)
  } finally {
    f.db.close()
  }
})
it('rejects stale generation, validates inputs, and protects import/run roles', async () => {
  const f = fixture()
  try {
    await init(f)
    await f.service.configure('admin', { revision: 1, rows }, 'owner')
    await expect(
      f.service.run({ id: crypto.randomUUID(), revision: 1, filename: 'order.xlsx', order }, 'operator'),
    ).rejects.toThrow('变化')
    await expect(
      f.service.preview({ revision: 2, order: { ...order, date: '2026-02-30' } }),
    ).rejects.toThrow()
    expect(requiredRole('POST', '/api/order-sorting/config')).toBe('admin')
    expect(requiredRole('POST', '/api/order-sorting/run')).toBe('operator')
    expect(requiredRole('POST', '/api/order-sorting/preview')).toBe('operator')
  } finally {
    f.db.close()
  }
})
