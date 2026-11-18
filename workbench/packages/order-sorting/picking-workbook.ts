import type { Workbook } from 'exceljs'
import { Buffer } from 'node:buffer'
import type { ProductImage } from '../product-images/service'
import type { SortGroup } from './rules'

export const pickingMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const pickingFilename = (group: SortGroup) =>
  group.filename.replace(/\.xlsx$/i, '-带图备货单.xlsx')

export async function exportPickingSheet(
  group: SortGroup,
  date: string,
  images: Map<string, ProductImage>,
): Promise<Uint8Array> {
  // Native document entry also works in Workers; do not import the browser scheduler there.
  const { default: WorkbookClass } = await import('exceljs/lib/doc/workbook.js')
  const book = new WorkbookClass() as Workbook
  book.creator = 'HTC ERP'
  book.created = new Date(date + 'T00:00:00Z')
  book.calcProperties.fullCalcOnLoad = true
  const sheet = book.addWorksheet('备货单'),
    raw = book.addWorksheet('原始订单')
  sheet.columns = [7, 17, 14, 17, 24, 29, 20, 11, 12, 16, 13, 16, 22].map((width) => ({ width }))
  sheet.mergeCells('A1:M1')
  sheet.getCell('A1').value = `${group.name} ${date} · 共${group.units}件备货单`
  sheet.getCell('A1').font = { name: '微软雅黑', size: 18, bold: true }
  sheet.getRow(1).height = 34
  sheet.mergeCells('A2:M2')
  sheet.getCell('A2').value = '请按 SKU、FNSKU 和数量核对备货；产品规格与包装以本单明细为准。'
  sheet.getRow(2).height = 28
  sheet.getCell('G3').value = '总数量'
  sheet.getCell('H3').value = { formula: `SUM(H5:H${group.detail.length + 4})`, result: group.units }
  sheet.getCell('J3').value = '总金额'
  const total = group.detail.reduce(
    (n, row) => n + (typeof row[8] === 'number' ? row[8] * Number(row[7]) : 0),
    0,
  )
  sheet.getCell('K3').value = { formula: `SUM(K5:K${group.detail.length + 4})`, result: total }
  sheet.getRow(4).values = [
    '序号',
    '品名',
    '产品尺寸',
    '产品颜色/规格',
    '图片',
    '编号/亚马逊SKU',
    '产品条形码/FNSKU',
    '采购数量',
    '单价',
    '包装',
    '金额',
    '包装/工艺',
    '备注',
  ]
  sheet.getRow(4).height = 32
  for (const [i, detail] of group.detail.entries()) {
    const n = i + 5,
      row = sheet.getRow(n),
      sku = String(detail[5]),
      image = images.get(sku)
    row.values = [
      i + 1,
      detail[1],
      detail[2],
      detail[3],
      image ? null : '缺图：请重试取图',
      sku,
      detail[6],
      detail[7],
      detail[8],
      detail[10],
      typeof detail[8] === 'number'
        ? { formula: `H${n}*I${n}`, result: Number(detail[7]) * detail[8] }
        : null,
      detail[11],
      detail[12],
    ]
    row.height = 110
    if (image) {
      const scale = Math.min(150 / image.width, 136 / image.height),
        width = image.width * scale,
        height = image.height * scale
      const id = book.addImage({ buffer: Buffer.from(image.bytes), extension: image.extension })
      sheet.addImage(id, {
        tl: { col: 4 + (168 - width) / 2 / 168, row: n - 1 + (146.67 - height) / 2 / 146.67 },
        ext: { width, height },
        editAs: 'oneCell',
      })
      sheet.getCell(`E${n}`).note = `商品展示主图 · ASIN ${image.asin}`
    }
  }
  for (let n = 2; n <= group.detail.length + 4; n++)
    sheet.getRow(n).eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: '微软雅黑', size: 11, ...(n === 3 || n === 4 ? { bold: true } : {}) }
      cell.alignment = { vertical: 'middle', horizontal: n === 4 ? 'center' : 'left', wrapText: true }
      if (n >= 4)
        cell.border = Object.fromEntries(
          ['top', 'bottom', 'left', 'right'].map((edge) => [
            edge,
            { style: 'thin', color: { argb: 'FFCCD3DB' } },
          ]),
        )
      if (n === 4) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } }
    })
  sheet.getColumn('I').numFmt = '0.00'
  sheet.getColumn('K').numFmt = '0.00'
  sheet.views = [{ state: 'frozen', ySplit: 4 }]
  sheet.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: '1:4',
    printArea: `A1:M${group.detail.length + 4}`,
    margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 },
  }
  sheet.headerFooter.oddFooter = '第 &P 页 / 共 &N 页'
  raw.addRow(['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units'])
  group.raw.forEach((row) => raw.addRow(row))
  raw.columns = [45, 32, 22, 30, 12].map((width) => ({ width }))
  return new Uint8Array(await book.xlsx.writeBuffer())
}
