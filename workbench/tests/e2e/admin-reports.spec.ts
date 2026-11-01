import { expect, test } from '@playwright/test'

const archive = '/daily?view=preview'
const day = '2026-10-31'
const runId = 'run-17'
const item = {
  id: 'temu:US:17',
  title: '厨房双层收纳架',
  price: 3.2,
  sold: 2400,
  daily: 26,
  today: 26,
  yesterday: 18,
  todayAt: day + 'T08:00:00Z',
  yesterdayAt: '2026-10-30T08:00:00Z',
  detailAt: day + 'T09:00:00Z',
  snapshotAt: '2026-10-12T07:00:00Z',
  researchId: null,
  selectionBasis: '在售且两日均有观测',
  reason: '日销量增加 8 件，核对补货成本。',
}
const selection = {
  kind: 'selection',
  runId,
  day,
  previousDay: '2026-10-30',
  scope: 'Temu 美国站 · 家居',
  actor: '测试管理员',
  createdAt: day + 'T09:00:00Z',
  examined: 6,
  matched: 2,
  items: [item],
  points: 80,
  pendingPoints: 0,
  aiMicros: 210000,
  pendingMicros: 0,
}
const tracking = {
  ...selection,
  kind: 'tracking',
  items: [item, { ...item, id: 'temu:US:18', title: '防滑盒', yesterday: null }],
  points: 20,
  aiMicros: 0,
  pendingMicros: 0,
  pendingPoints: 3,
}

for (const [width, height] of [
  [384, 896],
  [412, 893],
  [440, 956],
  [802, 890],
  [1536, 864],
  [1920, 1080],
  [2560, 1440],
]) {
  test.describe('日报档案 ' + width, () => {
    test.use({ viewport: { width, height }, hasTouch: width < 600, isMobile: width < 600 })
    test('生成一对报告、核对两日报数、刷新仍可直接打开', async ({ page }) => {
      let saved = false
      const writes: unknown[] = []
      await page.route('**/api/**', (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/rpc/session')
          return route.fulfill({
            json: { json: { id: 'admin', username: 'admin', role: 'admin', local: false } },
          })
        if (path === '/api/admin-reports') {
          if (route.request().method() === 'POST') {
            writes.push(route.request().postDataJSON())
            saved = true
            return route.fulfill({ json: { ok: true } })
          }
          return route.fulfill({
            json: { latestRun: runId, reports: saved ? [selection, tracking] : [] },
          })
        }
        return route.fulfill({ status: 404, json: { message: '无记录' } })
      })
      await page.goto('/daily')
      await page.getByRole('link', { name: '管理员日报档案', exact: true }).click()
      const generate = page.getByRole('button', { name: '查询并生成两份日报' })
      await expect(generate).toBeEnabled()
      expect(writes).toEqual([])
      await generate.click()
      await expect(page.getByRole('button', { name: '本轮两份日报已保存' })).toBeDisabled()
      const selectionCard = page
        .locator('.archive-card')
        .filter({ has: page.getByRole('heading', { name: '选品日报', exact: true }) })
      await expect(selectionCard).toContainText('80 积分 · $0.21')
      const trackingCard = page
        .locator('.archive-card')
        .filter({ has: page.getByRole('heading', { name: '商品追踪日报', exact: true }) })
      await expect(trackingCard).toContainText('20 积分 · $0.00')
      await expect(trackingCard).toContainText('另有待核用量 3 积分')
      await trackingCard.getByRole('link', { name: '查看商品追踪日报' }).click()
      await expect(page).toHaveURL(
        (url) => url.searchParams.get('kind') === 'tracking' && url.searchParams.get('run') === runId,
      )
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('商品追踪日报')
      await expect(page.locator('.rp-number')).toHaveText('+8件')
      await expect(page.locator('.rp-lead-note')).toContainText('1 / 2')
      await expect(page.locator('.rp-bar-group')).toHaveCount(2)
      await expect(page.locator('.rp-bar-group').last()).toContainText('缺数据')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.getByText('日销量较前一日 · 增加 8 件', { exact: true })).toBeVisible()
      await expect(page.getByText('日销量较前一日 · 待补齐两日数据', { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: item.title })).toHaveAttribute(
        'href',
        /back=.*view%3Dpreview.*tracking/,
      )
      await expect(page.getByText(item.selectionBasis, { exact: false }).first()).toBeVisible()
      await expect(page.getByRole('link', { name: /来源任务/ })).toHaveAttribute(
        'href',
        '/tasks?id=' + runId,
      )
      await page.getByRole('link', { name: '查看同轮选品日报' }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('选品日报')
      await expect(page.locator('.rp-number')).toHaveText('33.3%')
      await expect(page.locator('.rp-unit-grid i')).toHaveCount(6)
      await expect(page.locator('.rp-unit-grid .rp-match')).toHaveCount(2)
      const cellHeights = await page.locator('.rp-unit-grid i').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().height))
      expect(new Set(cellHeights).size).toBe(1)
      await expect(page.getByText(/来源更新.*需复核近期销量/)).toBeVisible()
      await expect(page.getByText(/日销量较前一日/)).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(writes).toEqual([{ runId }])
    })
  })
}

test('员工输入档案地址不会加载管理员报告或显示生成入口', async ({ page }) => {
  const reads: string[] = []
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    if (path === '/api/rpc/session')
      return route.fulfill({
        json: { json: { id: 'viewer', username: 'viewer', role: 'viewer', local: false } },
      })
    return route.fulfill({ status: 404, json: { message: '无记录' } })
  })
  await page.goto(archive + '&kind=tracking&run=' + runId)
  await expect(page.getByRole('heading', { name: '选品日报', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '管理员日报档案' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查询并生成两份日报' })).toHaveCount(0)
  expect(reads).not.toContain('/api/admin-reports')
})
