import { expect, test } from '@playwright/test'
import { chooseOption } from './choose-option'

const product = {
  id: 'temu:US:17',
  external_id: '17',
  market: 'US',
  platform: 'temu',
  title: 'Sponge brush, kitchen',
  title_cn: '海绵刷，清洁厨房',
  category_path: '家居 / 海绵',
  min_price: 2.5,
  max_price: 4,
  currency: 'USD',
  total_sold: 25,
  day_sold: 3,
  rating: 4.5,
  review_count: 12,
  updated_at: '2026-10-10T00:00:00Z',
  lines: [],
}
const history = [
  { observed_at: '2026-10-01T02:00:00Z', total_sold: 10, day_sold: 1 },
  { observed_at: '2026-10-02T02:00:00Z', total_sold: 12, day_sold: 2 },
  { observed_at: '2026-10-02T12:00:00Z', total_sold: 15, day_sold: 5 },
  { observed_at: '2026-10-10T00:00:00Z', total_sold: 25, day_sold: 3 },
]
const variants = [
  { sku_id: 'A1', specs: [{ specKey: '包装', specValue: '单只装' }], stock: 0 },
  { sku_id: 'A2', specs: [] },
]

test('详情呈现真实观测、检索依据与分开的评论样本，读取缓存不会生成分析', async ({ page, baseURL }) => {
  const writes: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const path = decodeURIComponent(url.pathname)
    if (url.origin !== new URL(baseURL!).origin) return route.abort()
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/rpc/session')
      return route.fulfill({
        json: { json: { id: 'qa', username: 'viewer', role: 'viewer', local: false } },
      })
    if (route.request().method() !== 'GET') {
      writes.push(path)
      return route.abort()
    }
    if (path === '/api/products/' + product.id)
      return route.fulfill({ json: { product, history, variants, snapshots: [], feedback: [] } })
    if (path.endsWith('/amazon'))
      return route.fulfill({ json: { configured: false, searches: [], matches: [] } })
    if (
      path === '/api/products' &&
      url.searchParams.get('q') &&
      url.searchParams.get('market') === 'US' &&
      url.searchParams.get('platform') === 'temu'
    )
      return route.fulfill({ json: { total: 1, items: [product] } })
    if (path === '/api/reviews/temu/17')
      return route.fulfill({
        json: {
          report: {
            platform: 'temu',
            updatedAt: product.updated_at,
            data: {
              total: 8,
              rows: 3,
              withText: 2,
              summary: '产品问题：手柄脱落（1）。',
              comments: ['Handle fell off', '包装缺件'],
            },
          },
        },
      })
    if (path.startsWith('/api/reviews/amazon/')) {
      const own = path.endsWith('B000000001')
      return route.fulfill({
        json: {
          report: {
            platform: 'amazon',
            updatedAt: product.updated_at,
            data: {
              topics: [
                {
                  name: own ? 'Print Quality' : 'Ease Of Cleaning',
                  mentions: own ? 2 : null,
                  snippets: [own ? 'Ink faded' : 'Hard to clean'],
                },
              ],
              period: { startDate: '2026-09-01', endDate: '2026-09-30' },
            },
          },
        },
      })
    }
    return route.abort()
  })
  await page.goto('/products/' + encodeURIComponent(product.id))
  const main = page.getByRole('main')
  const tab = (name: string) =>
    main
      .getByRole('navigation', { name: '商品详情栏目' })
      .getByRole('button', { name, exact: true })
      .click()
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(product.title_cn)
  await expect(main).toContainText('$2.50 – $4.00')
  await tab('历史趋势')
  await chooseOption(main.getByRole('combobox', { name: '历史指标' }), '累计销量')
  const chart = main.getByRole('img', { name: '按来源日期绘制的历史观测值' })
  await expect(chart.locator('circle')).toHaveCount(3)
  await expect(chart.locator('.da-segment')).toHaveCount(1)
  await expect(chart).toContainText('2026-10-02 · 15')
  await chooseOption(main.getByRole('combobox', { name: '历史日期范围' }), '近 7 天')
  await expect(chart).toHaveCount(0)
  await expect(main).toContainText('仅有一天的观测')
  await tab('SKU 分析')
  await expect(
    main.getByRole('row').filter({ hasText: 'A1' }).getByRole('cell', { name: '0', exact: true }),
  ).toBeVisible()
  await main.getByRole('textbox', { name: '查找 SKU 或规格' }).fill('A2')
  await expect(
    main.getByRole('row').filter({ hasText: 'A2' }).getByRole('cell', { name: '—', exact: true }),
  ).toHaveCount(5)
  await expect(main.getByRole('row').filter({ hasText: 'A1' })).toHaveCount(0)
  await tab('地区销量')
  await expect(main).toContainText('无法计算地区占比')
  await tab('相关关键词')
  await main.getByRole('button', { name: /海绵刷.*中文标题/ }).click()
  await expect(main.getByText('取词依据 · 中文标题')).toBeVisible()
  await expect(main.getByRole('link', { name: '查看全部匹配' })).toHaveAttribute(
    'href',
    /q=%E6%B5%B7%E7%BB%B5%E5%88%B7/,
  )
  await expect(main.getByText(/已存商品中匹配/)).toContainText('1 件')
  await tab('评论分析')
  await expect(main).toContainText('手柄脱落（1）')
  await main.getByText('查看分析依据 · 2 条正文').click()
  await expect(main.getByText('Handle fell off')).toBeVisible()
  const id = main.getByRole('textbox', { name: 'Amazon 子 ASIN 或商品链接' })
  await id.fill('B000000001')
  await main.getByRole('button', { name: '查看反馈' }).click()
  await expect(main.getByText('Print Quality')).toBeVisible()
  await main.getByRole('button', { name: '竞品', exact: true }).click()
  await expect(main.getByText('Print Quality')).not.toBeVisible()
  await id.fill('https://www.amazon.com/dp/B000000002')
  await main.getByRole('button', { name: '查看反馈' }).click()
  await expect(main.getByText('Hard to clean')).toBeVisible()
  await main.getByRole('button', { name: '自家商品', exact: true }).click()
  await expect(main.getByText('Ink faded')).toBeVisible()
  await expect(main.getByText('Hard to clean')).not.toBeVisible()
  await expect(main.getByRole('button', { name: /生成分析|更新分析/ })).toHaveCount(0)
  expect(writes).toEqual([])
})
