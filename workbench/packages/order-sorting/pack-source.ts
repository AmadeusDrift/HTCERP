import type { CellValue } from 'exceljs'
import { PublicError } from '../contracts/errors'
import type { Cell, OrderInput, OrderRow } from './rules'

function primitive(value: CellValue | undefined): Cell {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('result' in value) return primitive(value.result)
  if ('text' in value) return value.text
  return null
}

export async function parsePackSource(
  bytes: Uint8Array,
  warehouse: string,
): Promise<{ order: OrderInput; snapshot: string }> {
  try {
    // Same native document entry/Workers stream alias as template-server.ts.
    const { default: Workbook } = await import('exceljs/lib/doc/workbook.js')
    const book = new Workbook()
    await book.xlsx.load(bytes as never)
    const sheet = book.getWorksheet('Order List')
    if (!sheet || sheet.rowCount > 10006 || sheet.columnCount > 200) throw new Error()
    const cell = (address: string) => primitive(sheet.getCell(address).value)
    if (String(cell('A3') ?? '').trim() !== `Warehouse: ${warehouse}`) throw new Error()
    const date = /^Shipout:\s*(\d{4}-\d{2}-\d{2})(?:\s|$)/.exec(String(cell('A4') ?? ''))?.[1]
    if (!date || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error()
    const headers = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
    if (headers.some((h, i) => primitive(sheet.getCell(6, i + 1).value) !== h)) throw new Error()
    const rows: OrderRow[] = []
    for (let index = 7; index <= sheet.rowCount; index++) {
      const source = sheet.getRow(index)
      let nonempty = false
      source.eachCell((c) => {
        if (primitive(c.value) !== null) nonempty = true
      })
      if (!nonempty) continue
      const [title, sku, fnsku, transfer, units] = Array.from({ length: 5 }, (_, i) =>
        primitive(source.getCell(i + 1).value),
      )
      if (
        typeof sku !== 'string' ||
        !sku.trim() ||
        sku.length > 512 ||
        typeof fnsku !== 'string' ||
        !fnsku.trim() ||
        fnsku.length > 512 ||
        typeof transfer !== 'string' ||
        !transfer.trim() ||
        transfer.length > 1000 ||
        typeof units !== 'number' ||
        !Number.isSafeInteger(units) ||
        units <= 0
      )
        throw new Error()
      rows.push([title, sku, fnsku, transfer, units])
    }
    const totals = /^Orders:\s*(\d+)\s*,?\s*SKUs:\s*(\d+)\s*,?\s*Units:\s*(\d+)\s*$/.exec(
      String(cell('A2') ?? ''),
    )
    if (
      !rows.length ||
      !totals ||
      Number(totals[1]) !== new Set(rows.map((r) => r[3])).size ||
      Number(totals[2]) !== new Set(rows.map((r) => r[1])).size ||
      Number(totals[3]) !== rows.reduce((sum, r) => sum + r[4], 0)
    )
      throw new Error()
    // Keep every sheet/cell (including extra columns and cached formula objects),
    // independently of the five projected sorting columns. Full XLSX is archived too.
    const snapshot = JSON.stringify(
      book.worksheets.map((s) => {
        if (s.rowCount > 20000 || s.columnCount > 200) throw new Error()
        const cells: [number, number, CellValue][] = []
        s.eachRow((r, ri) =>
          r.eachCell((c, ci) => {
            cells.push([ri, ci, c.value])
          }),
        )
        return { name: s.name, cells }
      }),
    )
    if (new TextEncoder().encode(snapshot).length > 4_000_000) throw new Error()
    return { order: { date, rows }, snapshot }
  } catch {
    throw new PublicError(
      'INVALID_INPUT',
      '订单文件无法校验：请检查 Order List 表头、仓库、Shipout 日期与 Orders/SKUs/Units 汇总。',
      400,
    )
  }
}
