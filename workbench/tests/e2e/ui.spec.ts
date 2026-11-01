import { expect, test } from '@playwright/test'
import { chooseOption } from './choose-option'

// Audited Temu home sample. Rank 26 in the 10k–30k tier under $4, with 19 dated observations.
const productId = 'temu:US:606597539559600'
const productPath = '/products/' + encodeURIComponent(productId)
const localOrigin = 'http://127.0.0.1:8788'

test.beforeEach(async ({ context, baseURL }) => {
  expect(baseURL).toBe(localOrigin)
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.origin !== localOrigin) return route.abort()
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.continue()
    if (request.method() === 'POST' && url.pathname === '/api/rpc/session') return route.continue()
    const body = request.postDataJSON()
    const safeCandidate =
      decodeURIComponent(url.pathname) === '/api/products/' + productId + '/candidate' &&
      body?.stage === 'watch' &&
      String(body?.note).startsWith('E2E ')
    const safeJob =
      url.pathname === '/api/jobs' &&
      body?.kind === 'research' &&
      body.inputs?.productId === productId &&
      body.inputs?.mode === 'cache' &&
      body.inputs?.maxDataPoints === 0 &&
      body.inputs?.maxAiMicros === 0 &&
      String(body.inputs?.goal).startsWith('E2E ')
    if (request.method() === 'POST' && (safeCandidate || safeJob)) return route.continue()
    await route.abort()
    throw new Error('E2E blocked unexpected write to ' + url.pathname)
  })
})

test('真实商品的筛选、翻页和视图在详情返回后保留，反馈可追溯', async ({ page, request }) => {
  const { product, history } = await (await request.get('/api' + productPath)).json()
  expect(history).toHaveLength(19)
  const title = product.title_cn || product.title
  const note = 'E2E 核对卷筒外径和组合规格 ' + Date.now()
  await page.goto('/')
  await page.getByRole('button', { name: /Temu/i }).click()
  await chooseOption(page.getByRole('combobox', { name: '类目', exact: true }), '家居（已映射类目）')
  await chooseOption(page.getByRole('combobox', { name: '累计销量', exact: true }), '至少 1 万，不足 3 万')
  await page.getByRole('button', { name: /更多筛选/ }).click()
  const filters = page.getByRole('dialog', { name: '更多筛选' })
  await filters.getByLabel('价格上限（USD）').fill('4')
  await filters.getByRole('button', { name: '应用筛选' }).click()
  await chooseOption(page.getByRole('combobox', { name: '每页数量' }), '20 条 / 页')
  await page.getByRole('button', { name: '网格视图' }).click()
  await page.getByRole('button', { name: '下一页' }).click()
  const target = page.getByRole('link', { name: title, exact: true }).filter({ hasText: title })
  await expect(target).toBeVisible()
  const back = page.url()
  expect(Object.fromEntries(new URL(back).searchParams)).toMatchObject({
    platform: 'temu',
    category: 'home',
    maxPrice: '4',
    tier: '10k',
    page: '2',
    view: 'grid',
    pageSize: '20',
  })
  await target.click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await page.getByRole('button', { name: '历史趋势', exact: true }).click()
  await expect(page.getByRole('img', { name: '按来源日期绘制的历史观测值' })).toBeVisible()
  const historical = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '历史观测明细' }) })
  await expect(historical.getByRole('row')).toHaveCount(20)
  await page.getByRole('button', { name: /加入候选池|更新跟进记录/ }).click()
  const edit = page.getByRole('dialog')
  await chooseOption(edit.getByLabel('跟进阶段'), '观察')
  await edit.getByRole('checkbox', { name: '标品' }).check()
  await edit.getByRole('checkbox', { name: /POD/ }).check()
  await edit.getByLabel(/运营备注/).fill(note)
  await edit.getByRole('button', { name: '保存记录' }).click()
  await expect(edit).not.toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '证据与反馈' }).click()
  const record = page.getByRole('listitem').filter({ hasText: note })
  await expect(record).toContainText('观察')
  await expect(record).toContainText('local@workbench')
  await expect(record).toContainText('标品')
  await expect(record).toContainText('POD')
  await page.getByRole('link', { name: '返回发现商品' }).click()
  await expect(page).toHaveURL(back)
  await expect(page.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: '网格视图' })).toHaveAttribute('aria-pressed', 'true')
  await expect(target).toBeVisible()
  await page.getByRole('link', { name: '查看跟进记录' }).click()
  await chooseOption(page.getByRole('combobox', { name: '阶段', exact: true }), '观察')
  await chooseOption(page.getByRole('combobox', { name: '机会', exact: true }), '差异化 / POD')
  const card = page.getByRole('article').filter({ hasText: note })
  await card.getByRole('link', { name: title }).click()
  await expect(page.getByRole('link', { name: '发起 AI 研究' })).toHaveAttribute(
    'href',
    '/research?product=' + encodeURIComponent(productId),
  )
})

test('选品工作台可以收起并重新展开，再进入子页面', async ({ page }) => {
  await page.goto('/')
  const group = page.getByRole('button', { name: '选品工作台', exact: true })
  const tasks = page
    .getByRole('navigation', { name: '选品工作台' })
    .getByRole('link', { name: '任务中心' })
  await expect(tasks).toBeVisible()
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(tasks).toBeHidden()
  await group.press('Enter')
  await tasks.click()
  await expect(page).toHaveURL(/\/tasks$/)
})

test('四个平台的商品列表在第一列显示本地品牌图标，第二列保留商品链接', async ({ page }) => {
  await page.goto('/')
  for (const name of ['Temu', 'SHEIN', 'AliExpress', 'TikTok Shop']) {
    await page
      .getByRole('region', { name: '来源平台' })
      .getByRole('button', { name: new RegExp(name) })
      .click()
    const table = page.locator('.products-table')
    await expect(table.getByRole('columnheader').nth(0)).toHaveText('平台')
    await expect(table.getByRole('columnheader').nth(1)).toHaveText('商品信息')
    const cells = table.locator('tbody tr').first().getByRole('cell')
    const icon = cells.first().getByRole('img', { name, exact: true })
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('src', /^\/platforms\//)
    await expect
      .poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await expect(cells.first()).toHaveText('')
    await expect(cells.nth(1).getByRole('link')).toHaveAttribute('href', /\/products\//)
  }
})

test('指定商品只运行零费用缓存研究，刷新后可查看任务进度与证据', async ({ page, request }) => {
  const goal = 'E2E 复核已保存的家居商品快照 ' + Date.now()
  await page.goto(productPath)
  await page.getByRole('link', { name: '发起 AI 研究' }).click()
  await expect(page.getByText(productId, { exact: true })).toBeVisible()
  await page.getByLabel('你希望研究什么？').fill(goal)
  await chooseOption(page.getByLabel('执行方式'), '使用已有资料')
  await expect(page.getByLabel(/数据积分上限/)).toHaveValue('0')
  await expect(page.getByLabel(/AI 费用上限/)).toHaveValue('0')
  const run = page.getByRole('button', { name: '创建并运行任务' })
  await expect(run).toBeDisabled()
  await page.getByRole('button', { name: '预览执行计划' }).click()
  await expect(page.getByText(/本次使用缓存，不调用外部服务/)).toBeVisible()
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST',
  )
  await run.click()
  const response = await created
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  expect(typeof id).toBe('string')
  await expect(page).toHaveURL((url) => url.pathname === '/tasks' && url.searchParams.get('id') === id)
  await expect(page.getByText('缓存证据与执行计划', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('缓存证据与执行计划', { exact: true })).toBeVisible()
  await expect(page.getByText(/本次未调用外部来源或模型/).first()).toBeVisible()
  const job = await (await request.get('/api/jobs/' + encodeURIComponent(id))).json()
  expect(job).toMatchObject({
    id,
    status: 'succeeded',
    usage: { dataPoints: 0, aiMicros: 0 },
    inputs: { mode: 'cache', goal, productId },
    steps: [{ key: 'plan', status: 'succeeded' }],
  })
})

test('移动端可展开导航并查看真实连接设置', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '商品动态' })).toBeVisible()
  const menu = page.getByRole('button', { name: '打开导航' })
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('navigation').getByRole('link', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/settings')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('heading', { level: 1, name: '数据与模型设置' })).toBeVisible()
  const amazon = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Amazon SP-API' }) })
  await expect(amazon.getByText('待配置', { exact: true })).toBeVisible()
  await expect(amazon.getByRole('button', { name: '测试连接' })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Amazon SP-API' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Amazon Haul' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: 'AI 模型' }).click()
  await expect(page.getByText('OpenAI ChatGPT 6.1 Terra', { exact: true })).toBeVisible()
  await expect(page.getByText('OpenAI ChatGPT 6 Luna Decisions', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '调度与预算' }).click()
  await expect(page.getByRole('switch', { name: /启用每日任务/ })).not.toBeChecked()
})
