import { expect, test } from '@playwright/test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { sortOrders } from '../../packages/order-sorting/rules'

test('Pack 批次显示去重与冲突，标签收齐后下载完整分拣包', async ({ page }) => {
  const id = '00000000-0000-4000-8000-000000000001'
  const plan = sortOrders({ date: '2026-11-17', rows: [['Mug', 'HUAB-X-JIT-1', 'FN1', 'T1', 2]] }, [])
  const batch = {
    id,
    createdAt: 1794900000000,
    filename: 'order.xlsx',
    date: plan.date,
    state: 'LABELS_PENDING',
    labelSource: 'AMAZON_API',
    labelGroups: [{ group: 'HUAB', ready: false }],
    pickingGroups: [{ group: 'HUAB', ready: false }],
    totalRows: 3,
    newRows: 1,
    skippedRows: 1,
    conflicts: [
      { rowIndex: 2, sku: 'HUC-Y-JIT-2', fnsku: 'FN2', transferId: 'T2', previousUnits: 2, units: 3 },
    ],
    plan,
    templateKey: 'template',
    sourceHash: 'a'.repeat(64),
    labels: [
      {
        rowIndex: 0,
        sku: 'HUAB-X-JIT-1',
        fnsku: 'FN1',
        transferId: 'T1',
        units: 2,
        group: 'HUAB',
        filename: 'label.pdf',
        received: false,
      },
    ],
  }
  const book = new ExcelJS.Workbook()
  book.addWorksheet('订单明细').getCell('A3').value = '序号'
  book.addWorksheet('亚马逊订单').addRow(['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units'])
  const template = Buffer.from(await book.xlsx.writeBuffer()),
    pdf = await PDFDocument.create()
  pdf.addPage([226.77, 226.77])
  pdf.addPage([226.77, 226.77])
  const label = Buffer.from(await pdf.save())
  await page.route('**/api/order-sorting/pack/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/batches')) return route.fulfill({ json: { batches: [batch], next: null } })
    if (path.endsWith('/source')) return route.fulfill({ body: template })
    if (path.includes('/group-picking/')) return route.fulfill({ body: template })
    if (path.includes('/group-labels/'))
      return route.fulfill({ body: label, contentType: 'application/pdf' })
    return route.fulfill({ json: batch })
  })
  await page.route('**/api/order-sorting/assets/template', (route) => route.fulfill({ body: template }))
  await page.goto('/order-sorting?packBatch=' + id)
  await expect(page.getByRole('heading', { name: 'Pack 自动分拣批次' })).toBeVisible()
  await expect(page.getByText('HUC-Y-JIT-2', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载新增订单分拣包', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '导出本次全部订单工厂包', exact: true })).toBeDisabled()
  batch.state = 'READY'
  batch.labels[0].received = true
  batch.labelGroups[0].ready = true
  batch.pickingGroups[0].ready = true
  await page.getByRole('button', { name: '刷新本批次', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载新增订单分拣包', exact: true }).click()
  const file = await download
  const { readFile } = await import('node:fs/promises')
  const zip = await JSZip.loadAsync(await readFile((await file.path())!))
  expect(zip.file('分拣表/HUAB-261117.xlsx')).not.toBeNull()
  expect(zip.file('带图备货单/HUAB-261117-带图备货单.xlsx')).not.toBeNull()
  const merged = await PDFDocument.load(await zip.file('SKU标签/HUAB-261117.pdf')!.async('uint8array'))
  expect(merged.getPageCount()).toBe(2)
  expect(merged.getPage(0).getSize()).toEqual({ width: 226.77, height: 226.77 })
  await page.screenshot({ path: '.local/order-sorting/pack-page-verified.png', fullPage: true })
})
