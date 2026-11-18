import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { AmazonUS } from '../../packages/amazon/adapter'
import { ProductImages } from '../../packages/product-images/service'
import { PrivateFileCache } from '../../packages/product-images/cache'
import { exportPickingSheet } from '../../packages/order-sorting/picking-workbook'
import { sortOrders } from '../../packages/order-sorting/rules'
import { PickingSheets } from '../../packages/order-sorting/picking-service'

const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
)
const databases: DatabaseSync[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
})
const scope = { sellerAccountId: 'seller-a', marketplaceId: 'ATVPDKIKX0DER' }
function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(readFileSync('migrations/0055_product_image_cache.sql', 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const s = db.prepare(sql)
    return {
      bind: (...v: SQLInputValue[]) => prepare(sql, v),
      first: async () => s.get(...values) ?? null,
      run: async () => ({ meta: s.run(...values) }),
    }
  }
  const objects = new Map<string, Uint8Array>()
  const env = {
    DB: { prepare },
    ARCHIVE: {
      get: async (key: string) => {
        const b = objects.get(key)
        return b ? { size: b.length, arrayBuffer: async () => b.slice().buffer } : null
      },
      put: async (key: string, b: Uint8Array) => {
        objects.set(key, b.slice())
      },
    },
  } as never
  const resolve = vi.fn(async (_seller: string, sku: string) => ({
    asin: sku.endsWith('79') ? 'B000000079' : 'B000000058',
    url: 'https://m.media-amazon.com/images/I/' + sku + '.png',
  }))
  const send = vi.fn<typeof fetch>(async () => new Response(png.slice().buffer))
  return {
    env,
    db,
    objects,
    resolve,
    send,
    service: new ProductImages(env, { productMainImage: resolve }, send),
  }
}
it('resolves the exact listing SKU/marketplace and selects the largest MAIN image, never another variant', async () => {
  const send = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'token' })
    if (url.pathname.includes('/listings/'))
      return Response.json({
        sku: 'HUCTCGJ-JIT-00079',
        summaries: [{ marketplaceId: scope.marketplaceId, asin: 'B000000079' }],
      })
    expect(url.pathname).toMatch(/\/B000000079$/)
    return Response.json({
      asin: 'B000000079',
      images: [
        {
          marketplaceId: scope.marketplaceId,
          images: [
            { variant: 'PT01', link: 'wrong', width: 3000, height: 3000 },
            { variant: 'MAIN', link: 'small', width: 75, height: 75 },
            { variant: 'MAIN', link: 'large', width: 1500, height: 1500 },
          ],
        },
      ],
    })
  })
  const api = new AmazonUS(
    { SP_CLIENT_ID: 'client-test', SP_CLIENT_SECRET: 'secret-test', SP_REFRESH_TOKEN: 'refresh-test' },
    send,
  )
  expect(await api.productMainImage('seller-a', 'HUCTCGJ-JIT-00079')).toEqual({
    asin: 'B000000079',
    url: 'large',
  })
})
it('caches the two SKU images in ERP, reuses them across instances, and isolates sellers', async () => {
  const f = setup()
  const a = await f.service.get(scope, 'HUCTCGJ-JIT-00079')
  const b = await f.service.get(scope, 'HUCTCGJ-JIT-00058')
  expect([a.asin, b.asin]).toEqual(['B000000079', 'B000000058'])
  const otherComputer = new ProductImages(f.env, { productMainImage: f.resolve }, f.send)
  expect(await otherComputer.get(scope, 'HUCTCGJ-JIT-00079')).toEqual(a)
  expect(f.resolve).toHaveBeenCalledTimes(2)
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.send.mock.calls[0][1]?.headers).toBeUndefined()
  await otherComputer.get({ ...scope, sellerAccountId: 'seller-b' }, 'HUCTCGJ-JIT-00079')
  expect(f.resolve).toHaveBeenCalledTimes(3)
})
it('coordinates concurrent requests and recovers damaged ERP image bytes', async () => {
  const f = setup()
  await Promise.all([
    f.service.get(scope, '79'),
    new ProductImages(f.env, { productMainImage: f.resolve }, f.send).get(scope, '79'),
  ])
  expect(f.send).toHaveBeenCalledTimes(1)
  const row = f.db.prepare('SELECT object_key FROM product_image_cache').get() as { object_key: string }
  f.objects.set(row.object_key, new Uint8Array([1, 2]))
  await f.service.get(scope, '79')
  expect(f.send).toHaveBeenCalledTimes(2)
})
it('rejects untrusted image URLs and non-image responses without persisting a success', async () => {
  const f = setup()
  f.resolve.mockResolvedValueOnce({ asin: 'B000000079', url: 'http://127.0.0.1/private' })
  await expect(f.service.get(scope, '79')).rejects.toThrow()
  expect(f.send).not.toHaveBeenCalled()
  f.send.mockResolvedValueOnce(new Response('<html>not an image</html>'))
  await expect(f.service.get(scope, '79')).rejects.toThrow()
  expect(
    f.db.prepare('SELECT count(*) n FROM product_image_cache WHERE object_key IS NOT NULL').get()?.n,
  ).toBe(0)
})
it('fences a stale producer instead of replacing the new cached workbook', async () => {
  const f = setup(),
    cache = new PrivateFileCache(f.env)
  await expect(
    cache.getOrCreate('sheet', async () => {
      f.db
        .prepare('UPDATE product_image_cache SET lease_owner=?,lease_until=?')
        .run('new-owner', Date.now() + 90000)
      return { bytes: png, metadata: { type: 'image/png' } }
    }),
  ).rejects.toThrow()
  expect(f.db.prepare('SELECT object_key FROM product_image_cache').get()?.object_key).toBeNull()
})
it('embeds images by SKU, sums all three units, and preserves raw order records in a factory sheet', async () => {
  const f = setup()
  const plan = sortOrders(
    {
      date: '2026-11-17',
      rows: [
        ['Ceramic', 'HUCTCGJ-JIT-00079', 'X005EC8JYT', 'TEST79', 2],
        ['Ceramic', 'HUCTCGJ-JIT-00058', 'X005EC4Z9R', 'TEST58', 1],
      ],
    },
    [['HUC', 'TCGJ', 'HUCTCGJ', null, '陶瓷挂件', '7.3×7.3', '陶瓷', 5.75, '纸盒', 'OPP袋', null]],
  )
  const images = new Map(
    await Promise.all(
      ['HUCTCGJ-JIT-00058', 'HUCTCGJ-JIT-00079'].map(
        async (sku) => [sku, await f.service.get(scope, sku)] as const,
      ),
    ),
  )
  const group = plan.groups[0]
  const bytes = await exportPickingSheet(group, plan.date, images)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as never)
  const sheet = book.worksheets[0]
  expect(sheet.getCell('E4').value).toBe('图片')
  expect(sheet.getCell('H3').value).toMatchObject({ formula: 'SUM(H5:H6)', result: 3 })
  expect(sheet.getImages()).toHaveLength(2)
  expect(sheet.getImages().map((x) => [x.range.tl.nativeCol, x.range.tl.nativeRow])).toEqual([
    [4, 4],
    [4, 5],
  ])
  expect(book.worksheets[1].rowCount).toBe(3)
  expect(sheet.pageSetup.fitToWidth).toBe(1)
})
it('persists the finished workbook and reuses the exact bytes on another computer', async () => {
  const f = setup(),
    plan = sortOrders({ date: '2026-11-17', rows: [['Mug', 'SKU79', 'X005EC8JYT', 'TR1', 2]] }, [])
  const sheets = new PickingSheets(f.env, f.service)
  const first = await sheets.generate(scope, 'preview-a', plan.groups[0], plan.date)
  expect(
    await new PickingSheets(f.env, f.service).generate(scope, 'preview-a', plan.groups[0], plan.date),
  ).toEqual(first)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM product_image_cache WHERE cache_key LIKE '%/sheet/%' AND object_key IS NOT NULL",
      )
      .get()?.n,
  ).toBe(1)
})
it('reports a missing SKU and never caches an incomplete factory workbook', async () => {
  const f = setup(),
    plan = sortOrders({ date: '2026-11-17', rows: [['Mug', 'SKU79', 'X005EC8JYT', 'TR1', 2]] }, [])
  f.send.mockResolvedValueOnce(new Response('', { status: 404 }))
  await expect(
    new PickingSheets(f.env, f.service).generate(scope, 'a', plan.groups[0], plan.date),
  ).rejects.toThrow('SKU79')
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM product_image_cache WHERE cache_key LIKE '%/sheet/%' AND object_key IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0)
})
