import { expect, test } from '@playwright/test'
import type { ChatTurn, Conversation } from '../../packages/assistant/model'
import { screens } from './screens'

test('uses current filters and objects, controls an investigation and restores it after closing', async ({
  page,
}) => {
  const turns: Record<string, unknown>[] = []
  const timestamp = new Date().toISOString()
  let status = 'running'
  let runId = ''
  const requests: Record<string, unknown>[] = []
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url())
    if (url.pathname === '/api/rpc/session')
      return route.fulfill({
        json: { json: { id: 'u1', username: 'demo', role: 'operator', local: false } },
      })
    if (url.pathname === '/api/assistant/conversations')
      return route.fulfill({
        json: {
          items: turns.length ? [{ id: 'thread', title: '比较已有商品', updatedAt: timestamp }] : [],
          more: false,
          unavailable: null,
        },
      })
    if (/\/assistant\/conversations\/[^/]+\/(turns|investigations)$/.test(url.pathname)) {
      const body = req.postDataJSON()
      requests.push(body)
      const investigation = url.pathname.endsWith('/investigations')
      if (investigation) runId = 'run-1'
      const turn = {
        id: body.id,
        question: body.question,
        hasImage: 0,
        page: body.page,
        createdAt: timestamp,
        answer: investigation ? null : '上下文已收到',
        issue: null,
        ...(investigation ? { runId, runStatus: status } : {}),
      }
      turns.push(turn)
      return route.fulfill({ json: turn })
    }
    if (/\/assistant\/conversations\/[^/]+$/.test(url.pathname))
      return route.fulfill({
        json: {
          items: turns.map((t) => ({
            ...t,
            ...(t.runId
              ? {
                  runStatus: status,
                  answer:
                    status === 'cancelled'
                      ? '<script>unsafe</script> 部分结果已保存\n资料缺口：缺少尺寸信息'
                      : null,
                }
              : {}),
          })),
          more: false,
        },
      })
    if (url.pathname.startsWith('/api/assistant/investigations/')) {
      if (req.method() === 'POST') {
        const action = url.pathname.split('/').at(-1)
        status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running'
      }
      return route.fulfill({
        json: {
          id: runId,
          status,
          modelSteps: 2,
          toolSteps: 3,
          usage: { dataPoints: 0, aiMicros: 3000, unconfirmedAiMicros: 1000 },
          limits: { aiMicros: 360000 },
          summary: '已读取 3 件已有商品',
          answer: status === 'cancelled' ? '<script>unsafe</script> 部分结果已保存' : null,
          report:
            status === 'cancelled'
              ? {
                  recommendations: [{ productId: 'temu:US:17' }, { productId: 'javascript:alert(1)' }],
                  excluded: [],
                  coverage: { products: 2, tools: 3 },
                  linkedJobs: [
                    { jobId: '5de1c4ad-11c2-4c3e-bcf4-934547c26eac' },
                    { jobId: 'javascript:alert(1)' },
                  ],
                }
              : null,
        },
      })
    }
    return route.fulfill({ status: 503, json: { message: '无测试资料' } })
  })
  await page.goto('/?platform=temu&maxPrice=4&q=收纳')
  await page.getByRole('button', { name: '运营助手', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '运营助手' })
  await dialog.getByRole('textbox', { name: '消息' }).fill('查看当前筛选')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect(dialog.getByText('上下文已收到')).toBeVisible()
  expect(requests.at(-1)).toMatchObject({ filters: { platform: 'temu', maxPrice: '4', q: '收纳' } })
  await page.goto('/products/temu%3AUS%3A17')
  await page.getByRole('button', { name: '运营助手', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '运营助手' })
  await dialog.getByRole('textbox', { name: '消息' }).fill('比较这件商品的已有资料')
  await expect(dialog.getByText('仅使用已有资料；消耗 AI 额度，不产生数据积分。')).toBeVisible()
  await dialog.getByRole('button', { name: '开始调查（已有资料）' }).click()
  await expect(dialog.getByText('已读取 3 件已有商品')).toBeVisible()
  expect(requests.at(-1)).toMatchObject({ productId: 'temu:US:17', page: '商品详情' })
  await expect(dialog.getByText('模型 2 步 · 工具 3 步')).toBeVisible()
  await expect(dialog.getByText('数据积分 0 · AI 已计费及预留 $0.003000 / $0.360000')).toBeVisible()
  await expect(dialog.getByText('其中未确认预留 $0.001000')).toBeVisible()
  for (const [, width, height] of screens) {
    await page.setViewportSize({ width, height })
    await expect(dialog.getByRole('button', { name: '开始调查（已有资料）' })).toBeInViewport()
    await expect(dialog.getByRole('button', { name: '发送消息' })).toBeInViewport()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await dialog.getByRole('button', { name: '暂停调查' }).click()
  await expect(dialog.getByText('已暂停', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '运营助手', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '运营助手' })
  await expect(dialog.getByRole('button', { name: '继续调查' })).toBeVisible()
  await dialog.getByRole('button', { name: '继续调查' }).click()
  await expect(dialog.getByRole('button', { name: '暂停调查' })).toBeVisible()
  await dialog.getByRole('button', { name: '取消调查' }).click()
  await expect(
    dialog.getByText('<script>unsafe</script> 部分结果已保存\n资料缺口：缺少尺寸信息', { exact: true }),
  ).toBeVisible()
  await expect(dialog.locator('script')).toHaveCount(0)
  await expect(dialog.getByText('调查覆盖 2 款商品 · 3 次读取')).toBeVisible()
  await expect(dialog.getByRole('link', { name: '查看商品 temu:US:17' })).toHaveAttribute(
    'href',
    '/products/temu%3AUS%3A17',
  )
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(
    dialog.getByRole('link', { name: '查看关联任务 5de1c4ad-11c2-4c3e-bcf4-934547c26eac' }),
  ).toHaveAttribute('href', '/tasks?id=5de1c4ad-11c2-4c3e-bcf4-934547c26eac')
  const jobId = '5de1c4ad-11c2-4c3e-bcf4-934547c26eac'
  await page.goto('/tasks?id=' + jobId)
  await page.getByRole('button', { name: '运营助手', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '运营助手' })
  await dialog.getByRole('textbox', { name: '消息' }).fill('查看这个任务')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => requests.at(-1)).toMatchObject({ jobId, page: '任务中心' })
  expect(requests.at(-1)).not.toHaveProperty('productId')
})

test('sends a photo, opens another saved conversation and reads daily task progress', async ({
  page,
  baseURL,
}) => {
  const conversations: Conversation[] = []
  const transcripts = new Map<string, ChatTurn[]>()
  const timestamp = new Date().toISOString()
  await page.route(
    (url) => url.origin !== new URL(baseURL!).origin,
    (r) => r.abort(),
  )
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url())
    if (url.pathname === '/api/rpc/session')
      return route.fulfill({
        json: {
          json: {
            id: 'u1',
            email: 'demo',
            username: 'demo',
            role: 'viewer',
            position: null,
            local: false,
          },
        },
      })
    if (url.pathname === '/api/assistant/conversations')
      return route.fulfill({ json: { items: conversations, more: false, unavailable: null } })
    const match = /^\/api\/assistant\/conversations\/([^/]+)(\/turns)?$/.exec(url.pathname)
    if (match) {
      const [, id, send] = match
      if (!send) return route.fulfill({ json: { items: transcripts.get(id) ?? [], more: false } })
      const { question, image, id: turn } = req.postDataJSON()
      const row = {
        id: turn,
        question,
        answer: '收到「' + question + '」',
        hasImage: Number(!!image),
        page: '任务中心',
        createdAt: timestamp,
        issue: null,
      }
      if (!transcripts.has(id)) conversations.unshift({ id, title: question, updatedAt: timestamp })
      transcripts.set(id, [...(transcripts.get(id) ?? []), row])
      return route.fulfill({ json: row })
    }
    if (url.pathname.includes('/images/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII=',
          'base64',
        ),
      })
    if (url.pathname === '/api/assistant/daily-tasks')
      return route.fulfill({
        json: {
          date: url.searchParams.get('date'),
          task: {
            id: 'daily-1',
            title: '每日潜力新品',
            status: 'running',
            summary: '正在筛选',
            steps: 2,
            selected: 7,
            latestStep: '筛选商品',
            updatedAt: timestamp,
          },
        },
      })
    if (url.pathname === '/api/jobs')
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
    return route.fulfill({ status: 503, json: { message: '测试数据暂不可用。' } })
  })
  await page.goto('/tasks')
  await page.getByRole('button', { name: '运营助手' }).click()
  const dialog = page.getByRole('dialog', { name: '运营助手' })
  await expect(dialog.getByRole('textbox', { name: '消息' })).toBeVisible()
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'product.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(dialog.getByAltText('待发送的图片')).toBeVisible()
  await dialog.getByRole('textbox', { name: '消息' }).fill('看这张商品图')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect(dialog.getByText('收到「看这张商品图」')).toBeVisible()
  await dialog.getByRole('button', { name: '新建对话' }).click()
  await expect(dialog.getByText('收到「看这张商品图」')).toHaveCount(0)
  await dialog.getByRole('textbox', { name: '消息' }).fill('另一个问题')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect(dialog.getByText('收到「另一个问题」')).toBeVisible()
  await dialog.getByRole('button', { name: '历史对话' }).click()
  await dialog.getByRole('button', { name: /看这张商品图/ }).click()
  await expect(dialog.getByText('收到「看这张商品图」')).toBeVisible()
  await expect(dialog.getByAltText('对话中上传的图片')).toBeVisible()
  await dialog.getByRole('button', { name: '更多选项' }).click()
  await dialog.getByRole('button', { name: '每日选品任务' }).click()
  await expect(dialog.getByText('已完成 2 个步骤 · 筛出 7 件商品')).toBeVisible()
  await expect(dialog.getByRole('link', { name: '查看执行详情与选品结果' })).toHaveAttribute(
    'href',
    '/tasks?id=daily-1',
  )
  await dialog.getByRole('button', { name: '返回对话' }).click()
  const width = page.viewportSize()!.width
  await page.setViewportSize({ width, height: 410 })
  await dialog.getByRole('textbox', { name: '消息' }).focus()
  await expect(dialog.getByRole('button', { name: '发送消息' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: '新建对话' })).toBeInViewport()
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toHaveCount(0)
})
