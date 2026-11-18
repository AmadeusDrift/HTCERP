import { expect, type Page, test } from '@playwright/test'
import {
  type PerformanceSkuList,
  provisionalPolicy,
  type SalesSummary,
  type StoreSales,
} from '../../packages/store-sales/report'
import { chooseOption } from './choose-option'

const team: SalesSummary = {
  units: 12,
  cents: 4500,
  jit: { units: 5, cents: 2000 },
  standard: { units: 4, cents: 2500 },
  review: { units: 3, cents: 0, lines: 2, missingAmount: 2 },
  newListings: 0,
  unknownListings: 0,
}
const own: SalesSummary = {
  ...team,
  units: 5,
  cents: 2000,
  standard: { units: 0, cents: 0 },
  review: { units: 0, cents: 0, lines: 0, missingAmount: 0 },
}

function liveReport(): StoreSales & { sync: NonNullable<StoreSales['sync']> } {
  return {
    source: 'live',
    yesterday: '2026-11-15',
    policy: provisionalPolicy,
    listingsStatus: 'pending',
    sync: {
      status: 'complete',
      coverageFrom: '2026-11-09T08:00:00.000Z',
      through: '2026-11-16T08:00:00.000Z',
      updatedAt: '2026-11-16T08:05:00.000Z',
      pages: 3,
      lines: 42,
      error: null,
    },
    days: [
      {
        date: '2026-11-15',
        coverage: 'partial',
        quality: { unassignedUnits: 7, cancelledUnits: 2, missingSkuUnits: 1 },
        team,
        operators: [
          { name: '运营甲', summary: own },
          { name: null, summary: { ...team, units: 7, cents: 2500, jit: { units: 0, cents: 0 } } },
        ],
        products: [
          { sku: 'HAUL-JIT-1', title: '店铺收纳架', operator: '运营甲', units: 5, cents: 2000 },
          { sku: 'HAUL-2', title: '店铺收纳篮', operator: null, units: 6, cents: null },
        ],
      },
      {
        date: '2026-11-14',
        coverage: 'synced',
        quality: { unassignedUnits: 0, cancelledUnits: 0, missingSkuUnits: 0 },
        team: own,
        operators: [{ name: '运营甲', summary: own }],
        products: [
          { sku: 'HAUL-JIT-1', title: '店铺收纳架', operator: '运营甲', units: 5, cents: 2000 },
        ],
      },
    ],
  }
}

async function currentStore(page: Page, role: 'admin' | 'operator' = 'admin') {
  const state = {
    report: liveReport(),
    previewReport: null as StoreSales | null,
    writes: [] as { path: string; body: unknown }[],
    skuQueries: [] as string[],
    ownerError: false,
    syncError: false,
    skus: {
      accounts: [
        { id: 'op-a', name: '运营甲' },
        { id: 'op-b', name: '运营乙' },
      ],
      items: [
        {
          sku: 'HAUL-JIT-1',
          title: '店铺收纳架',
          units: 10,
          accountId: 'op-a',
          operator: '运营甲',
          source: 'rule',
        },
        { sku: 'HAUL-2', title: '店铺收纳篮', units: 6, accountId: null, operator: null, source: null },
      ],
      total: 2,
    } as PerformanceSkuList,
  }
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/api/rpc/session')
      return route.fulfill({
        json: {
          json: {
            id: 'op-a',
            username: '运营甲',
            email: 'operator@example.test',
            role,
            position: null,
            local: false,
          },
        },
      })
    if (url.pathname === '/api/store-sales')
      return route.fulfill({
        json:
          url.searchParams.get('view') === 'preview' && state.previewReport
            ? state.previewReport
            : state.report,
      })
    if (url.pathname === '/api/store-sales/skus') {
      const q = url.searchParams.get('q') || ''
      state.skuQueries.push(q)
      const items = state.skus.items.filter((item) => item.sku.includes(q))
      return route.fulfill({
        json: { ...state.skus, items, total: q ? items.length : state.skus.total },
      })
    }
    if (url.pathname === '/api/store-sales/sync') {
      state.writes.push({ path: url.pathname, body: req.postDataJSON() })
      if (state.syncError)
        return route.fulfill({ status: 409, json: { message: '当前店铺连接需要重新授权。' } })
      state.report.sync.status = 'queued'
      return route.fulfill({ status: 202, json: { id: 'sync-1', status: 'queued' } })
    }
    if (url.pathname === '/api/store-sales/owner') {
      const body = req.postDataJSON() as { sku: string; accountId: string | null }
      state.writes.push({ path: url.pathname, body })
      if (state.ownerError)
        return route.fulfill({ status: 400, json: { message: '请选择启用的运营或管理员账号。' } })
      const item = state.skus.items.find((row) => row.sku === body.sku)
      if (!item)
        return route.fulfill({ status: 404, json: { message: '当前店铺没有该 SKU 的订单记录。' } })
      item.accountId = body.accountId ?? 'op-a'
      const account = state.skus.accounts.find((account) => account.id === item.accountId)
      if (!account)
        return route.fulfill({ status: 400, json: { message: '请选择启用的运营或管理员账号。' } })
      item.operator = account.name
      item.source = body.accountId ? 'manual' : 'rule'
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ status: 503, json: { message: '此浏览器测试没有提供该功能的数据。' } })
  })
  return state
}

test('真实店铺首页显示部分金额、待接入刊登和真实历史链接', async ({ page }) => {
  await currentStore(page)
  await page.goto('/home')
  await expect(page.getByText('当前店铺 · 美国站 Haul', { exact: true })).toBeVisible()
  await expect(page.getByText('店铺收纳架', { exact: true })).toBeVisible()
  await expect(page.getByText('该经营日尚未同步完整，以下为已读取订单的试算结果。')).toBeVisible()
  const metrics = page.getByRole('region', { name: '团队汇总' })
  await expect(metrics).toContainText('$45.00')
  await expect(metrics).toContainText('2 行金额待补')
  const listings = metrics.locator('.metric').filter({ hasText: '新增刊登' })
  await expect(listings).toContainText('—')
  await expect(listings).toContainText('刊登数据尚未接入')
  const history = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '历史销售' }) })
  await expect(history.getByRole('link', { name: '查看业绩' }).nth(1)).toHaveAttribute(
    'href',
    '/performance?date=2026-11-14',
  )
  await history.getByRole('link', { name: '查看业绩' }).nth(1).click()
  await expect(page.getByRole('combobox', { name: '业绩经营日' })).toContainText('2026-11-14')
  await chooseOption(page.getByRole('combobox', { name: '业绩经营日' }), '2026-11-15')
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('date') === '2026-11-15' && !url.searchParams.has('view'),
  )
  const quality = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '数据待核对' }) })
  await expect(quality).toContainText('待归属件数7')
  await expect(quality).toContainText('已取消件数2')
  await expect(quality).toContainText('缺 SKU 件数1')
  await page.getByText('查看试算口径（待确认）', { exact: true }).click()
  await expect(page.getByText(/下单时间按美西日历日归集/)).toBeVisible()
  await expect(page.getByText(/含税或税费排除方式仍待核对/)).toBeVisible()
  await expect(page.getByText(/当前负责人应用于历史订单/)).toBeVisible()
})

test('运营看到自己的业绩与商品，不能操作管理员功能', async ({ page }) => {
  const state = await currentStore(page, 'operator')
  for (const day of state.report.days) {
    day.operators = [{ name: '运营甲', summary: own }]
    day.products = day.products.filter((product) => product.operator === '运营甲')
  }
  await page.goto('/performance')
  const performance = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '我的业绩' }) })
  await expect(performance.getByRole('rowheader', { name: '运营甲' })).toBeVisible()
  await expect(performance.getByRole('row').filter({ hasText: '运营甲' })).toContainText('$20.00')
  await expect(page.getByRole('region', { name: '团队汇总' })).toContainText('12')
  await expect(page.getByRole('button', { name: '同步当前店铺订单' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '管理 SKU 负责人' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '查看模拟样张' })).toHaveCount(0)
  await page.goto('/home')
  await expect(page.getByText('店铺收纳架', { exact: true })).toBeVisible()
  await expect(page.getByText('店铺收纳篮', { exact: true })).toHaveCount(0)
})

test('管理员发起同步后显示分页进度并自动刷新完成状态', async ({ page }) => {
  const state = await currentStore(page)
  state.report.sync.status = 'idle'
  await page.clock.install()
  await page.goto('/home')
  await page.getByRole('button', { name: '同步当前店铺订单' }).click()
  await expect(page.getByRole('button', { name: '等待同步' })).toBeDisabled()
  expect(state.writes).toEqual([{ path: '/api/store-sales/sync', body: {} }])
  state.report.sync.status = 'running'
  await page.clock.fastForward(15_000)
  await expect(page.getByRole('button', { name: '正在同步订单' })).toBeDisabled()
  await expect(page.getByText('已读取 3 页 · 42 行订单')).toBeVisible()
  await expect(page.getByText(/首次补齐近 7 天订单可能需要数小时/)).toBeVisible()
  state.report.sync.status = 'complete'
  state.report.days[0].coverage = 'synced'
  await page.clock.fastForward(15_000)
  await expect(page.getByRole('button', { name: '同步当前店铺订单' })).toBeEnabled()
  await expect(page.getByText('订单同步完成', { exact: true })).toBeVisible()
  await expect(page.getByText('该经营日尚未同步完整，以下为已读取订单的试算结果。')).toHaveCount(0)
})

test('SKU 管理搜索已同步订单并保存负责人，清除手工指定后恢复规则匹配', async ({ page }) => {
  const state = await currentStore(page)
  await page.goto('/performance')
  expect(state.skuQueries).toEqual([])
  await page.getByRole('button', { name: '管理 SKU 负责人' }).click()
  await expect(page.getByText(/仅显示当前店铺已同步订单中的 SKU/)).toBeVisible()
  const manager = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'SKU 负责人' }) })
  const row = manager.getByRole('row').filter({ hasText: 'HAUL-JIT-1' })
  await expect(row).toContainText('规则匹配')
  await chooseOption(row.getByRole('combobox', { name: 'HAUL-JIT-1 的负责人' }), '运营乙')
  await row.getByRole('button', { name: '保存负责人' }).click()
  await expect(row).toContainText('手工指定')
  await expect(row.getByRole('status')).toContainText('已保存')
  await expect(row.getByRole('combobox')).toContainText('运营乙')
  await row.getByRole('button', { name: '恢复规则匹配' }).click()
  await expect(row).toContainText('规则匹配')
  await expect(row.getByRole('combobox')).toContainText('运营甲')
  expect(state.writes).toEqual([
    { path: '/api/store-sales/owner', body: { sku: 'HAUL-JIT-1', accountId: 'op-b' } },
    { path: '/api/store-sales/owner', body: { sku: 'HAUL-JIT-1', accountId: null } },
  ])
  await manager.getByRole('textbox', { name: '搜索订单 SKU' }).fill('HAUL-2')
  await manager.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(manager.locator('tbody tr')).toHaveCount(1)
  await expect(manager.locator('tbody tr')).toContainText('HAUL-2')
  expect(state.skuQueries).toContain('HAUL-2')
})

test('同步或负责人保存失败显示可重试错误，不伪报保存成功', async ({ page }) => {
  const state = await currentStore(page)
  state.syncError = true
  state.ownerError = true
  await page.goto('/performance')
  await page.getByRole('button', { name: '同步当前店铺订单' }).click()
  await expect(page.getByRole('alert')).toContainText('当前店铺连接需要重新授权。')
  await expect(page.getByRole('button', { name: '同步当前店铺订单' })).toBeEnabled()
  await page.getByRole('button', { name: '管理 SKU 负责人' }).click()
  const row = page.getByRole('row').filter({ hasText: 'HAUL-JIT-1' })
  await chooseOption(row.getByRole('combobox'), '运营乙')
  await row.getByRole('button', { name: '保存负责人' }).click()
  await expect(row.getByRole('alert')).toContainText('请选择启用的运营或管理员账号。')
  await expect(row.getByRole('status')).toHaveCount(0)
  await expect(row.getByRole('button', { name: '保存负责人' })).toBeEnabled()
  state.ownerError = false
  await row.getByRole('button', { name: '保存负责人' }).click()
  await expect(row.getByRole('status')).toContainText('已保存')
})

test('金额全部缺失时显示待补金额，不显示已确认的零金额', async ({ page }) => {
  const state = await currentStore(page)
  state.report.days[0].team = {
    ...team,
    cents: 0,
    jit: { units: 0, cents: 0 },
    standard: { units: 0, cents: 0 },
    review: { units: 12, cents: 0, lines: 5, missingAmount: 5 },
  }
  await page.goto('/home')
  const metrics = page.getByRole('region', { name: '团队汇总' })
  const revenue = metrics.locator('.metric').filter({ hasText: '已知销售额' })
  await expect(revenue).toContainText('—')
  await expect(revenue).toContainText('5 行金额待补')
  await expect(revenue).not.toContainText('$0.00')
})

test('昨天尚无订单数据时保留历史，不把更早日期标为昨日热销', async ({ page }) => {
  const state = await currentStore(page)
  state.report.days.shift()
  await page.goto('/home')
  await expect(page.getByText('暂无热销排名')).toBeVisible()
  await expect(page.getByText('店铺收纳架', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '查看业绩' })).toHaveAttribute(
    'href',
    '/performance?date=2026-11-14',
  )
})

test('管理员样张保留排序筛选和样张日期链接，返回后恢复真实店铺视图', async ({ page }) => {
  const state = await currentStore(page)
  state.previewReport = {
    source: 'simulation',
    yesterday: state.report.yesterday,
    days: state.report.days.map(({ date, team: summary, operators, products }) => ({
      date,
      team: { ...summary, newListings: 2 },
      operators,
      products,
    })),
  }
  await page.goto('/home')
  await page.getByRole('link', { name: '查看模拟样张' }).click()
  await expect(page.getByText('管理员模拟样张', { exact: true })).toBeVisible()
  await expect(page.getByText('以下数字来自虚构订单和刊登，仅供核对计算口径与排版。')).toBeVisible()
  await expect(page.getByRole('button', { name: '同步当前店铺订单' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '管理 SKU 负责人' })).toHaveCount(0)
  const listings = page
    .getByRole('region', { name: '团队汇总' })
    .locator('.metric')
    .filter({ hasText: '新增刊登' })
  await expect(listings.locator('strong')).toHaveText('2')
  const ranking = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '昨日热销商品' }) })
  await expect(ranking.locator('tbody tr').first()).toContainText('店铺收纳篮')
  await chooseOption(ranking.getByRole('combobox', { name: '热销排序' }), '销售额从高到低')
  await expect(ranking.locator('tbody tr').first()).toContainText('店铺收纳架')
  await chooseOption(ranking.getByRole('combobox', { name: '筛选运营' }), '运营甲')
  await expect(ranking.locator('tbody tr')).toHaveCount(1)
  await expect(page.getByRole('link', { name: '查看样张' }).nth(1)).toHaveAttribute(
    'href',
    '/performance?view=preview&date=2026-11-14',
  )
  await page.getByRole('link', { name: '查看样张' }).nth(1).click()
  await chooseOption(page.getByRole('combobox', { name: '业绩经营日' }), '2026-11-15')
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('view') === 'preview' && url.searchParams.get('date') === '2026-11-15',
  )
  await page.getByRole('link', { name: '返回店铺数据' }).click()
  await expect(page).toHaveURL((url) => !url.searchParams.has('view'))
  await expect(page.getByText('当前店铺 · 美国站 Haul', { exact: true })).toBeVisible()
  await expect(page.getByText('管理员模拟样张', { exact: true })).toHaveCount(0)
  expect(state.writes).toEqual([])
})
