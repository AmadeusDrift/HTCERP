import { expect, type Page, test } from '@playwright/test'

const providers = {
  geekbi: { name: '极鲸云 API', keys: ['GB_APP_KEY', 'GB_APP_SECRET'] },
  amazon: { name: 'Amazon SP-API', keys: ['SP_CLIENT_ID', 'SP_CLIENT_SECRET', 'SP_REFRESH_TOKEN'] },
  openrouter: { name: 'OpenRouter', keys: ['OPENROUTER_API_KEY'] },
}

async function openSettings(
  page: Page,
  baseURL: string,
  role = 'admin',
  credentialEditing = true,
  amazonConfigured = false,
) {
  const status = {
    credentialEditing,
    geekbi: { configured: false, slots: [1, 2, 3, 4, 5].map((slot) => ({ slot, configured: false })) },
    amazon: {
      sellerId: '',
      configured: amazonConfigured,
      status: amazonConfigured ? 'catalog_verified' : 'unconfigured',
    },
    openrouter: { configured: false },
    haul: { configured: false },
  }
  const writes: { path: string; body: unknown }[] = []
  await page.route('**/*', async (route) => {
    const request = route.request()
    const { origin, pathname } = new URL(request.url())
    if (origin !== new URL(baseURL).origin) return route.abort()
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname === '/api/rpc/session')
      return route.fulfill({
        json: { json: { id: 'test', username: 'test', local: false, role, position: 'product_lead' } },
      })
    if (request.method() === 'GET' && pathname === '/api/connections') {
      if (role !== 'admin') return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } })
      const { geekbi, ...common } = status
      return route.fulfill({
        json: { ...common, productData: geekbi, ...(role === 'admin' && { geekbi }) },
      })
    }
    if (request.method() === 'GET' && pathname === '/api/strategy')
      return route.fulfill({
        json: {
          version: 1,
          settings: { scheduleEnabled: false, scheduleTime: '09:30' },
          usage: {},
          capabilities: { discovery: false, research: false },
        },
      })
    if (pathname === '/api/me/preferences')
      return route.fulfill({ json: { view: 'table', pageSize: 50, presets: [] } })
    writes.push({ path: pathname, body: request.postDataJSON() })
    if (pathname === '/api/connections/amazon/seller' && request.method() === 'POST') {
      status.amazon.sellerId = request.postDataJSON().sellerId
      return route.fulfill({ json: { ok: true } })
    }
    if (pathname === '/api/connections/amazon/listing-fields' && request.method() === 'POST')
      return route.fulfill({
        json: {
          sampled: 2,
          withSku: 2,
          withCreatedDate: 1,
          parent: 1,
          child: 0,
          standalone: 0,
          unknown: 1,
        },
      })
    const provider = Object.keys(providers).find(
      (p) => pathname === '/api/connections/' + p + '/credentials',
    )
    if (request.method() === 'POST' && provider) {
      status[provider as keyof typeof providers].configured = true
      if (provider === 'geekbi')
        status.geekbi.slots[(request.postDataJSON().slot ?? 1) - 1].configured = true
      if (provider === 'amazon') status.amazon.status = 'untested'
      return route.fulfill({ json: { ok: true } })
    }
    return route.abort()
  })
  await page.goto('/settings?tab=connections')
  await expect(
    page.getByRole('heading', { name: role === 'admin' ? 'Amazon SP-API' : '团队调度与预算' }),
  ).toBeVisible()
  return writes
}

test('管理员保存店铺后刷新仍可直接查询刊登记录', async ({ page, baseURL }) => {
  const writes = await openSettings(page, baseURL!, 'admin', true, true)
  const control = page.getByRole('button', { name: '查询刊登记录' })
  await expect(control).toBeDisabled()
  const input = page.getByLabel('Seller ID（Merchant Token）', { exact: true })
  await input.fill('AB123456789')
  await page.getByRole('button', { name: '保存 Seller ID' }).click()
  await expect(control).toBeEnabled()
  await page.reload()
  await expect(input).toHaveValue('AB123456789')
  await control.click()
  await expect(page.getByRole('status').filter({ hasText: '本页 2 条' })).toContainText(
    '关系待确认 1 条',
  )
  expect(writes).toEqual([
    { path: '/api/connections/amazon/seller', body: { sellerId: 'AB123456789' } },
    { path: '/api/connections/amazon/listing-fields', body: {} },
  ])
  await input.fill('AB987654321')
  await expect(page.getByText(/本页 2 条/)).toHaveCount(0)
  await page.reload()
  await expect(input).toHaveValue('AB123456789')
})

test('管理员可配置三种服务，更新时重新填写整组凭据', async ({ page, baseURL }) => {
  const writes = await openSettings(page, baseURL!)
  for (const [id, { name, keys }] of Object.entries(providers)) {
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
    await card.getByRole('button', { name: '配置连接' }).click()
    const dialog = page.getByRole('dialog', { name: name + ' · 配置连接' })
    const inputs = dialog.locator('input')
    await expect(inputs).toHaveCount(keys.length)
    const before = writes.length
    await dialog.getByRole('button', { name: '保存凭据' }).click()
    const credentials: Record<string, string> = {}
    for (const key of keys) {
      const input = dialog.getByLabel(new RegExp(key))
      await expect(input).toHaveAttribute('type', 'password')
      await expect(input).toHaveAttribute('required', '')
      await expect(input).toHaveValue('')
      credentials[key] = 'fixture-' + key
      await input.fill(credentials[key])
    }
    expect(writes).toHaveLength(before)
    const oldInput = await inputs.first().elementHandle()
    await dialog.getByRole('button', { name: '保存凭据' }).click()
    await expect(card.getByText('凭据已保存')).toBeVisible()
    await expect(card.getByText('已绑定', { exact: true })).toBeVisible()
    expect(await oldInput!.evaluate((input) => (input as HTMLInputElement).value)).toBe('')
    expect(writes.slice(before)).toEqual([
      { path: '/api/connections/' + id + '/credentials', body: { credentials } },
    ])

    await card.getByRole('button', { name: '更新凭据' }).click()
    const update = page.getByRole('dialog', { name: name + ' · 更新凭据' })
    await expect(update.getByText(/整组凭据将替换当前配置/)).toBeVisible()
    for (const key of keys) await expect(update.getByLabel(new RegExp(key))).toHaveValue('')
    const first = update.locator('input').first()
    await first.fill('fixture-cancel')
    const cancelledInput = await first.elementHandle()
    await page.keyboard.press('Escape')
    await expect(update).toHaveCount(0)
    expect(await cancelledInput!.evaluate((input) => (input as HTMLInputElement).value)).toBe('')

    await card.getByRole('button', { name: '更新凭据' }).click()
    for (const key of keys) {
      const input = update.getByLabel(new RegExp(key))
      await expect(input).toHaveValue('')
      credentials[key] = 'fixture-rotation-' + key
      await input.fill(credentials[key])
    }
    await update.getByRole('button', { name: '保存凭据' }).click()
    await expect(card.getByText('凭据已保存')).toBeVisible()
    expect(writes.slice(before + 1)).toEqual([
      { path: '/api/connections/' + id + '/credentials', body: { credentials } },
    ])
  }
  expect(writes).toHaveLength(6)
  const stored = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))
  expect(stored).not.toContain('fixture-')
  await expect(page.locator('body')).not.toContainText('fixture-')
  await expect(page.getByRole('heading', { name: 'Amazon Haul' })).toHaveCount(0)
})

test('管理员可单独保存第五组密钥，切换组时清空未提交的字段', async ({ page, baseURL }) => {
  const writes = await openSettings(page, baseURL!)
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '极鲸云 API' }) })
  await card.getByRole('button', { name: '配置连接' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/GB_APP_KEY/).fill('unused-value')
  await dialog.getByRole('button', { name: /第 5 组/ }).click()
  await expect(dialog.getByLabel(/GB_APP_KEY/)).toHaveValue('')
  await dialog.getByLabel(/GB_APP_KEY/).fill('fixture-five')
  await dialog.getByLabel(/GB_APP_SECRET/).fill('fixture-secret')
  await dialog.getByRole('button', { name: '保存凭据' }).click()
  await expect(card.getByText('第 5 组凭据已保存')).toBeVisible()
  expect(writes).toEqual([
    {
      path: '/api/connections/geekbi/credentials',
      body: { slot: 5, credentials: { GB_APP_KEY: 'fixture-five', GB_APP_SECRET: 'fixture-secret' } },
    },
  ])
  await card.getByRole('button', { name: '更新凭据' }).click()
  await expect(dialog.getByRole('button', { name: /第 1 组/ })).toContainText('未绑定')
  await expect(dialog.getByRole('button', { name: /第 5 组/ })).toContainText('已绑定')
})

for (const role of ['viewer', 'operator']) {
  test(
    role + ' 只能打开团队预算和个人设置，旧管理链接重定向且不读取管理接口',
    async ({ page, baseURL }) => {
      const privateReads: string[] = []
      page.on('request', (req) => {
        const path = new URL(req.url()).pathname
        if (/^\/api\/(connections|accounts)(\/|$)/.test(path)) privateReads.push(path)
      })
      const writes = await openSettings(page, baseURL!, role)
      await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'schedule')
      for (const old of ['models', 'members']) {
        await page.goto('/settings?tab=' + old)
        await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'schedule')
      }
      await page.goto('/settings')
      await expect(page.getByRole('heading', { name: '团队调度与预算' })).toBeVisible()
      await expect(page.getByText('09:30', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: /数据连接|AI 模型|成员管理|保存策略/ })).toHaveCount(
        0,
      )
      await page.getByRole('button', { name: '个人设置' }).click()
      const account = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '我的账号' }) })
      await expect(account.getByText('开发主管')).toBeVisible()
      await expect(account.getByText(role === 'viewer' ? '只读' : '运营', { exact: true })).toBeVisible()
      await expect(page.locator('main')).not.toContainText(
        /极鲸|geekbi|GB_APP_|SP_CLIENT_|OPENROUTER_API_KEY/i,
      )
      expect(writes).toEqual([])
      expect(privateReads).toEqual([])
    },
  )
}

test('服务端未启用凭据保存时向管理员说明原因', async ({ page, baseURL }) => {
  const writes = await openSettings(page, baseURL!, 'admin', false)
  const buttons = page.getByRole('button', { name: '配置连接' })
  await expect(buttons).toHaveCount(3)
  for (const button of await buttons.all()) await expect(button).toBeDisabled()
  await expect(page.getByText(/请联系部署管理员启用连接凭据加密/)).toBeVisible()
  expect(writes).toEqual([])
})

test('接口拒绝凭据后保留表单并安全提示重试', async ({ page, baseURL }) => {
  await openSettings(page, baseURL!)
  await page.route('**/api/connections/openrouter/credentials', (route) =>
    route.fulfill({ status: 400, json: { message: 'fixture-rejected-key' } }),
  )
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'OpenRouter' }) })
  await card.getByRole('button', { name: '配置连接' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/OPENROUTER_API_KEY/).fill('fixture-rejected-key')
  await dialog.getByRole('button', { name: '保存凭据' }).click()
  await expect(dialog.getByRole('alert')).toContainText('凭据保存失败')
  await expect(page.locator('body')).not.toContainText('fixture-rejected-key')
  await dialog.getByRole('button', { name: '取消' }).click()
  await card.getByRole('button', { name: '配置连接' }).click()
  await expect(dialog.getByLabel(/OPENROUTER_API_KEY/)).toHaveValue('')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})
