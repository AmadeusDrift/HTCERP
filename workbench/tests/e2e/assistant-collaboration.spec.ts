import { expect, test } from '@playwright/test'
import { screens } from './screens'

test('confirms a bounded proposal, sends steering to the same run and preserves report history', async ({
  page,
}) => {
  const time = new Date().toISOString(),
    runId = crypto.randomUUID(),
    threadId = crypto.randomUUID()
  const messages: Record<string, unknown>[] = [],
    requests: string[] = []
  const created: { conversationId: string; turn: Record<string, unknown> }[] = []
  let proposalStatus = 'pending',
    status = 'awaiting_confirmation'
  const proposal = () => ({
    id: 'proposal-1',
    scopeVersion: 1,
    status: proposalStatus,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    maxDataPoints: 10,
    maxAiMicros: 360000,
    actions: [
      {
        operation: 'research',
        productId: 'temu:US:17',
        pages: 1,
        calls: 8,
        childResearch: 0,
        maxDataPoints: 0,
        maxAiMicros: 33000,
        writeWatchPool: false,
      },
    ],
  })
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url())
    if (url.pathname === '/api/rpc/session')
      return route.fulfill({
        json: { json: { id: 'alice', username: 'alice', role: 'operator', local: false } },
      })
    if (url.pathname === '/api/assistant/conversations')
      return route.fulfill({
        json: {
          items: [{ id: threadId, title: '比较商品', updatedAt: time }],
          more: false,
          unavailable: null,
        },
      })
    if (url.pathname === '/api/assistant/conversations/' + threadId)
      return route.fulfill({
        json: {
          items: [
            {
              id: 'turn1',
              question: '比较商品',
              page: '商品库',
              createdAt: time,
              hasImage: 0,
              answer: null,
              issue: null,
              runId,
              runStatus: status,
            },
          ],
          more: false,
        },
      })
    const newPath = /^\/api\/assistant\/conversations\/([^/]+)\/investigations$/.exec(url.pathname)
    if (newPath && req.method() === 'POST') {
      const body = req.postDataJSON(),
        turn = {
          ...body,
          hasImage: 0,
          createdAt: time,
          answer: null,
          issue: null,
          runId: 'new-run',
          runStatus: 'running',
        }
      created.push({ conversationId: newPath[1], turn })
      return route.fulfill({ json: turn })
    }
    const newThread = created.find(
      (v) => url.pathname === '/api/assistant/conversations/' + v.conversationId,
    )
    if (newThread) return route.fulfill({ json: { items: [newThread.turn], more: false } })
    if (url.pathname === '/api/assistant/investigations/new-run')
      return route.fulfill({ json: { id: 'new-run', status: 'running', modelSteps: 0, toolSteps: 0 } })
    if (url.pathname.startsWith('/api/assistant/investigations/' + runId)) {
      if (req.method() === 'POST') {
        requests.push(url.pathname)
        if (url.pathname.endsWith('/confirm')) {
          proposalStatus = 'confirmed'
          status = 'waiting_jobs'
        }
        if (url.pathname.endsWith('/messages')) {
          messages.push({ ...req.postDataJSON(), state: 'pending' })
          return route.fulfill({ json: { id: messages.at(-1)!.id, runId, state: 'pending' } })
        }
      }
      return route.fulfill({
        json: {
          id: runId,
          status,
          modelSteps: 3,
          toolSteps: 4,
          scopeVersion: 1,
          usage: { dataPoints: 0, aiMicros: 40, unconfirmedAiMicros: 0 },
          limits: { aiMicros: 360000 },
          proposals: [proposal()],
          messages,
          reportVersions: [
            {
              revision: 2,
              scopeVersion: 1,
              generatedAt: time,
              answer: '先前结论保留',
              report: { summary: '先前结论保留' },
            },
          ],
        },
      })
    }
    return route.fulfill({ status: 503, json: { message: 'fixture no data' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '运营助手', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运营助手' })
  await expect(dialog.getByText('在线补查计划')).toBeVisible()
  await expect(dialog.getByText(/只分析，不写入观察池/)).toBeVisible()
  await page.screenshot({ path: '.local/phase34-assistant-desktop.png' })
  await page.setViewportSize({ width: 384, height: 832 })
  await page.screenshot({ path: '.local/phase34-assistant-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await dialog.getByRole('button', { name: '确认这次补查' }).click()
  await expect.poll(() => requests.filter((p) => p.endsWith('/confirm')).length).toBe(1)
  await expect(dialog.getByText('等待任务', { exact: true })).toBeVisible()
  await dialog.getByRole('textbox', { name: '补充调查条件' }).fill('排除第二款，重点比较第一款和第三款')
  await dialog.getByRole('button', { name: '发送补充，继续这次调查' }).click()
  await expect.poll(() => messages.length).toBe(1)
  expect(messages[0]).toMatchObject({
    intent: 'continue',
    message: '排除第二款，重点比较第一款和第三款',
  })
  await expect(
    dialog.getByRole('region', { name: '调查补充记录' }).getByText('排除第二款，重点比较第一款和第三款'),
  ).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '补充调查条件' })).toHaveValue('')
  await dialog.getByText('查看历史报告（1）', { exact: true }).click()
  await expect(dialog.getByText('先前结论保留')).toBeVisible()
  for (const [, width, height] of screens) {
    await page.setViewportSize({ width, height })
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(dialog.getByRole('button', { name: '发送消息' })).toBeInViewport()
  }
  await dialog.getByRole('textbox', { name: '消息', exact: true }).fill('继续刚才，补查尺寸')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => messages.length).toBe(2)
  expect(messages[1]).toMatchObject({ intent: 'continue', message: '继续刚才，补查尺寸' })
  await dialog.getByRole('textbox', { name: '消息', exact: true }).fill('另开一个宠物玩具调查')
  await dialog.getByRole('button', { name: '开始调查（已有资料）' }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0].conversationId).not.toBe(threadId)
  expect(created[0].turn.runId).not.toBe(runId)
  expect(status).toBe('waiting_jobs')
})

for (const scenario of [
  { name: 'viewer', role: 'viewer', scope: 1, expired: false },
  { name: 'expired', role: 'operator', scope: 1, expired: true },
  { name: 'old scope', role: 'operator', scope: 2, expired: false },
])
  test(
    'disables ' + scenario.name + ' confirmation and allows rejecting without sending online work',
    async ({ page }) => {
      const runId = crypto.randomUUID(),
        threadId = crypto.randomUUID(),
        time = new Date().toISOString()
      let rejected = false,
        confirmations = 0
      await page.route('**/api/**', async (route) => {
        const req = route.request(),
          path = new URL(req.url()).pathname
        if (path === '/api/rpc/session')
          return route.fulfill({
            json: { json: { id: 'alice', username: 'alice', role: scenario.role, local: false } },
          })
        if (path === '/api/assistant/conversations')
          return route.fulfill({
            json: { items: [{ id: threadId, title: '调查', updatedAt: time }], more: false },
          })
        if (path === '/api/assistant/conversations/' + threadId)
          return route.fulfill({
            json: {
              items: [
                {
                  id: 't',
                  question: '比较商品',
                  hasImage: 0,
                  createdAt: time,
                  page: '商品库',
                  runId,
                  runStatus: 'awaiting_confirmation',
                  answer: null,
                  issue: null,
                },
              ],
              more: false,
            },
          })
        if (path.startsWith('/api/assistant/investigations/' + runId)) {
          if (path.endsWith('/confirm')) confirmations++
          if (path.endsWith('/reject')) rejected = true
          return route.fulfill({
            json: {
              id: runId,
              status: 'awaiting_confirmation',
              scopeVersion: scenario.scope,
              modelSteps: 1,
              toolSteps: 1,
              proposals: rejected
                ? []
                : [
                    {
                      id: 'p',
                      scopeVersion: 1,
                      status: 'pending',
                      expiresAt: new Date(
                        Date.now() + (scenario.expired ? -60000 : 60000),
                      ).toISOString(),
                      maxDataPoints: 10,
                      maxAiMicros: 360000,
                      actions: [
                        {
                          operation: 'discovery',
                          platform: 'temu',
                          keyword: 'storage',
                          categoryId: 'home',
                          maxPrice: 4,
                          minSold: 10,
                          pages: 1,
                          calls: 1,
                          childResearch: 0,
                          maxDataPoints: 10,
                          maxAiMicros: 0,
                          writeWatchPool: false,
                        },
                      ],
                    },
                  ],
            },
          })
        }
        return route.fulfill({ status: 503, json: { message: 'fixture no data' } })
      })
      await page.goto('/')
      await page.getByRole('button', { name: '运营助手', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '运营助手' })
      await expect(dialog.getByRole('button', { name: '确认这次补查' })).toBeDisabled()
      await expect(dialog.getByText(/平台 temu · 类目 home · 关键词 storage/)).toBeVisible()
      await expect(dialog.getByText(/价格上限 \$4.000000 · 销量下限 10/)).toBeVisible()
      if (scenario.role === 'viewer')
        await expect(dialog.getByText('制定补查计划', { exact: true })).toHaveCount(0)
      await dialog.getByRole('button', { name: '拒绝补查' }).click()
      await expect.poll(() => rejected).toBe(true)
      await expect(dialog.getByRole('button', { name: '确认这次补查' })).toHaveCount(0)
      expect(confirmations).toBe(0)
    },
  )
