import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { sortOrders } from '../../packages/order-sorting/rules'
import {
  exportAttributes,
  exportGroup,
  exportZip,
  parseAttributes,
  parseOrder,
  templateContent,
  validateTemplate,
} from '../../packages/order-sorting/workbook'

const bytes = async (book: ExcelJS.Workbook) => new Uint8Array(await book.xlsx.writeBuffer())
const read = async (data: Uint8Array) => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(data as never)
  return book
}
const source = () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Order List')
  sheet.getCell('A4').value = 'Order date: 2026-11-16'
  sheet.getRow(6).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  sheet.getRow(7).values = ['标题', 'TLB-1', 'FNSKU', 'TRANSFER', { formula: '2-3', result: -1 }]
  sheet.getRow(9).values = ['标题', 'TLB-1', 'FNSKU', 'TRANSFER', 0.5]
  return book
}
const template = () => {
  const book = new ExcelJS.Workbook()
  const detail = book.addWorksheet('订单明细')
  const raw = book.addWorksheet('原始订单')
  detail.mergeCells('A1:N1')
  detail.getCell('A1').value = '旧订单'
  detail.getCell('C2').value = { formula: '1+1', result: 2 }
  detail.getRow(3).values = [
    '序号',
    '名称',
    '颜色',
    '规格',
    '图片',
    'SKU',
    'FNSKU',
    '数量',
    '单价',
    '金额',
    '备注',
    '工艺',
    '供应商',
    '日期',
  ]
  detail.getRow(4).values = Array(14).fill('old')
  detail.getCell('I4').numFmt = '0.00'
  detail.getCell('F4').font = { bold: true }
  raw.getRow(1).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  raw.getRow(2).values = ['old']
  raw.getCell('A2').font = { italic: true }
  return book
}

describe('order sorting workbook adapter', () => {
  it('fingerprints retained template headers while ignoring overwritten cells, old orders and styles', async () => {
    const original = template()
    const signature = await templateContent(await bytes(original))
    const changed = template()
    changed.worksheets[0].getCell('A1').value = 'Different title'
    changed.worksheets[0].getCell('B2').value = 'Different filename'
    changed.worksheets[0].getCell('E2').value = 100
    changed.worksheets[0].getCell('H2').value = 100
    changed.worksheets[0].getCell('F4').value = 'Other old SKU'
    changed.worksheets[0].getCell('Z44').value = 'Old tail outside header width'
    changed.worksheets[1].getCell('Z44').value = 'Old raw tail'
    changed.worksheets[0].getCell('Z3').font = { bold: true }
    changed.worksheets[0].getCell('A3').font = { italic: true }
    expect(await templateContent(await bytes(changed))).toBe(signature)
    changed.worksheets[0].getCell('Z3').value = 'Additional retained header'
    expect(await templateContent(await bytes(changed))).not.toBe(signature)
    changed.worksheets[0].getCell('Z3').value = null
    changed.worksheets[1].getCell('B1').value = 'Different raw header'
    expect(await templateContent(await bytes(changed))).not.toBe(signature)
  })
  it('excludes overwritten merged aliases and includes retained formulas and worksheet names', async () => {
    const book = template()
    book.worksheets[0].mergeCells('B2:C2')
    book.worksheets[0].mergeCells('E2:F2')
    book.worksheets[0].mergeCells('H2:I2')
    const signature = await templateContent(await bytes(book))
    book.worksheets[0].getCell('C2').value = 'Different overwritten merged title'
    book.worksheets[0].getCell('F2').value = 200
    book.worksheets[0].getCell('I2').value = 300
    expect(await templateContent(await bytes(book))).toBe(signature)
    book.worksheets[0].getCell('K2').value = { formula: '1+1', result: 2 }
    const formulaSignature = await templateContent(await bytes(book))
    expect(formulaSignature).not.toBe(signature)
    book.worksheets[0].getCell('K2').value = { formula: '1+1', result: 99 }
    expect(await templateContent(await bytes(book))).toBe(formulaSignature)
    book.worksheets[1].name = 'Different raw name'
    expect(await templateContent(await bytes(book))).not.toBe(formulaSignature)
  })
  it('reads exact header/date locations and cached formula values, retaining duplicate transfers and blank-row gaps', async () => {
    expect(await parseOrder(await bytes(source()))).toEqual({
      date: '2026-11-16',
      rows: [
        ['标题', 'TLB-1', 'FNSKU', 'TRANSFER', -1],
        ['标题', 'TLB-1', 'FNSKU', 'TRANSFER', 0.5],
      ],
    })
  })
  it('rejects wrong headers, impossible dates, missing identifiers and nonnumeric quantities', async () => {
    for (const [cell, value] of [
      ['A6', 'wrong'],
      ['A4', '2026-02-30'],
      ['C7', null],
      ['E7', '2'],
    ] as const) {
      const book = source()
      book.worksheets[0].getCell(cell).value = value
      await expect(parseOrder(await bytes(book))).rejects.toThrow()
    }
  })
  it('preserves attribute gaps/formulas and exports original header, styles and other sheets', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('属性')
    sheet.getRow(1).values = Array.from({ length: 11 }, (_, i) => `标题${i}`)
    sheet.getRow(2).values = [
      null,
      null,
      'TLB',
      'TLB-1',
      '品名',
      null,
      null,
      { formula: '1+2', result: 3 },
    ]
    sheet.getCell('C2').font = { bold: true }
    sheet.getRow(4).values = [null, null, 'UNKNOWN']
    sheet.getCell('C4').font = { italic: true }
    sheet.autoFilter = 'A1:K4'
    book.addWorksheet('保留页').getCell('A1').value = '保持'
    const original = await bytes(book)
    const parsed = await parseAttributes(original)
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.rows[1]).toEqual(Array(11).fill(null))
    expect(parsed.rows[0][7]).toBe('=1+2')
    const plan = sortOrders({ date: '2026-11-16', rows: [['T', 'NEW-1', 'F', 'X', 0]] }, parsed.rows)
    const exported = await read(await exportAttributes(original, plan.attributes))
    expect(exported.worksheets.map((s) => s.name)).toEqual(['属性', '保留页'])
    expect(exported.worksheets[0].getCell('A1').value).toBe('标题0')
    expect(exported.worksheets[0].getCell('H2').formula).toBe('1+2')
    expect(exported.worksheets[0].getCell('H2').result).toBe(3)
    expect(exported.worksheets[0].getCell('C5').font.italic).toBe(true)
    expect(exported.worksheets[0].autoFilter).toBe('A1:K5')
    expect(exported.worksheets[1].getCell('A1').value).toBe('保持')
  })
  it('validates two-sheet templates and generates correct values, formulas and copied row styles', async () => {
    const book = template()
    const original = await bytes(book)
    await expect(validateTemplate(original)).resolves.toBeUndefined()
    const plan = sortOrders(await parseOrder(await bytes(source())), [])
    const exported = await read(await exportGroup(original, plan.groups[0], plan.date))
    const [detail, raw] = exported.worksheets
    expect(exported.worksheets.map((s) => s.name)).toEqual(['订单明细', '原始订单'])
    expect(detail.getCell('A1').value).toBe('HUNI-YW 订单')
    expect(detail.getCell('B2').value).toBe('HUNI-YW-261116')
    expect(detail.getCell('E2').formula).toBe('SUM(H4:H4)')
    expect(detail.getCell('H2').formula).toBe('SUM(J4:J4)')
    expect(detail.getCell('J4').formula).toBe('IF(I4="","",H4*I4)')
    expect(detail.getCell('H4').value).toBe(-0.5)
    expect(detail.getCell('E4').value).toBeNull()
    expect(detail.getCell('I4').numFmt).toBe('0.00')
    expect(detail.getCell('F4').font.bold).toBe(true)
    expect(detail.getCell('C2').formula).toBe('1+1')
    expect(raw.rowCount).toBe(3)
    expect(raw.getCell('A3').font.italic).toBe(true)
    book.addWorksheet('extra')
    await expect(validateTemplate(await bytes(book))).rejects.toThrow()
  })
  it('packages every group under its original filename in ZIP', async () => {
    const JSZip = (await import('jszip')).default
    const plan = sortOrders(
      {
        date: '2026-11-16',
        rows: [
          ['T', 'HUC-1', 'F', 'X', 1],
          ['T', 'TLB-1', 'F', 'X', 1],
        ],
      },
      [],
    )
    const zip = await JSZip.loadAsync(await exportZip(await bytes(template()), plan))
    expect(Object.keys(zip.files).sort()).toEqual(['HUC-261116.xlsx', 'HUNI-YW-261116.xlsx'])
    expect(
      (await read(await zip.file('HUC-261116.xlsx')!.async('uint8array'))).worksheets[0].getCell('H4')
        .value,
    ).toBe(1)
  })
  it('extends attribute filter only to actual additions when styled trailing rows exist', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('属性')
    sheet.getRow(1).values = ['分类', null, '代码']
    sheet.getRow(2).values = ['HUC', null, 'HUC']
    sheet.getCell('C7').font = { bold: true }
    sheet.autoFilter = 'A1:K2'
    const original = await bytes(book)
    const { rows } = await parseAttributes(original)
    const plan = sortOrders({ date: '2026-11-16', rows: [['T', 'NEW-1', 'F', 'X', 1]] }, rows)
    expect(plan.attributes).toHaveLength(6)
    const exported = await read(await exportAttributes(original, plan.attributes))
    expect(exported.worksheets[0].autoFilter).toBe('A1:K3')
    expect(exported.worksheets[0].getCell('C3').value).toBe('NEW')
  })
  it('removes all old template rows when generated groups are shorter than the template', async () => {
    const book = template()
    const [detail, raw] = book.worksheets
    detail.mergeCells('B2:C2')
    detail.mergeCells('E2:F2')
    detail.mergeCells('H2:I2')
    for (let row = 5; row <= 44; row += 1) {
      detail.getRow(row).values = Array(14).fill(`OLD-DETAIL-${row}`)
      detail.getRow(row).height = 32
    }
    for (let row = 3; row <= 42; row += 1) {
      raw.getRow(row).values = Array(5).fill(`OLD-RAW-${row}`)
      raw.getRow(row).height = 28
    }
    const plan = sortOrders({ date: '2026-11-16', rows: [['new', 'HUC-1', 'F', 'T', 1]] }, [])
    const exported = await read(await exportGroup(await bytes(book), plan.groups[0], plan.date))
    expect(exported.worksheets[0].rowCount).toBe(4)
    expect(exported.worksheets[1].rowCount).toBe(2)
    for (const [cell, master] of [
      ['N1', 'A1'],
      ['C2', 'B2'],
      ['F2', 'E2'],
      ['I2', 'H2'],
    ]) {
      expect(exported.worksheets[0].getCell(cell).master.address).toBe(master)
    }
    expect(exported.worksheets[0].getCell('F4').font.bold).toBe(true)
    expect(exported.worksheets[1].getCell('A2').font.italic).toBe(true)
    for (const sheet of exported.worksheets) {
      sheet.eachRow((row) => row.eachCell((cell) => expect(String(cell.value)).not.toContain('OLD-')))
    }
  })
  it('removes all discarded attribute rows when exporting a shorter edited list', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('属性')
    sheet.getRow(1).values = ['分类', null, '代码']
    for (let row = 2; row <= 9; row += 1) {
      sheet.getRow(row).values = ['old', null, `OLD-${row}`]
      sheet.getRow(row).height = 24
    }
    book.addWorksheet('其他').getCell('A1').value = '保留'
    const exported = await read(
      await exportAttributes(await bytes(book), [['HUC', null, 'NEW', ...Array(8).fill(null)]]),
    )
    expect(exported.worksheets[0].rowCount).toBe(2)
    expect(exported.worksheets[0].getCell('C2').value).toBe('NEW')
    expect(exported.worksheets[1].getCell('A1').value).toBe('保留')
    exported.worksheets[0].eachRow((row) =>
      row.eachCell((cell) => expect(String(cell.value)).not.toContain('OLD-')),
    )
  })
})
