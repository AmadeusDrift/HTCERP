import { expect, test } from '@playwright/test'

test('员工按日报日期查看入选、推荐理由和对应任务', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const positive = {
    productId: 'temu:US:1',
    title: '分格收纳盒',
    tier: 10000,
    totalSold: 14010,
    occurrences: 4,
    independentRecommendations: 3,
    discoveryId: 'run-1',
    researchId: 'child-1',
    reused: 1,
    researchStatus: 'succeeded',
    outcome: 'recommend',
    reason: '日销量由 12 件增至 25 件，建议核对补货成本。',
  }
  const waiting = {
    ...positive,
    productId: 'temu:US:2',
    title: '防滑桌垫',
    occurrences: 1,
    independentRecommendations: 0,
    researchId: null,
    outcome: 'unlinked',
    reason: null,
  }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/rpc/session')
      return route.fulfill({
        json: {
          json: { id: 'viewer', username: '测试账号', email: 'viewer', role: 'viewer', local: false },
        },
      })
    if (url.pathname !== '/api/daily' || route.request().method() !== 'GET') return route.abort()
    const date = url.searchParams.get('date'),
      active = date === '2026-10-31'
    const items = !active
      ? []
      : url.searchParams.get('view') === 'recommended'
        ? [positive]
        : [positive, waiting]
    return route.fulfill({
      json: {
        date,
        summary: active
          ? {
              liveRuns: 2,
              searchedRuns: 2,
              latestRun: 'run-1',
              selected: 2,
              linked: 1,
              reports: 1,
              recommended: 1,
            }
          : {
              liveRuns: 0,
              searchedRuns: 0,
              latestRun: null,
              selected: 0,
              linked: 0,
              reports: 0,
              recommended: 0,
            },
        items,
        page: 1,
        pageSize: 20,
        total: items.length,
      },
    })
  })
  await page.goto('/daily?date=2026-10-31')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: '选品日报' })).toBeVisible()
  await expect(main.getByText(positive.reason)).toBeVisible()
  await expect(main.getByText('当日入选 4 次')).toBeVisible()
  await expect(main.getByText('独立推荐 3 次', { exact: true })).toBeVisible()
  await expect(main.getByText('优先考虑', { exact: true })).toBeVisible()
  await expect(main.getByRole('link', { name: '防滑桌垫' })).toBeVisible()
  await main.getByRole('button', { name: /只看 AI 推荐/ }).click()
  await expect(main.getByRole('link', { name: '防滑桌垫' })).toHaveCount(0)
  await expect(main.getByRole('link', { name: '分格收纳盒' })).toHaveAttribute(
    'href',
    /products\/temu%3AUS%3A1\?back=.+recommended/,
  )
  await expect(main.getByRole('link', { name: '发现任务', exact: true })).toHaveAttribute(
    'href',
    '/tasks?id=run-1',
  )
  await expect(main.getByRole('link', { name: '复用的研究' })).toHaveAttribute(
    'href',
    '/tasks?id=child-1',
  )
  await main.getByLabel('报告日期').fill('2026-11-01')
  await expect(main.getByText('当天没有在线发现任务。')).toBeVisible()
})
