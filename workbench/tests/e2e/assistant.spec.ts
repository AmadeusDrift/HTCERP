import { expect, test } from '@playwright/test'
import type { ChatTurn, Conversation } from '../../packages/assistant/model'

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
