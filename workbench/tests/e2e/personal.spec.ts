import { expect, test } from '@playwright/test'
import type { Personal, Preset } from '../../packages/personal/model'
import { chooseOption } from './choose-option'

test('员工保存个人默认值和筛选预设后可恢复，明确的分页和视图仍优先', async ({ page }) => {
  const actor = {
    id: 'preset-user',
    username: '采买一组',
    email: 'test',
    role: 'viewer',
    position: '采买',
    local: false,
  }
  let personal: Personal = { view: 'table', pageSize: 50, presets: [] }
  let requestedSize = ''
  let created: Preset | undefined
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname
    if (path === '/api/rpc/session') return route.fulfill({ json: { json: actor } })
    if (path === '/api/me/preferences') {
      if (route.request().method() === 'POST')
        personal = { ...personal, ...route.request().postDataJSON() }
      return route.fulfill({ json: personal })
    }
    if (path === '/api/me/presets') {
      created = { id: '1f75ef0d-2806-43c1-adde-73ed1ac064d3', ...route.request().postDataJSON() }
      personal.presets = [created!]
      return route.fulfill({ status: 201, json: created })
    }
    if (path.endsWith('/rename')) {
      personal.presets[0].name = route.request().postDataJSON().name
      return route.fulfill({ json: personal.presets[0] })
    }
    if (path.endsWith('/delete')) {
      personal.presets = []
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/products') {
      requestedSize = url.searchParams.get('pageSize') ?? ''
      return route.fulfill({ json: { total: 0, items: [] } })
    }
    if (path === '/api/catalog/meta')
      return route.fulfill({ json: { total: 0, platforms: [], tiers: [], categories: [] } })
    return route.fulfill({ status: 503, json: { message: '测试未提供此数据' } })
  })
  const settings = '/settings?tab=personal'
  await page.goto(settings)
  await chooseOption(page.getByLabel('默认视图'), '网格视图')
  await chooseOption(page.getByLabel('默认每页数量'), '20 条 / 页')
  await page.getByRole('button', { name: '保存显示设置' }).click()
  await expect(page.getByText('发现页显示设置已保存。')).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('button', { name: '网格视图' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => requestedSize).toBe('20')
  const saved = {
    platform: 'temu',
    category: 'home',
    maxPrice: '4',
    tier: '10k',
    sort: 'min_price',
    order: 'asc',
  }
  await page.goto('/?' + new URLSearchParams({ ...saved, view: 'table', page: '2', pageSize: '10' }))
  await expect(page.getByRole('button', { name: '表格视图' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => requestedSize).toBe('10')
  const open = page.getByRole('button', { name: '我的预设' })
  const dialog = page.getByRole('dialog')
  await open.click()
  await dialog.getByLabel('新预设名称').fill('低价家居')
  await dialog.getByRole('button', { name: '保存当前条件' }).click()
  await expect(dialog.getByText('已保存当前筛选和排序。')).toBeVisible()
  expect(created?.filters).toEqual(saved)
  await page.goto('/?view=grid&pageSize=100&page=3&platform=shein')
  await open.click()
  await chooseOption(dialog.getByLabel('已保存的预设'), '低价家居')
  await dialog.getByRole('button', { name: '应用预设' }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get('platform') === 'temu')
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
    ...saved,
    view: 'grid',
    pageSize: '100',
  })
  await page.goto(settings)
  await page.getByRole('button', { name: '重命名' }).click()
  await dialog.getByLabel('预设名称').fill('家居精选')
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: '家居精选' })).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText(/还没有预设/)).toBeVisible()
})
