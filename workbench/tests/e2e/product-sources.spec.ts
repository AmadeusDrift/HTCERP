import { expect, test } from '@playwright/test'

const product = {
  id: 'temu:US:123',
  external_id: '123',
  platform: 'temu',
  market: 'US',
  title: '旅行收纳包',
  updated_at: '2026-10-01T06:00:00Z',
  fetched_at: '2026-10-02T07:00:00Z',
  total_sold: 52000,
  total_sold_field: 'sold',
  source: '极鲸云',
  evidence_ref: 'archive/geekbi/42',
  min_price: 4,
  currency: 'USD',
  stage: null,
  lines: [],
}
const observation = {
  observed_at: product.updated_at,
  total_sold: 52000,
  day_sold: 160,
  evidence_ref: 'archive/geekbi/42',
}
const job = {
  id: 'test-job',
  title: '样本采集任务',
  kind: 'research',
  status: 'failed',
  createdAt: product.fetched_at,
  strategyVersion: 1,
  actor: 'qa',
  usage: {},
  inputs: { mode: 'cache' },
  summary: '极鲸云连接失败，请重试。',
  steps: [
    {
      key: 'source',
      title: '极鲸云搜索',
      summary: 'GeekBI 返回错误。',
      status: 'failed',
      result: { reasons: ['极鲸云连接失败。'], evidenceRef: 'raw/geekbi/42' },
      evidenceRef: 'raw/geekbi/42',
      updatedAt: product.fetched_at,
    },
  ],
}
const providerName = /极鲸|geekbi|GB_APP_|数据提供方|累计销量字段/i

for (const role of ['admin', 'operator', 'viewer']) {
  test(role + ' 可查看平台与商品历史，不展示供应商诊断信息', async ({ page, baseURL }) => {
    let sourceUrl = 'https://detail.geekbi.com/goods/123'
    const site = new URL(baseURL!).origin
    await page.route('**/*', async (route) => {
      const { origin, pathname } = new URL(route.request().url())
      if (origin !== site) return route.abort()
      if (!pathname.startsWith('/api/')) return route.continue()
      if (pathname === '/api/rpc/session')
        return route.fulfill({ json: { json: { id: 'qa', username: role, role, local: false } } })
      if (pathname === '/api/catalog/meta')
        return route.fulfill({
          json: { platforms: [{ platform: 'temu', count: 1 }], categories: [], tiers: [], total: 1 },
        })
      if (pathname === '/api/products') return route.fulfill({ json: { items: [product], total: 1 } })
      if (pathname === '/api/strategy')
        return route.fulfill({
          json: {
            version: 1,
            ...(role === 'admin' && {models: {research:'openai/gpt-6.1-terra', decision:'openai/gpt-6-luna-decisions'}}),
            settings: { tiers: [10000] },
            usage: {},
            capabilities: { discovery: false, research: false },
          },
        })
      if (decodeURIComponent(pathname) === '/api/products/' + product.id)
        return route.fulfill({
          json: {
            product: { ...product, source_url: sourceUrl },
            history: [observation],
            snapshots: [observation],
            variants: [],
            feedback: [],
          },
        })
      if (pathname.endsWith('/amazon'))
        return route.fulfill({ json: { configured: false, matches: [], searches: [] } })
      if (pathname === '/api/jobs') return route.fulfill({ json: { items: [job], total: 1 } })
      if (pathname === '/api/jobs/test-job') return route.fulfill({ json: job })
      return route.abort()
    })
    await page.goto('/')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: '商品目录' })).toBeVisible()
    await expect(main.getByRole('img', { name: 'Temu', exact: true })).toBeVisible()
    await expect(main).not.toContainText(/极鲸|geekbi|来源快照/i)
    await main.getByRole('link', { name: new RegExp(product.title) }).click()
    const snapshot = main
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '当前快照' }) })
    await expect(snapshot.getByText('更新时间', { exact: true })).toBeVisible()
    await expect(snapshot.getByText('1 条')).toBeVisible()
    await expect(snapshot).not.toContainText(/sold|提供方|来源名称/i)
    await expect(main).not.toContainText(providerName)
    await expect(main.locator('a[href*="geekbi" i]')).toHaveCount(0)
    await expect(main.getByRole('heading', { name: 'Amazon 复核' })).toBeVisible()
    await main.getByRole('button', { name: '历史趋势', exact: true }).click()
    const history = main
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '历史观测明细' }) })
    await expect(history.getByText('52,000')).toBeVisible()
    await expect(main).not.toContainText(providerName)
    await main.getByRole('button', { name: '证据与反馈', exact: true }).click()
    await expect(main.getByText('商品平台')).toBeVisible()
    await expect(main.locator('a[href*="geekbi" i]')).toHaveCount(0)
    await expect(main).not.toContainText(providerName)
    sourceUrl = 'https://www.temu.com/goods.html?goods_id=123'
    await page.reload()
    await expect(main.getByRole('link', { name: '打开平台商品页' })).toHaveAttribute('href', sourceUrl)
    await main.getByRole('button', { name: '证据与反馈', exact: true }).click()
    await expect(main.getByRole('link', { name: '打开平台商品页' })).toHaveAttribute('href', sourceUrl)
    await page.goto('/tasks?id=test-job')
    await expect(main.getByRole('heading', { name: job.title })).toBeVisible()
    await main.getByText('结构化执行记录').click()
    await expect(main).not.toContainText(providerName)
    await expect(main).not.toContainText('raw/geekbi/42')
    await page.goto('/research?kind=discovery')
    if (role === 'admin') {
      await expect(main.getByText('OpenAI ChatGPT 6.1 Terra', {exact:true})).toBeVisible()
      await expect(main.getByText('OpenAI ChatGPT 6 Luna Decisions', {exact:true})).toBeVisible()
    } else await expect(main).not.toContainText('OpenAI ChatGPT')
    await expect(main.getByLabel('执行方式')).toContainText('使用已有资料')
    await expect(main.getByLabel('执行方式')).toHaveAccessibleDescription(/可能消耗数据积分或产生 AI 费用/)
    await main.getByLabel('关键词').fill('收纳')
    await main.getByLabel('执行方式').click()
    await page.getByRole('option', { name: '获取最新资料', exact: true }).click()
    await main.getByRole('button', { name: '预览执行计划' }).click()
    await expect(main.getByRole('alert')).toContainText('启用商品数据连接')
    await expect(main).not.toContainText(providerName)
  })
}
