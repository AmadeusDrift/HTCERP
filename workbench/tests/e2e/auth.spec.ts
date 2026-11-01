import { expect, type Page, test } from '@playwright/test'
import { chooseOption } from './choose-option'

const admin = {
  id: 'a1',
  username: 'admin.qa',
  email: 'admin.qa',
  role: 'admin',
  position: null as string | null,
  local: false,
}
const viewer = { ...admin, id: 'v1', username: 'case.viewer', email: 'case.viewer', role: 'viewer' }
const samplePassword = 'Browser-only test password'
const memberPath = '/settings?tab=members'

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL || '').origin
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  )
})

async function sessionTest(page: Page, initial: typeof admin | null) {
  let session = initial
  const protectedReads: string[] = []
  const writes: { method: string; path: string; data: unknown }[] = []
  const accounts = [
    {
      id: admin.id,
      username: admin.username,
      role: 'admin',
      active: true,
      position: null as string | null,
    },
  ]
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const unauthorized = () => route.fulfill({ status: 401, json: { message: '请登录工作台。' } })
    if (path === '/api/rpc/session')
      return session ? route.fulfill({ json: { json: session } }) : unauthorized()
    if (path === '/api/auth/login') {
      if (
        req.postDataJSON().password !== samplePassword ||
        req.postDataJSON().username !== viewer.username
      )
        return route.fulfill({ status: 401, json: { message: '账号或密码错误。' } })
      session = viewer
      return route.fulfill({ json: viewer })
    }
    if (path === '/api/auth/logout') {
      session = null
      return route.fulfill({ json: { ok: true } })
    }
    protectedReads.push(path)
    if (!session) return unauthorized()
    if (path === '/api/me/preferences')
      return route.fulfill({ json: { view: 'table', pageSize: 50, presets: [] } })
    if (path === '/api/strategy')
      return route.fulfill({
        json: {
          version: 1,
          settings: { scheduleEnabled: false },
          usage: {},
          capabilities: { discovery: false, research: false },
        },
      })
    if (path.startsWith('/api/accounts')) {
      if (req.method() === 'GET') return route.fulfill({ json: { items: accounts } })
      const data = req.postDataJSON()
      writes.push({ method: req.method(), path, data })
      if (req.method() === 'POST') {
        const row = {
          id: 'new',
          username: data.username,
          role: data.role,
          active: true,
          position: data.position ?? null,
        }
        accounts.push(row)
        return route.fulfill({ status: 201, json: row })
      }
      const row = accounts.find((a) => a.id === path.split('/').at(-1))
      if (!row) return route.fulfill({ status: 404, json: {} })
      if ('role' in data) row.role = data.role
      if ('active' in data) row.active = data.active
      if ('position' in data) {
        row.position = data.position
        if (row.id === session.id) session = { ...session, position: data.position }
      }
      return route.fulfill({ json: row })
    }
    return route.fulfill({ status: 503, json: { message: '测试数据暂不可用。' } })
  })
  return {
    protectedReads,
    writes,
    expire: () => {
      session = null
    },
  }
}

test('成员登录后进入获准的设置页，退出后不再显示受保护内容', async ({ page }) => {
  const { protectedReads } = await sessionTest(page, null)
  await page.goto(memberPath)
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible()
  await expect(page).toHaveURL(
    (u) => u.pathname === '/login' && u.searchParams.get('next') === memberPath,
  )
  expect(protectedReads).toEqual([])
  await page.getByLabel('账号', { exact: true }).fill(viewer.username)
  await page.getByLabel('密码', { exact: true }).fill('invalid')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('账号或密码错误')
  await page.getByLabel('密码', { exact: true }).fill(samplePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(
    (u) => u.pathname === '/settings' && u.searchParams.get('tab') === 'schedule',
  )
  await expect(page.getByRole('heading', { name: '团队调度与预算' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建账号' })).toHaveCount(0)
  expect(protectedReads).not.toContain('/api/accounts')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
})

test('会话失效后显示重新登录提示，保留页面地址', async ({ page }) => {
  const auth = await sessionTest(page, viewer)
  await page.goto(memberPath)
  await expect(page.getByRole('heading', { name: '团队调度与预算' })).toBeVisible()
  auth.expire()
  const menu = page.getByRole('button', { name: '打开导航' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('link', { name: '任务中心', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible()
  await expect(page.getByText('登录已过期，请重新登录。')).toBeVisible()
  await expect(page).toHaveURL((u) => u.pathname === '/login' && u.searchParams.get('next') === '/tasks')
})

test('本机开发会话自动进入工作台，登录返回地址不能跳出工作台', async ({ page, baseURL }) => {
  await sessionTest(page, { ...admin, local: true })
  for (const next of ['//outside.invalid', '/api/auth/setup', '/\t/[']) {
    await page.goto('/login?next=' + encodeURIComponent(next))
    await expect(page).toHaveURL(new URL('/', baseURL).href)
    await expect(page.getByRole('heading', { name: '发现商品', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0)
  }
})

test('管理员可创建成员、调整角色、停用启用和重置密码', async ({ page }) => {
  const { writes } = await sessionTest(page, admin)
  await page.goto(memberPath)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('账号', { exact: true }).fill('tester')
  const initialPassword = 'pass1234'
  await dialog.getByLabel('初始密码').fill(initialPassword)
  await expect(dialog.getByLabel('初始密码')).toHaveAttribute('minlength', '8')
  await expect(dialog.getByLabel('角色')).toHaveText('只读')
  await dialog.getByLabel('职位').click()
  const positions = dialog.getByRole('listbox', { name: '职位' })
  await expect(positions.getByRole('option')).toHaveText([
    '未设置',
    '开发主管',
    '总经理',
    '运营主管',
    '运营助理',
    '亚马逊运营',
  ])
  await positions.getByRole('option', { name: '总经理' }).click()
  await expect(dialog.getByLabel('角色')).toHaveText('只读')
  await chooseOption(dialog.getByLabel('角色'), '运营')
  await dialog.getByRole('button', { name: '创建账号' }).click()
  const row = page.getByRole('row').filter({ hasText: 'tester' })
  await expect(row).toContainText('运营')
  await expect(row).toContainText('总经理')
  await row.getByRole('button', { name: '管理', exact: true }).click()
  await chooseOption(dialog.getByLabel('职位'), '亚马逊运营')
  await chooseOption(dialog.getByLabel('角色'), '只读')
  await chooseOption(dialog.getByLabel('状态'), '已停用')
  await dialog.getByRole('button', { name: '保存更改' }).click()
  await expect(row).toContainText('已停用')
  await expect(row).toContainText('亚马逊运营')
  await expect(row).toContainText('只读')
  await row.getByRole('button', { name: '管理', exact: true }).click()
  await chooseOption(dialog.getByLabel('状态'), '已启用')
  await chooseOption(dialog.getByLabel('职位'), '未设置')
  await dialog.getByLabel('新密码').fill('Another browser-only password')
  await dialog.getByRole('button', { name: '保存更改' }).click()
  await expect(row).toContainText('已启用')
  await expect(row).toContainText('未设置')
  expect(writes).toEqual([
    {
      path: '/api/accounts',
      method: 'POST',
      data: { username: 'tester', role: 'operator', password: initialPassword, position: 'general_manager' },
    },
    {
      path: '/api/accounts/new',
      method: 'PATCH',
      data: { active: false, role: 'viewer', position: 'amazon_operator' },
    },
    {
      path: '/api/accounts/new',
      method: 'PATCH',
      data: { active: true, password: 'Another browser-only password', position: null },
    },
  ])
})

test('管理员单独修改本人职位后保持登录，个人账号显示新职位', async ({ page }) => {
  const { writes } = await sessionTest(page, admin)
  await page.goto(memberPath)
  const me = page.getByRole('row').filter({ hasText: admin.username })
  await expect(me).toContainText('未设置')
  await me.getByRole('button', { name: '管理' }).click()
  const dialog = page.getByRole('dialog')
  await chooseOption(dialog.getByLabel('职位'), '运营助理')
  await dialog.getByRole('button', { name: '保存更改' }).click()
  await expect(me).toContainText('运营助理')
  await page.getByRole('button', { name: '个人设置' }).click()
  const account = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '我的账号' }) })
  await expect(account).toContainText('运营助理')
  await expect(account).toContainText('管理员')
  expect(writes).toEqual([
    { method: 'PATCH', path: '/api/accounts/a1', data: { position: 'operations_assistant' } },
  ])
})

test('弹窗下拉支持键盘导航、撤销和 Tab 提交，表单读取当前角色', async ({ page }) => {
  await sessionTest(page, admin)
  await page.goto(memberPath)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const role = dialog.getByRole('combobox', { name: '角色' })
  await role.press('ArrowDown')
  const list = dialog.getByRole('listbox', { name: '角色' })
  await expect(list.getByRole('option', { name: '只读' })).toHaveAttribute('aria-selected', 'true')
  await role.press('End')
  const last = await list.getByRole('option', { name: '管理员' }).getAttribute('id')
  await expect(role).toHaveAttribute('aria-activedescendant', last!)
  await role.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(role).toBeFocused()
  await expect(role).toHaveText('只读')
  await role.press('Enter')
  await role.press('ArrowDown')
  await role.press('Tab')
  await expect(list).toHaveCount(0)
  await expect(dialog.getByLabel('初始密码')).toBeFocused()
  await expect(role).toHaveText('运营')
  expect(
    await dialog.locator('form').evaluate((form: HTMLFormElement) => new FormData(form).get('role')),
  ).toBe('operator')
})

test('首个管理员的禁用角色不能展开或写入表单', async ({ page }) => {
  await sessionTest(page, { ...admin, local: true })
  await page.goto(memberPath)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('初始密码')).toHaveAttribute('minlength', '12')
  await expect(dialog.getByRole('combobox', { name: '角色' })).toBeDisabled()
  expect(
    await dialog.locator('form').evaluate((form: HTMLFormElement) => new FormData(form).has('role')),
  ).toBe(false)
})

test('输入字母可循环切换候选平台', async ({ page }) => {
  await sessionTest(page, admin)
  await page.goto('/candidates')
  const platform = page.getByRole('combobox', { name: '平台', exact: true })
  await platform.press('t')
  await expect(page).toHaveURL((url) => url.searchParams.get('platform') === 'temu')
  await platform.press('t')
  await expect(page).toHaveURL((url) => url.searchParams.get('platform') === 'tiktok')
})

test.describe('触屏下拉', () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 560 } })

  test('排序菜单在窄屏内滚动，点选和外部轻触均可收起', async ({ page }) => {
    await sessionTest(page, admin)
    await page.goto('/')
    const sort = page.getByRole('combobox', { name: '排序' })
    await sort.tap()
    const menu = page.getByRole('listbox', { name: '排序' })
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560)
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    const option = menu.getByRole('option', { name: '更新时间 · 升序' })
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await option.tap()
    await expect(sort).toContainText('更新时间 · 升序')
    await expect(menu).toHaveCount(0)
    await sort.tap()
    await page.getByRole('heading', { name: '商品动态', exact: true }).tap()
    await expect(menu).toHaveCount(0)
  })
})
