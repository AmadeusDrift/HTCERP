import { expect, test } from '@playwright/test'

test('管理员必须先试发成功，再确认切换侵权提醒接收群', async ({ page, baseURL }, testInfo) => {
  const servicePath = '/api/group-notifications'
  const targetPath = `${servicePath}/groups/formal`
  const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-fixture-2222'
  let current = 'test'
  let formalCreated = false
  let peterEnabled = false
  let trialId = 0
  let status: 'queued' | 'failed' | 'sent' = 'queued'
  const writes: { path: string; body: unknown }[] = []

  await page.route('**/*', (route) => {
    const request = route.request()
    const { origin, pathname } = new URL(request.url())
    if (origin !== new URL(baseURL!).origin) return route.abort()
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname === '/api/rpc/session') return route.fulfill({
      json: { json: { id: 'admin', username: '预览管理员', role: 'admin', local: false } },
    })
    if (pathname === '/api/me/preferences') return route.fulfill({ json: { view: 'table', presets: [] } })
    if (pathname === servicePath) return route.fulfill({
      json: { groups: [
        { id: 'test', name: '测试群', webhookKey: 'trial' },
        ...(formalCreated ? [{ id: 'formal', name: '正式群', webhookKey: null, webhookHint: '2222' }] : []),
      ].map((group) => ({
        ...group,
        status: current === group.id ? 'active' : 'test',
        services: current === group.id ? ['infringement'] : [],
      })) },
    })
    if (pathname === `${targetPath}/members` && request.method() === 'GET') return route.fulfill({
      json: { members: [
        { accountId: 'peter', name: 'Peter', userid: 'peter', enabled: peterEnabled },
        { accountId: 'disabled', name: '停用账号', userid: 'disabled', enabled: false },
      ] },
    })
    if (pathname === `${targetPath}/deliveries`) return route.fulfill({
      json: { deliveries: [{ id: String(trialId), phase: 'image', status, error: status === 'failed' ? '模拟主图发送失败' : null }] },
    })
    if (request.method() !== 'POST') return route.abort()
    writes.push({ path: pathname, body: request.postDataJSON() })
    if (pathname === `${servicePath}/groups`) {
      formalCreated = true
      return route.fulfill({ status: 201, json: { id: 'formal' } })
    }
    if (pathname === `${targetPath}/members`) {
      peterEnabled = request.postDataJSON().enabled
      return route.fulfill({ json: { ok: true } })
    }
    if (pathname === `${targetPath}/trial`) {
      status = 'queued'
      return route.fulfill({ status: 202, json: { id: String(++trialId) } })
    }
    if (pathname === `${servicePath}/services/infringement`) {
      current = request.postDataJSON().groupId
      return route.fulfill({ json: { ok: true } })
    }
    return route.abort()
  })

  await page.goto('/settings?tab=notifications')
  await expect(page.getByRole('button', { name: '侵权提醒', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const receiving = page.getByRole('heading', { name: '当前接收群' }).locator('..').locator('..')
  await expect(receiving).toContainText('测试群')
  await expect(page.getByText('没有可切换的群。', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '新增群', exact: true }).click()
  const addGroup = page.getByRole('dialog', { name: '新增企业微信群' })
  await addGroup.getByLabel('群名称').fill('正式群')
  await addGroup.getByLabel('机器人 Webhook 链接').fill(webhookUrl)
  await addGroup.getByRole('button', { name: '保存群', exact: true }).click()
  await expect(page.getByText('Webhook 尾号 2222')).toBeVisible()
  await expect(page.getByRole('combobox', { name: '目标群' })).toContainText('正式群')
  await expect(receiving).toContainText('测试群')
  await expect(page.getByRole('button', { name: '试发到目标群' })).toBeDisabled()
  await page.getByRole('checkbox', { name: '启用 Peter' }).click()
  await expect(page.getByRole('checkbox', { name: '启用 Peter' })).toBeChecked()
  await page.getByRole('combobox', { name: '试发接收人' }).click()
  await expect(page.getByRole('option', { name: '停用账号' })).toHaveCount(0)
  await page.getByRole('option', { name: 'Peter' }).click()
  await page.getByLabel('试发商品 SKU').fill('HUC.FXJP-HEI-JIT-02618')
  const switchButton = page.getByRole('button', { name: '切换自动推送', exact: true })
  const trialButton = page.getByRole('button', { name: '试发到目标群' })
  await expect(switchButton).toBeDisabled()
  await trialButton.click()
  await expect(page.getByText('文字已送达，正在等待主图。')).toBeVisible()
  await expect(switchButton).toBeDisabled()
  status = 'failed'
  await expect(page.getByRole('alert')).toContainText('模拟主图发送失败')
  await expect(switchButton).toBeDisabled()
  await trialButton.click()
  await expect(page.getByText('文字已送达，正在等待主图。')).toBeVisible()
  status = 'sent'
  await expect(switchButton).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('group-trial-success.png'), fullPage: true })
  await switchButton.click()
  const dialog = page.getByRole('dialog', { name: '确认切换自动推送' })
  await expect(dialog).toContainText('正式群')
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(writes).toHaveLength(4)
  await switchButton.click()
  await dialog.getByRole('button', { name: '确认切换', exact: true }).click()
  await expect(receiving).toContainText('正式群')
  await expect(page.getByText('自动推送已切换至「正式群」。')).toBeVisible()
  expect(writes).toEqual([
    { path: `${servicePath}/groups`, body: { name: '正式群', webhookUrl, enabled: true } },
    { path: `${targetPath}/members`, body: { accountId: 'peter', enabled: true } },
    { path: `${targetPath}/trial`, body: { service: 'infringement', accountId: 'peter', sku: 'HUC.FXJP-HEI-JIT-02618' } },
    { path: `${targetPath}/trial`, body: { service: 'infringement', accountId: 'peter', sku: 'HUC.FXJP-HEI-JIT-02618' } },
    { path: `${servicePath}/services/infringement`, body: { groupId: 'formal' } },
  ])
})
