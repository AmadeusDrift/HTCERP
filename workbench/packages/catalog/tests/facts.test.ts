import { describe, expect, it } from 'vitest'
import { normalizeHistory, normalizeProduct } from '../facts'

const origin = {
  platform: 'temu' as const,
  market: 'US' as const,
  source: 'bootstrap',
  evidenceRef: 'cache/a',
  fetchedAt: null,
}
const row = {
  goodsId: '60111',
  goodsName: 'Pan',
  sold: 50000,
  weekSold: 0,
  monthSold: 800,
  daySold: null,
  minPrice: 0,
  thumbnail: '//img.kwcdn.com/p.jpg',
  linkUrl: 'javascript:bad',
  updateTime: '2026-10-31T08:01:03.456+08:00',
  catItems: [
    { catLevel: 2, catId: 2, catName: 'Kitchen' },
    { catLevel: 1, catId: 9711, parentCatId: 0, catName: '家居' },
  ],
  sku: JSON.stringify([{ skuId: 12, specs: [{ specKey: 'Size', specValue: 'M' }] }]),
}

describe('source normalization', () => {
  it('preserves source scope, currency, nulls, actual zeros, catalog evidence and UTC', () => {
    const p = normalizeProduct(row, origin)
    expect(p).toMatchObject({
      id: 'temu:US:60111',
      total_sold: 50000,
      total_sold_field: 'sold',
      month_sold: 800,
      week_sold: 0,
      day_sold: null,
      currency: 'USD',
      min_price: 0,
      category_id: '9711',
      category_path: '家居 / Kitchen',
      source_url: null,
      thumbnail: 'https://img.kwcdn.com/p.jpg',
      updated_at: '2026-10-31T00:01:03.456Z',
      fetched_at: null,
    })
    expect(JSON.parse(p.variants_json)).toEqual([
      { sku_id: '12', specs: [{ specKey: 'Size', specValue: 'M' }] },
    ])
  })

  it('uses the designated cumulative field on each platform without fallback', () => {
    const shein = { ...origin, platform: 'shein' as const }
    expect(normalizeProduct(row, shein).total_sold).toBeNull()
    expect(normalizeProduct({ ...row, totalSold: 0 }, shein).total_sold).toBe(0)
    expect(normalizeProduct({ ...row, sold: undefined }, origin).total_sold).toBeNull()
  })

  it('preserves only actual SKU stock and usable thumbnails; never substitutes whole-product metrics', () => {
    const result = normalizeProduct(
      {
        ...row,
        sku: [
          { skuId: 'A', stock: 0, thumbUrl: '//img.kwcdn.com/a.jpg' },
          { skuId: 'B', stock: -1, thumbUrl: 'https://detail.geekbi.com/s.jpg' },
          { skuId: 'C', thumbUrl: 'javascript:bad' },
        ],
      },
      origin,
    )
    expect(JSON.parse(result.variants_json)).toEqual([
      { sku_id: 'A', specs: [], stock: 0, thumbnail: 'https://img.kwcdn.com/a.jpg' },
      { sku_id: 'B', specs: [] },
      { sku_id: 'C', specs: [] },
    ])
  })

  it('does not invent historical observations for missing dates or invalid identifiers', () => {
    expect(normalizeHistory({ monthSold: 250 }, 'temu:US:60111', origin)).toBeNull()
    expect(() => normalizeProduct({ ...row, goodsId: 9007199254740992 }, origin)).toThrow()
    expect(() => normalizeProduct({ ...row, siteId: 19 }, origin)).toThrow()
  })
})
