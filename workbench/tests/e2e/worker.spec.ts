import { expect, test } from '@playwright/test'

test('real local Workers and D1 return the audited tier counts and paginated catalog', async ({
  request,
}) => {
  expect(await (await request.get('/api/session')).json()).toMatchObject({ local: true, role: 'admin' })
  const meta = await (await request.get('/api/catalog/meta')).json()
  expect(meta).toMatchObject({ total: 22664, historyProducts: 125 })
  for (const [tier, count] of [
    ['50k', 55],
    ['30k', 41],
    ['10k', 88],
  ] as const) {
    const page = await (
      await request.get('/api/products', {
        params: { platform: 'temu', category: 'temu:9711', maxPrice: 4, tier, pageSize: 1 },
      })
    ).json()
    expect(page.total).toBe(count)
    expect(page.items).toHaveLength(1)
  }
  const perf = []
  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    const response = await request.get('/api/products', { params: { page: i + 1, pageSize: 50 } })
    expect((await response.json()).items).toHaveLength(50)
    perf.push(performance.now() - start)
  }
  perf.sort((a, b) => a - b)
  console.info('Local catalog, 20 requests × 50 rows; P95 = ' + perf[18].toFixed(1) + ' ms')
  expect(perf[18]).toBeLessThan(1000)
})
test('rejects cross-origin writes and returns a real missing configuration response', async ({
  request,
}) => {
  const forged = await request.post('/api/strategy', {
    headers: { Origin: 'https://outside.invalid' },
    data: {},
  })
  expect(forged.status()).toBe(403)
  const connections = await (await request.get('/api/connections')).json()
  expect(connections.amazon.configured).toBe(false)
  const check = await request.post('/api/connections/amazon/test', { data: {} })
  expect(check.status()).toBe(409)
  expect(await check.json()).toMatchObject({ code: 'NOT_CONFIGURED', source: 'amazon' })
})
test('round-trips a small browser JPEG through local private R2 and D1', async ({ page, request }) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 30
    canvas.height = 18
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#465c72'
    ctx.fillRect(0, 0, 30, 18)
    return canvas.toDataURL('image/jpeg')
  })
  const upload = () => request.post('/api/research-images', { data: { dataUrl } })
  const first = await upload()
  expect(first.status()).toBe(201)
  const ref = await first.json()
  expect(ref).toMatchObject({ width: 30, height: 18 })
  expect(await (await upload()).json()).toMatchObject({ id: ref.id })
  const photo = await request.get('/api/research-images/' + ref.id)
  expect(photo.headers()['content-type']).toBe('image/jpeg')
  expect((await photo.body()).subarray(0, 2).toString('hex')).toBe('ffd8')
})
