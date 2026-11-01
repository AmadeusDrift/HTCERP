import { expect, test } from '@playwright/test'
import { chooseOption } from './choose-option'

test('首页默认展示自家店铺空态，管理员可以单独核对模拟业绩', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: '首页', exact: true }).click()
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible()
  await expect(page.getByText('暂无热销排名')).toBeVisible()
  await expect(page.getByText('暂无历史销售记录')).toBeVisible()
  await expect(page.getByRole('link', { name: '管理员日报档案' })).toHaveAttribute(
    'href',
    '/daily?view=preview',
  )
  await page.getByRole('link', { name: '查看模拟样张' }).click()
  await expect(page.getByText('管理员模拟样张')).toBeVisible()
  const ranking = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '昨日热销商品' }) })
  await expect(ranking.locator('tbody tr').first()).toContainText('无痕收纳挂钩')
  await chooseOption(ranking.getByRole('combobox', { name: '热销排序' }), '销售额从高到低')
  await expect(ranking.locator('tbody tr').first()).toContainText('抽屉分隔盒')
  await chooseOption(ranking.getByRole('combobox', { name: '筛选运营' }), '模拟运营 B')
  await expect(ranking.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('link', { name: '查看样张', exact: true }).nth(1).click()
  await expect(page.getByRole('heading', { name: '团队备货占比' })).toBeVisible()
  await expect(page.getByRole('rowheader', { name: '待归属' })).toBeVisible()
  await page.getByRole('link', { name: '返回店铺数据' }).click()
  await expect(page.getByText('暂无团队业绩')).toBeVisible()
  await expect(page.getByText('模拟运营 A')).toHaveCount(0)
})
