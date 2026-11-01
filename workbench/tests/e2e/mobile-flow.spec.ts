import { expect, test } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true })
for (const [width, height] of [[384, 896], [412, 893], [440, 956], [802, 890]]) {
  test('触屏筛选、商品详情与返回 ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/?view=list')
    await expect(page.getByRole('button', { name: '最近更新', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '日销量最高' }).tap()
    await expect(page).toHaveURL(/sort=day_sold/)
    if (width < 600) {
      const overview = page.getByRole('button', {name:/商品库概况/})
      await overview.tap()
      await expect(page.locator('#catalog-overview')).toBeVisible()
      await overview.tap()
    }
    await page.getByRole('button',{name:/更多筛选/}).tap()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type=number]').first().fill('1')
    await dialog.getByRole('button',{name:'应用筛选'}).tap()
    await expect(dialog).toHaveCount(0)
    const filtered = page.url()
    const products = page.locator('.products-table')
    if (width < 600) expect((await products.boundingBox())!.width).toBeLessThanOrEqual(width)
    await products.locator('.product-cell').first().tap()
    await expect(page.getByText('数据更新于', {exact: false})).toBeVisible()
    await expect(page.getByRole('link', {name:'发起 AI 研究'})).toBeHidden()
    await page.getByText('跟进与研究', {exact:true}).tap()
    await expect(page.getByRole('link', {name:'发起 AI 研究'})).toBeVisible()
    await page.getByRole('button',{name:'SKU 分析'}).tap()
    await expect(page.getByRole('heading',{name:'SKU 明细'})).toBeVisible()
    await page.getByRole('link',{name:'返回发现商品'}).tap()
    await expect(page).toHaveURL(filtered)
  })
}
