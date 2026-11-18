import { expect, test } from '@playwright/test'
import ExcelJS from 'exceljs'

test('管理员导入清单模板，运营预览生成分拣并重新下载历史结果', async ({ page }) => {
  const attr = new ExcelJS.Workbook(),
    sheet = attr.addWorksheet('产品属性清单')
  sheet.addRow([
    '分组键',
    '运营',
    '产品类别',
    'SKU示例',
    '名称',
    '规格描述',
    '产品材质/厚度',
    '单价',
    '包装方式',
    '配件',
    '备注',
  ])
  sheet.addRow([
    'HUAB-GL',
    'AB',
    'HUAB-MKB',
    'HUAB-MKB-JIT-001',
    '陶瓷杯',
    '350ml',
    '陶瓷',
    3,
    '纸盒',
    '无',
    '测试',
  ])
  const template = new ExcelJS.Workbook(),
    detail = template.addWorksheet('订单明细'),
    raw = template.addWorksheet('亚马逊订单')
  detail.getCell('A1').value = '模板'
  detail.getCell('A3').value = '序号'
  detail.getCell('N3').value = '订单日期'
  detail.getCell('A4').value = 1
  raw.addRow(['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units'])
  raw.addRow(['template', 'SKU', 'FN', 'T', 1])
  const order = new ExcelJS.Workbook(),
    orders = order.addWorksheet('Order List')
  orders.getCell('A4').value = '2026-11-16'
  orders.getRow(6).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  orders.addRow(['Mug', 'HUAB-MKB-JIT-001', 'FN1', 'T1', 2])
  orders.addRow(['Mug', 'HUAB-MKB-JIT-001', 'FN1', 'T2', 3])
  await page.goto('/order-sorting')
  await expect(page.getByRole('heading', { name: '订单分拣', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '属性清单与模板', exact: true }).click()
  await page.getByLabel('导入产品属性清单').setInputFiles({
    name: 'attributes.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await attr.xlsx.writeBuffer()),
  })
  await page.getByLabel('导入分拣模板').setInputFiles({
    name: 'template.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await template.xlsx.writeBuffer()),
  })
  await page.getByRole('button', { name: '保存导入文件', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('清单和模板已保存')
  await expect(page.getByLabel('导入产品属性清单')).toHaveValue('')
  await expect(page.getByLabel('导入分拣模板')).toHaveValue('')
  await page.getByLabel('第2行 名称', { exact: true }).fill('已维护陶瓷杯')
  await page.getByRole('button', { name: '保存清单修改', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('属性清单已保存')
  await page.getByLabel('导入分拣模板').setInputFiles({
    name: 'new-template.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await template.xlsx.writeBuffer()),
  })
  await page.getByRole('button', { name: '保存导入文件', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('清单和模板已保存')
  await expect(page.getByLabel('第2行 名称', { exact: true })).toHaveValue('已维护陶瓷杯')
  await page.getByRole('button', { name: '手动导入 Excel', exact: true }).click()
  await page.getByLabel('Order List 文件').setInputFiles({
    name: 'orders.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await order.xlsx.writeBuffer()),
  })
  await page.getByRole('button', { name: '预览分拣', exact: true }).click()
  await expect(page.getByText('HUAB-GL-261116.xlsx', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '生成并保存分拣结果', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('分拣结果已保存')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 HUAB-GL-261116.xlsx', exact: true }).click()
  const downloaded = await downloadPromise
  const exported = new ExcelJS.Workbook()
  await exported.xlsx.readFile((await downloaded.path())!)
  expect(exported.worksheets[0].getCell('H4').value).toBe(5)
  expect(exported.worksheets[0].getCell('B4').value).toBe('已维护陶瓷杯')
  expect(exported.worksheets[1].rowCount).toBe(3)
  await page.reload()
  await page.getByRole('button', { name: '查看分拣结果', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '下载 HUAB-GL-261116.xlsx', exact: true })).toBeVisible()
  await page.screenshot({ path: '.local/order-sorting/page-verified.png', fullPage: true })
})
