import { expect, test } from '@playwright/test'

test('差评专区展示商品证据、保存处理记录并预览企业微信草稿', async ({ page }) => {
  let state = 'pending',
    note = ''
  let assigned = false,
    bound = false,
    notified = false
  const run = {
    id: 'weekly-feedback-fixture',
    seller: 'SELLERA',
    marketplace: 'ATVPDKIKX0DER',
    week: '2026-11-02',
    started: '2026-11-04T01:00:00Z',
    finished: '2026-11-04T01:10:00Z',
    status: 'done',
    error: null,
    reported: 2,
    incomplete: 0,
  }
  await page.route('**/api/weekly-feedback**', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.pathname.endsWith('/action')) {
      const input = request.postDataJSON()
      state = input.state
      note = input.note
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/assign')) {
      assigned = true
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/wecom-member')) {
      bound = true
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/wecom'))
      return route.fulfill({
        json: {
          configured: true,
          credentialEditing: true,
          members: [{ id: 'bob', name: '运营乙', userid: bound ? 'wecom_bob' : null }],
        },
      })
    if (url.pathname.endsWith('/notify')) {
      notified = true
      return route.fulfill({ json: { sent: 1, message: '通知处理完成，请查看发送记录。' } })
    }
    if (url.pathname.endsWith('/notification'))
      return route.fulfill({
        json: {
          ready: assigned && bound,
          sent: false,
          unassigned: 1,
          text: '商品差评原因周报\nSKU：SKU-001 / SKU-002\nASIN：B000000001',
          reason: '待配置运营及企业微信成员映射。',
        },
      })
    return route.fulfill({
      json: {
        store: { seller: 'SELLERA' },
        enabled: false,
        schedule: '每周一 09:00（北京时间）',
        run,
        runs: [run],
        stats: { skus: 2, asins: 1, issues: 1, parents: 0, unresolved: 0, noData: 0, failed: 0 },
        exclusions: [],
        page: 0,
        total: 1,
        assignmentReady: false,
        notificationReady: false,
        members: [{ id: 'bob', name: '运营乙' }],
        deliveries: notified
          ? [
              {
                account_id: 'bob',
                name: '运营乙',
                status: 'sent',
                error: null,
                updated_at: '2026-11-04T01:15:00Z',
              },
            ]
          : [],
        rows: [
          {
            asin: 'B000000001',
            skus: ['SKU-001', 'SKU-002'],
            title: 'Printed Mug',
            image: null,
            imageError: null,
            operatorName: assigned ? '运营乙' : null,
            assignments: [
              { sku: 'SKU-001', accountId: assigned ? 'bob' : null, name: assigned ? '运营乙' : null },
            ],
            status: 'available',
            period: { startDate: '2026-05-01', endDate: '2026-11-01' },
            topics: [
              {
                name: 'Print Quality',
                label: '印刷质量',
                mentions: 12,
                snippets: ['Blurry print'],
                occurrence: 8,
                impact: -0.2,
                action: '核对印刷文件、成品清晰度及近期生产批次。',
                handling: { state, note, updated_at: null, updated_by: null },
              },
            ],
          },
        ],
      },
    })
  })
  await page.goto('/feedback')
  await expect(page.getByRole('heading', { name: '差评专区', exact: true })).toBeVisible()
  await expect(page.getByText('SKU-001 / SKU-002', { exact: true })).toBeVisible()
  await expect(page.getByText('B000000001', { exact: true })).toBeVisible()
  await expect(page.getByText('Blurry print', { exact: true })).toBeVisible()
  await page.getByLabel('处理状态 · Print Quality').selectOption('working')
  await page.getByLabel('处理备注 · Print Quality').fill('已联系生产核对样品')
  await page.getByRole('button', { name: '保存处理记录' }).click()
  await expect(page.getByText('处理记录已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '运营与企业微信设置', exact: true }).click()
  await page.getByLabel('企业微信 UserID · 运营乙').fill('wecom_bob')
  await page.getByRole('button', { name: '保存成员绑定' }).click()
  await expect(page.getByText('成员绑定已保存', { exact: true })).toBeVisible()
  await page.getByText('分配负责运营', { exact: true }).click()
  await page.getByLabel('负责运营 · SKU-001').selectOption('bob')
  await page.getByRole('button', { name: '保存归属' }).click()
  await expect(page.getByText('负责运营：运营乙', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '企业微信草稿' }).click()
  await expect(page.getByRole('heading', { name: '企业微信通知草稿' })).toBeVisible()
  await expect(page.getByLabel('通知草稿内容')).toContainText('SKU：SKU-001 / SKU-002')
  await page.getByRole('button', { name: '发送给已绑定运营' }).click()
  await expect(page.getByText('通知处理完成，请查看发送记录。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '收起接入设置' }).click()
  await page.getByRole('button', { name: '收起草稿' }).click()
  for (const width of [360, 390, 600, 768, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    if (width <= 980) await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.getByRole('heading', { name: '差评专区', exact: true })).toBeVisible()
    expect(
      (await page.getByRole('heading', { name: '差评专区', exact: true }).boundingBox())?.x,
    ).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    )
    if (width === 390 || width === 1440) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: '.local/weekly-feedback-' + width + '.png', fullPage: true })
    }
  }
})

test('差评专区空状态指引先配置或生成周报', async ({ page }) => {
  await page.route('**/api/weekly-feedback**', (route) =>
    route.fulfill({
      json: {
        store: null,
        enabled: false,
        runs: [],
        run: null,
        stats: null,
        exclusions: [],
        rows: [],
        total: 0,
        page: 0,
        schedule: '每周一 09:00（北京时间）',
      },
    }),
  )
  await page.goto('/feedback')
  await expect(page.getByText('还没有商品差评周报', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '配置 Amazon 数据连接' })).toBeVisible()
})
