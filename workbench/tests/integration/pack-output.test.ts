import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { exportPackBundle, mergePackLabels } from '../../packages/order-sorting/pack-output'
import { sortOrders } from '../../packages/order-sorting/rules'

const plan = sortOrders(
  {
    date: '2026-11-17',
    rows: [
      ['Mug', 'HUAB-X-JIT-1', 'FN1', 'T1', 2],
      ['Sign', 'HUC-Y-JIT-2', 'FN2', 'T2', 1],
    ],
  },
  [],
)
const batch = {
  id: '00000000-0000-4000-8000-000000000001',
  state: 'READY' as const,
  labelSource: 'AMAZON_API' as const,
  labelGroups: [
    { group: 'HUAB', ready: true },
    { group: 'HUC', ready: true },
  ],
  date: plan.date,
  plan,
  conflicts: [],
  labels: [
    {
      rowIndex: 0,
      sku: 'HUAB-X-JIT-1',
      fnsku: 'FN1',
      transferId: 'T1',
      units: 2,
      group: 'HUAB',
      filename: 'one.pdf',
      received: true,
    },
    {
      rowIndex: 1,
      sku: 'HUC-Y-JIT-2',
      fnsku: 'FN2',
      transferId: 'T2',
      units: 1,
      group: 'HUC',
      filename: 'two.pdf',
      received: true,
    },
  ],
}
async function label(width: number, height: number) {
  const pdf = await PDFDocument.create()
  pdf.addPage([width, height]).drawRectangle({ x: 10, y: 10, width: 30, height: 70 })
  return pdf.save()
}

it('copies only requested group labels and retains native page size without duplicating quantities', async () => {
  const fetched: string[] = []
  const bytes = await mergePackLabels(batch, 'HUAB', async (index) => {
    fetched.push(index)
    return label(595, 850)
  })
  const result = await PDFDocument.load(bytes)
  expect(fetched).toEqual(['HUAB'])
  expect(result.getPageCount()).toBe(1)
  expect(result.getPage(0).getSize()).toEqual({ width: 595, height: 850 })
})

it('rejects incomplete or unrecognized labels instead of emitting a partial print file', async () => {
  await expect(
    mergePackLabels(
      { ...batch, labelGroups: batch.labelGroups.map((x) => ({ ...x, ready: false })) },
      'HUAB',
      async () => label(595, 850),
    ),
  ).rejects.toThrow('尚未')
  await expect(mergePackLabels(batch, 'missing', async () => label(595, 850))).rejects.toThrow()
  await expect(mergePackLabels(batch, 'HUAB', async () => new Uint8Array([1, 2, 3]))).rejects.toThrow()
})

it('packages original bytes, compatible group sheets, native labels and conflict records', async () => {
  const template = new ExcelJS.Workbook()
  template.addWorksheet('订单明细').getCell('A3').value = '序号'
  template.addWorksheet('亚马逊订单').addRow(['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units'])
  const source = new Uint8Array([80, 75, 3, 4, 4, 3, 2, 1])
  const bytes = await exportPackBundle(
    batch,
    new Uint8Array(await template.xlsx.writeBuffer()),
    source,
    async () => label(595, 850),
  )
  const zip = await JSZip.loadAsync(bytes)
  expect(await zip.file('原始订单.xlsx')!.async('uint8array')).toEqual(source)
  expect(zip.file('分拣表/HUAB-261117.xlsx')).not.toBeNull()
  expect(zip.file('SKU标签/HUAB-261117.pdf')).not.toBeNull()
  expect(JSON.parse(await zip.file('批次说明.json')!.async('string')).batchId).toBe(batch.id)
})

it('rejects legacy Flex labels even if their old status is ready', async () => {
  await expect(
    mergePackLabels({ ...batch, labelSource: undefined }, 'HUAB', async () => label(595, 850)),
  ).rejects.toThrow()
})
it('includes ERP-produced picking workbooks and refuses incomplete image groups', async () => {
  const template = new ExcelJS.Workbook()
  template.addWorksheet('订单明细'); template.addWorksheet('原始订单')
  const bytes = new Uint8Array(await template.xlsx.writeBuffer())
  const completed = { ...batch, pickingGroups: batch.plan.groups.map(group => ({group: group.name, ready: true})) }
  const zip = await JSZip.loadAsync(await exportPackBundle(completed, bytes, bytes, async () => label(226,226), async () => bytes))
  expect(await zip.file('带图备货单/HUAB-261117-带图备货单.xlsx')!.async('uint8array')).toEqual(bytes)
  await expect(exportPackBundle({...completed,pickingGroups:[{group:'HUAB',ready:false}]},bytes,bytes,async()=>label(226,226),async()=>bytes)).rejects.toThrow('备货单尚未完成')
})
