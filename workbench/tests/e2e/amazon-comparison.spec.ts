import { expect, type Page, test } from '@playwright/test'
import { chooseOption } from './choose-option'
import { screens } from './screens'

const id = 'temu:US:17'
const product = {
  id,
  external_id: '17',
  market: 'US',
  platform: 'temu',
  title: 'Steel rack, 2 tiers',
  title_cn: '钢制双层收纳架',
  min_price: 3.2,
  currency: 'USD',
  total_sold: 2100,
  lines: [],
}
const candidate = {
  asin: 'B000000017',
  title: 'Steel shelf rack',
  specs: 'Steel · 2 tiers',
  rank: 132,
  rankCategory: 'Kitchen Storage',
  price: 12.5,
  shipping: 0,
  priceStatus: 'available',
  basis: '均为钢制双层架，尺寸需核对。',
}
const comparison = {
  methodVersion: 2,
  productId: id,
  sourceTitle: product.title_cn,
  sourceSpecs: '钢制 · 两层',
  sourceSold: 2100,
  sourcePrice: 3.2,
  sourceCurrency: 'USD',
  checkedAt: '2026-10-31T09:15:00Z',
  query: 'steel shelf rack',
  status: 'found',
  message: '已取得候选',
  candidates: [
    candidate,
    {
      ...candidate,
      asin: 'B000000018',
      title: 'Shelf rack with hooks',
      specs: null,
      rank: null,
      rankCategory: null,
      price: null,
      shipping: null,
      priceStatus: 'not_checked',
    },
  ],
}
const jobId = 'research-17'
const report = {
  kind: 'selection',
  runId: 'run-17',
  day: '2026-10-31',
  previousDay: '2026-10-30',
  scope: 'Temu 美国站',
  actor: '测试管理员',
  createdAt: comparison.checkedAt,
  examined: 3,
  matched: 2,
  points: 80,
  pendingPoints: 0,
  aiMicros: 0,
  pendingMicros: 0,
}
const row = {
  id,
  title: product.title_cn,
  price: 3.2,
  sold: 2100,
  daily: 3,
  researchId: jobId,
  selectionBasis: '累计销量达标',
  snapshotAt: comparison.checkedAt,
  reason: '核对套装。',
}
const miss = { ...comparison, status: 'no_results', message: '本次检索未返回相关候选。', candidates: [] }

async function mockApi(page: Page, options: { role?: string; initiallyFound?: boolean } = {}) {
  let found = options.initiallyFound ?? false
  const writes: string[] = []
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/rpc/session')
      return json({ json: { id: 'qa', username: 'qa', role: options.role ?? 'admin', local: false } })
    if (route.request().method() === 'POST') {
      writes.push(path)
      if (path === '/api/jobs/' + jobId + '/amazon-compare') {
        expect(route.request().postDataJSON()).toEqual({})
        found = true
        return json({ ok: true })
      }
    }
    if (path === '/api/admin-reports')
      return json({
        reports: [
          {
            ...report,
            items: [
              { ...row, amazonEligible: true, amazonComparison: found ? comparison : null },
              { ...row, id: 'temu:US:18', title: '挂钩', researchId: null },
            ],
          },
        ],
        latestRun: report.runId,
      })
    if (path === '/api/products/' + id)
      return json({ product, history: [], variants: [], snapshots: [], feedback: [] })
    if (path.endsWith('/amazon'))
      return json({
        configured: true,
        searches: [],
        matches: found
          ? [{ ...candidate, status: 'confirmed', note: '已核对层数', method: 'keyword' }]
          : [],
        automation: { runId: jobId, comparison: found ? comparison : null, canBackfill: !found },
      })
    if (path === '/api/jobs/' + jobId)
      return json({
        id: jobId,
        title: '双层架研究',
        kind: 'research',
        status: 'succeeded',
        inputs: { mode: 'live', productId: id },
        usage: {},
        steps: [
          {
            key: 'amazon-compare',
            title: 'Amazon 美国站对照',
            status: 'succeeded',
            summary: '对照完成',
            result: {
              comparisons: [
                comparison,
                { ...miss, productId: 'temu:US:19' },
                {
                  ...miss,
                  productId: 'temu:US:20',
                  status: 'no_query',
                  query: '',
                  message: '来源标题缺少可检索信息。',
                },
                {
                  ...miss,
                  productId: 'temu:US:21',
                  status: 'unavailable',
                  message: 'Amazon 触发限流，请稍后再试。',
                },
              ],
            },
          },
        ],
      })
    if (path === '/api/jobs') return json({ items: [], total: 0 })
    return route.fulfill({ status: 404, json: { message: '无记录' } })
  })
  return writes
}

for (const [name, width, height] of screens) {
  test.describe('Amazon 对照 · ' + name, () => {
    test.use({ viewport: { width, height }, hasTouch: width < 600, isMobile: width < 600 })
    test('已研究商品补查、切换候选并查看原始目录证据', async ({ page }) => {
      const writes = await mockApi(page)
      await page.goto('/daily?view=preview&kind=selection&run=' + report.runId)
      await page.locator('.erp-list > details > summary').filter({ hasText: '挂钩' }).click()
      await expect(page.getByText(/本轮未对这件商品开展 AI 研究/)).toBeVisible()
      await page.locator('.erp-list > details > summary').filter({ hasText: product.title_cn }).click()
      await expect(page.getByRole('button', { name: '补查 Amazon' })).toHaveCount(1)
      expect(writes).toEqual([])
      await page.getByRole('button', { name: '补查 Amazon' }).click()
      const evidence = page.getByRole('region', { name: '来源与 Amazon 对照' })
      const table = evidence.getByRole('table')
      await expect(table.getByRole('link', { name: candidate.title })).toHaveAttribute(
        'href',
        'https://www.amazon.com/dp/' + candidate.asin,
      )
      for (const fact of [
        '$3.20 USD',
        '$12.50',
        '运费 $0.00',
        '2,100 件',
        '#132 · Kitchen Storage',
        '竞品销量未取得',
      ])
        await expect(table).toContainText(fact)
      for (const fact of [
        candidate.basis,
        comparison.query,
        '2026/10/31',
        '17:15',
        '自动候选',
        '比来源展示价高 $9.30',
      ])
        await expect(evidence).toContainText(fact)
      await chooseOption(evidence.getByRole('combobox'), '2 · Shelf rack with hooks')
      await expect(table).toContainText('本次未查报价')
      await expect(table).toContainText('运费 未取得')
      await expect(evidence).not.toContainText('比来源展示价高')
      await expect(evidence.getByRole('link', { name: candidate.title })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(writes).toEqual(['/api/jobs/' + jobId + '/amazon-compare'])
    })
    test('商品对照显示当前人工结论，研究任务保留查询时的候选与缺证原因', async ({ page }) => {
      const writes = await mockApi(page, { role: 'viewer', initiallyFound: true })
      await page.goto('/products/' + encodeURIComponent(id))
      await page
        .getByRole('navigation', { name: '商品详情栏目' })
        .getByRole('button', { name: 'Amazon 复核' })
        .click()
      const evidence = page.getByRole('region', { name: '来源与 Amazon 对照' })
      await expect(evidence).toContainText('人工已确认可比')
      await expect(evidence).toContainText('人工说明 · 已核对层数')
      await expect(page.getByRole('textbox', { name: 'Amazon 关键词或 ASIN' })).toBeVisible()
      await expect(page.getByRole('button', { name: '人工复核' })).toBeDisabled()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.goto('/tasks?id=' + jobId)
      await expect(page.getByRole('table', { name: '商品证据并排对照' })).toContainText(candidate.title)
      for (const message of [miss.message, '来源标题缺少可检索信息。', 'Amazon 触发限流，请稍后再试。'])
        await expect(page.getByText(message, { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '补查 Amazon' })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(writes).toEqual([])
    })
  })
}
