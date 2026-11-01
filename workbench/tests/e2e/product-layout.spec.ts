import { expect, type Locator, type Page, test } from '@playwright/test'
import { screens } from './screens'

const longTitle = '可叠放的厨房收纳盒，含可拆卸隔板、标签与盖子。'.repeat(35)
const product = {
  id: 'temu:US:17',
  external_id: '17',
  title: longTitle,
  platform: 'temu',
  market: 'US',
  stage: 'candidate',
  lines: [],
  total_sold: 72000,
  min_price: 3,
  currency: 'USD',
}
async function sampleData(page: Page) {
  const items = [product, { ...product, id: 'temu:US:18', external_id: '18', title: '短标题' }]
  const list = { items, total: 2, page: 1, pageSize: 20 }
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (path === '/api/rpc/session')
      return route.fulfill({
        json: {
          json: {
            id: 'reader',
            username: 'reader',
            role: 'viewer',
            local: false,
          },
        },
      })
    if (path === '/api/catalog/meta')
      return route.fulfill({
        json: {
          platforms: [{ platform: 'temu', count: 2 }],
          total: 2,
          tiers: [],
          categories: [],
          candidates: 2,
        },
      })
    if (path === '/api/me/preferences')
      return route.fulfill({ json: { view: 'table', pageSize: 20, presets: [] } })
    if (path === '/api/products' || path === '/api/candidates') return route.fulfill({ json: list })
    const match = items.find((item) => path === '/api/products/' + item.id)
    if (match)
      return route.fulfill({
        json: { product: match, history: [], variants: [], feedback: [], snapshots: [] },
      })
    if (path === '/api/potential')
      return route.fulfill({
        json: {
          ...list,
          categories: [],
          items: [
            {
              id: product.id,
              title: product.title,
              thumbnail: null,
              category: '家居 / 收纳',
              price: product.min_price,
              listed: '2026-10-17',
              observed: '2026-10-31',
              grade: 'watch',
              daySold: 1,
              weekSold: 15,
            },
          ],
        },
      })
    if (path === '/api/daily')
      return route.fulfill({
        json: {
          ...list,
          summary: { liveRuns: 1, searchedRuns: 1, selected: 1, recommended: 0, linked: 0, reports: 0 },
          items: [
            {
              productId: product.id,
              title: longTitle,
              outcome: 'unlinked',
              occurrences: 1,
              discoveryId: 'run',
              tier: 0,
            },
          ],
        },
      })
    return route.fulfill({ status: 404, json: { message: '无样本' } })
  })
}
async function clamped(title: Locator) {
  await expect(title).toHaveText(longTitle)
  await expect(title).toHaveCSS('-webkit-line-clamp', '2')
  expect(await title.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true)
}
async function aligned(page: Page) {
  const boxes = await page.locator('.catalog-filters > button').evaluateAll((buttons) =>
    buttons.map((el) => {
      const { x, y, width, height } = el.getBoundingClientRect()
      return { x, y, width, height }
    }),
  )
  expect(boxes).toHaveLength(3)
  for (const [i, box] of boxes.entries()) {
    expect(box.y).toBe(boxes[0].y)
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1)
    if (i) expect(box.x).toBeGreaterThan(boxes[i - 1].x + boxes[i - 1].width)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
for (const [name, width, height] of screens) {
  test.describe(name, () => {
    const phone = width < 981
    test.use({ viewport: { width, height }, hasTouch: phone, isMobile: phone })
    test('筛选对齐、外层标题省略和详情按需展开', async ({ page }) => {
      await sampleData(page)
      await page.goto('/?view=table')
      await clamped(page.locator('.products-table .product-cell b').first())
      if (phone) await aligned(page)
      await page.getByRole('button', { name: '更多筛选' }).click()
      const close = page.getByRole('button', { name: '关闭', exact: true })
      await expect(close).toHaveCSS('border-top-left-radius', '12px')
      await close.click()
      await page.getByRole('button', { name: '网格视图' }).click()
      await clamped(page.locator('.product-name').first())
      await page.locator('.product-name').first().click()
      const heading = page.locator('.detail-meta h1')
      await expect(heading).toHaveText(longTitle)
      const expand = page.getByRole('button', { name: '展开标题' })
      if (phone) {
        await expect(expand).toBeVisible()
        expect(await heading.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
        await expand.click()
        await expect(page.getByRole('button', { name: '收起标题' })).toHaveAttribute(
          'aria-expanded',
          'true',
        )
      } else await expect(expand).toHaveCount(0)
      expect(await heading.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
      if (phone) {
        await page.getByRole('button', { name: '收起标题' }).click()
        await expect(expand).toBeVisible()
      }
      await page.goto('/products/temu%3AUS%3A18')
      await expect(heading).toHaveText('短标题')
      await expect(expand).toHaveCount(0)
      await page.goto('/candidates')
      await clamped(page.locator('.board-card .product-cell b').first())
      if (phone) await aligned(page)
      await page.getByRole('button', { name: '列表视图' }).click()
      await clamped(page.locator('.candidate-list .product-cell b').first())
      await page.goto('/potential')
      const potentialTitle = page.locator('.potential-copy b').first()
      await expect(potentialTitle).toHaveText(longTitle)
      await expect(potentialTitle).toHaveCSS('text-overflow', 'ellipsis')
      expect(await potentialTitle.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
      await page.goto('/daily')
      await clamped(page.locator('.daily-product').first())
    })
  })
}
