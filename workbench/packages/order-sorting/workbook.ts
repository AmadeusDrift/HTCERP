import type { CellValue, Cell as ExcelCell, Workbook, Worksheet } from 'exceljs'
import type { AttributeRow, Cell, OrderInput, OrderRow, SortGroup, SortPlan } from './rules'

// Keep spreadsheet/ZIP implementations out of the server's pure-rule dependency graph.
async function load(bytes: Uint8Array): Promise<Workbook> {
  const ExcelJS = await import('exceljs')
  const book = new (ExcelJS.default ?? ExcelJS).Workbook()
  await book.xlsx.load(bytes as never)
  return book
}

function primitive(value: CellValue | undefined): Cell {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date)
    return value
      .toISOString()
      .replace('T', ' ')
      .replace(/\.000Z$/, '')
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('text' in value) return value.text
  if ('error' in value) return value.error
  if ('result' in value) return primitive(value.result)
  return null
}

function value(cell: ExcelCell, formulas = false): Cell {
  if (cell.type === 6) return formulas ? `=${cell.formula}` : primitive(cell.result)
  return primitive(cell.value)
}

function write(cell: ExcelCell, next: Cell): void {
  // Retain the original formula object (including its cached result) if unchanged.
  if (value(cell, true) === next) return
  cell.value = typeof next === 'string' && next.startsWith('=') ? { formula: next.slice(1) } : next
}

export async function parseOrder(bytes: Uint8Array): Promise<OrderInput> {
  const book = await load(bytes)
  const sheet = book.getWorksheet('Order List')
  if (!sheet) throw new Error('缺少 Order List 工作表')
  const date = String(value(sheet.getCell('A4')) ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0]
  const parsed = date ? new Date(`${date}T00:00:00Z`) : null
  if (
    !date ||
    !parsed ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error('Order List A4 日期无效')
  const header = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  if (header.some((label, index) => value(sheet.getCell(6, index + 1)) !== label))
    throw new Error('Order List 表头与模板不符')
  const rows: OrderRow[] = []
  for (let r = 7; r <= sheet.rowCount; r += 1) {
    const source = sheet.getRow(r)
    let nonempty = false
    source.eachCell((cell) => {
      if (value(cell) !== null) nonempty = true
    })
    if (!nonempty) continue
    const [title, sku, fnsku, transfer, units] = Array.from({ length: 5 }, (_, c) =>
      value(source.getCell(c + 1)),
    )
    if (
      typeof sku !== 'string' ||
      !sku ||
      typeof fnsku !== 'string' ||
      !fnsku ||
      typeof transfer !== 'string' ||
      !transfer ||
      typeof units !== 'number' ||
      !Number.isFinite(units)
    )
      throw new Error(`订单记录不完整：第 ${r} 行`)
    rows.push([title, sku, fnsku, transfer, units])
  }
  return { date, rows }
}

export async function parseAttributes(bytes: Uint8Array): Promise<{ rows: AttributeRow[] }> {
  const sheet = (await load(bytes)).worksheets[0]
  if (!sheet) throw new Error('属性清单缺少工作表')
  const rows: AttributeRow[] = []
  for (let r = 2; r <= sheet.rowCount; r += 1)
    rows.push(Array.from({ length: 11 }, (_, c) => value(sheet.getCell(r, c + 1), true)))
  return { rows }
}

function templateSheets(book: Workbook): [Worksheet, Worksheet] {
  if (book.worksheets.length !== 2) throw new Error('分拣模板必须包含订单明细与原始订单两张工作表')
  return [book.worksheets[0], book.worksheets[1]]
}

export async function validateTemplate(bytes: Uint8Array): Promise<void> {
  templateSheets(await load(bytes))
}

export async function templateContent(bytes: Uint8Array): Promise<string> {
  return templateWorkbookContent(await load(bytes))
}

export function templateWorkbookContent(book: Workbook): string {
  const sheets = templateSheets(book)
  const overwritten = new Set(['A1', 'B2', 'E2', 'H2'])
  return JSON.stringify(
    sheets.map((sheet, index) => {
      const cells: [number, number, Cell][] = []
      for (let r = 1; r <= (index === 0 ? 3 : 1); r += 1) {
        sheet.getRow(r).eachCell((cell, column) => {
          // ExcelJS resolves merged aliases to their master's value; exported
          // worksheet values contain data only at the master coordinate.
          if (cell.isMerged && cell.master.address !== cell.address) return
          if (index === 0 && overwritten.has(cell.address)) return
          const retained = value(cell, true)
          if (retained !== null) cells.push([r, column, retained])
        })
      }
      return { name: sheet.name, cells }
    }),
  )
}

function clearTail(sheet: Worksheet, start: number): void {
  // ExcelJS 4.4 spliceRows(start, remaining) leaves tail rows untouched. Reset
  // their public row models instead; empty row models are omitted on save.
  for (let index = start; index <= sheet.rowCount; index += 1) {
    const row = sheet.findRow(index)
    if (!row) continue
    row.model = { number: index, cells: [], style: {}, hidden: false, outlineLevel: 0 }
  }
}

export async function exportGroup(
  bytes: Uint8Array,
  group: SortGroup,
  date: string,
): Promise<Uint8Array> {
  const book = await load(bytes)
  return exportGroupWorkbook(book, group, date)
}

/** Share layout rules while allowing Workers to use ExcelJS's native document entry. */
export async function exportGroupWorkbook(book: Workbook, group: SortGroup, date: string): Promise<Uint8Array> {
  const [detail, raw] = templateSheets(book)
  const styles = Array.from({ length: Math.max(14, detail.columnCount) }, (_, c) =>
    structuredClone(detail.getCell(4, c + 1).style),
  )
  const rawStyles = Array.from({ length: Math.max(5, raw.columnCount) }, (_, c) =>
    structuredClone(raw.getCell(2, c + 1).style),
  )
  clearTail(detail, 4)
  clearTail(raw, 2)
  write(detail.getCell('A1'), `${group.name} 订单`)
  write(detail.getCell('B2'), `${group.name}-${date.slice(2).replaceAll('-', '')}`)
  for (const [index, values] of group.detail.entries()) {
    const row = detail.getRow(index + 4)
    values.forEach((next, c) => {
      write(row.getCell(c + 1), c === 4 ? null : next)
    })
    styles.forEach((style, c) => {
      row.getCell(c + 1).style = structuredClone(style)
    })
  }
  for (const [index, values] of group.raw.entries()) {
    const row = raw.getRow(index + 2)
    values.forEach((next, c) => {
      write(row.getCell(c + 1), next)
    })
    rawStyles.forEach((style, c) => {
      row.getCell(c + 1).style = structuredClone(style)
    })
  }
  write(detail.getCell('E2'), `=SUM(H4:H${Math.max(3, group.detail.length + 3)})`)
  write(detail.getCell('H2'), `=SUM(J4:J${Math.max(3, group.detail.length + 3)})`)
  return new Uint8Array(await book.xlsx.writeBuffer())
}

export async function exportAttributes(bytes: Uint8Array, rows: AttributeRow[]): Promise<Uint8Array> {
  const book = await load(bytes)
  const sheet = book.worksheets[0]
  if (!sheet) throw new Error('属性清单缺少工作表')
  let last = sheet.rowCount
  while (
    last > 1 &&
    Array.from({ length: sheet.columnCount }, (_, c) => value(sheet.getCell(last, c + 1), true)).every(
      (next) => next === null,
    )
  )
    last -= 1
  const styles = Array.from({ length: Math.max(11, sheet.columnCount) }, (_, c) =>
    structuredClone(sheet.getCell(last, c + 1).style),
  )
  clearTail(sheet, rows.length + 2)
  rows.forEach((values, index) => {
    const row = sheet.getRow(index + 2)
    for (let c = 0; c < 11; c += 1) write(row.getCell(c + 1), values[c] ?? null)
    if (index + 2 > last && values.some((next) => next !== null))
      styles.forEach((style, c) => {
        row.getCell(c + 1).style = structuredClone(style)
      })
  })
  const updatedLast = rows.findLastIndex((row) => row.some((next) => next !== null)) + 2
  if (sheet.autoFilter && updatedLast > last) {
    if (typeof sheet.autoFilter === 'string')
      sheet.autoFilter = sheet.autoFilter.replace(/\d+$/, String(updatedLast))
    else {
      const filter = sheet.autoFilter
      if (typeof filter.to === 'string') filter.to = filter.to.replace(/\d+$/, String(updatedLast))
      else filter.to.row = updatedLast
    }
  }
  return new Uint8Array(await book.xlsx.writeBuffer())
}

export async function exportZip(bytes: Uint8Array, plan: SortPlan): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  for (const group of plan.groups) zip.file(group.filename, await exportGroup(bytes, group, plan.date))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
