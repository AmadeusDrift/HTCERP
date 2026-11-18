import { expect, it } from 'vitest'
import { searchTerms } from '../../packages/title-audit/catalog'
import { buildTitleAuditInspector } from '../../packages/title-audit/context-review'
import { inspectTitle } from '../../packages/title-audit/rules'
import { listingState } from '../../packages/title-audit/listings'
it('screens each use separately and recognises aliases and whole words', () => {
  const both = inspectTitle('Kuromi Case Compatible with iPhone 16')
  expect(both.verdict).toBe('重点提醒')
  expect(both.hits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ term: 'iPhone', verdict: '通过' }),
      expect.objectContaining({ term: 'Kuromi', families: ['Sanrio'] }),
    ]),
  )
  expect(inspectTitle('Red Bulletin Board').hits.some((h) => h.families.includes('Red Bull'))).toBe(
    false,
  )
  expect(inspectTitle('HelloKitty Mug').verdict).toBe('重点提醒')
  expect(inspectTitle('Apple Slicer').verdict).toBe('通过')
  expect(inspectTitle('Apple Watch Series 10 Case').verdict).toBe('建议改写')
  expect(inspectTitle('Loki').verdict).toBe('冲突')
})
it('requires explicit applicable Amazon enforcement and ignores expired or foreign evidence correctly', () => {
  const summary = {
    marketplaceId: 'ATVPDKIKX0DER',
    status: ['BUYABLE'],
    itemName: 'A',
    asin: 'B123456789',
  }
  const issue = {
    code: '123',
    message: 'Price issue',
    marketplaceIds: [summary.marketplaceId],
    enforcements: { actions: [{ action: 'LISTING_SUPPRESSED' }], exemption: { status: 'NOT_EXEMPT' } },
  }
  expect(listingState({ sku: 'S', summaries: [summary], issues: [issue] }).disposition).toBe(
    '官方已限制销售',
  )
  expect(
    listingState({ sku: 'S', summaries: [summary], issues: [{ ...issue, marketplaceIds: ['OTHER'] }] })
      .disposition,
  ).toBe('仍可购买')
  expect(
    listingState({
      sku: 'S',
      issues: [{ ...issue, enforcements: { ...issue.enforcements, exemption: { status: 'EXEMPT' } } }],
    }).disposition,
  ).toBe('状态待确认')
  expect(
    listingState({
      sku: 'S',
      issues: [{ ...issue, enforcements: { actions: [{ action: 'SEARCH_SUPPRESSED' }] } }],
    }).disposition,
  ).toBe('状态待确认')
})

it('keeps listing attributes separate from trademark use', () => {
  for (const title of ["Men's Mountain Waterproof Jacket Windproof", '32 Colors Baby Sneaker 0-2 Years', 'Inflatable Costume Blow Up Dinosaur', 'Baby Booties (Button Style),13']) {
    expect(inspectTitle(title).verdict, title).toBe('通过')
  }
  expect(inspectTitle('Hello Kitty Mug, 32 Colors').verdict).toBe('重点提醒')
})

it('explains only the matched descriptive span and preserves adjacent brand and character uses', () => {
  expect(inspectTitle('Black T-Shirt, 8 x 10 Wall Art').verdict).toBe('通过')
  expect(inspectTitle('Red Bull T-Shirt').verdict).toBe('重点提醒')
  expect(inspectTitle('Jibbitz Charms').verdict).toBe('重点提醒')
  expect(inspectTitle('Stitch Story Metal Sign').verdict).toBe('冲突')
  expect(inspectTitle('Cross Stitch Wall Art').verdict).toBe('通过')
  expect(inspectTitle('').verdict).toBe('缺少标题，待补查')
})

it('separates model codes, decorative themes and shoe compatibility from brand or character claims', () => {
  for (const title of ['DD-3860-023', 'Cat Silhouette','Halloween Ghost Printed Pattern','Rock Guitar','Coastal Crab Printed Pattern','Tree of Life','Shoe Decorations for Crocs','1PC Mini Genie Aladdin Lamp Incense Burner,Home Decor, Idea']) expect(inspectTitle(title).verdict,title).toBe('通过')
  for (const title of ['Stitch Happy Sign','Official CAT Boots','Jibbitz Charms for Crocs','Red Bull Cat Silhouette']) expect(inspectTitle(title).verdict,title).not.toBe('通过')
})

it('screens the POD supplement and requires context for ambiguous car and brand names', () => {
  for (const [title, term] of [
    ['Tom and Jerry T-Shirt', 'Tom and Jerry'],
    ['Mercedes-Benz Car Decal', 'Mercedes-Benz'],
    ['VW Golf Car Floor Mats', 'Golf'],
    ['Official Jaguar Key Ring', 'Jaguar'],
  ]) {
    expect(inspectTitle(title).hits.some((hit) => hit.names.includes(term)), title).toBe(true)
  }
  for (const [title, term] of [
    ['Mini Desktop Fan', 'Mini'],
    ['Golf Ball Marker', 'Golf'],
    ['Lotus Flower Wall Art', 'Lotus'],
    ['Jaguar Wildlife Poster', 'Jaguar'],
    ['Jaguar Wildlife Car Decal', 'Jaguar'],
    ['Smart Car Charger with USB-C', 'Smart'],
    ['Caterpillar Insect Wall Art', 'Caterpillar'],
  ]) {
    expect(inspectTitle(title).hits.some((hit) => hit.names.includes(term)), title).toBe(false)
  }
  expect(searchTerms('Tom and Jerry', '品牌与 IP', 0, [], '').rows[0]?.name).toBe('Tom and Jerry')
  expect(searchTerms('Mercedes-Benz', '品牌与 IP', 0, [], '').rows[0]?.name).toBe('Mercedes-Benz')
})

it('recognises verified Cyberpunk titles and DC aliases with the required context', () => {
  for (const [title, name] of [
    ['Cyber-Punk 2077 T-Shirt', 'Cyberpunk 2077'],
    ['Cyberpunk2077 Key Ring', 'Cyberpunk 2077'],
    ['Cyber Punk Edgerunners Poster', 'Cyberpunk: Edgerunners'],
    ['Cyberpunk 2077 Phantom Liberty Mug', 'Cyberpunk 2077: Phantom Liberty'],
    ['The Dark-Knight Poster', 'The Dark Knight'],
    ['Dark Knight Rises Poster', 'The Dark Knight Rises'],
    ['DarkKnight Returns Poster', 'Batman: The Dark Knight Returns'],
    ['DC Comics DarkKnight Key Ring', 'Dark Knight'],
    ['Dark Knight Gotham City T-Shirt', 'Dark Knight'],
  ]) {
    expect(inspectTitle(title).hits.some((hit) => hit.names.includes(name)), title).toBe(true)
  }
  for (const title of [
    'Cyberpunk Neon City Wall Art',
    'Cyber Punk Dog Tag Key Ring',
    'Cyber-Punk Streetwear T-Shirt',
    'Dark Knight Dog Tag Key Ring',
    'Medieval Dark-Knight Armor Figurine',
    'Final Fantasy XIV Dark Knight Keychain',
    'Official DarkKnight Key Ring',
  ]) {
    expect(inspectTitle(title).hits.some((hit) => hit.families.some((name) => name === 'Cyberpunk' || name === 'DC')), title).toBe(false)
  }
  expect(searchTerms('Cyberpunk2077', '品牌与 IP', 0, [], '').rows[0]?.name).toBe('Cyberpunk 2077')
  expect(searchTerms('DarkKnight', '品牌与 IP', 0, [], '').rows).toContainEqual(
    expect.objectContaining({ name: 'Dark Knight', family: 'DC', policy: '结合上下文' }),
  )
})


it('keeps ordinary word matches out of the action queue while retaining title evidence', () => {
  const check = buildTitleAuditInspector([])
  expect(check('Rock Star Crew Neck T-Shirt')).toMatchObject({
    verdict: '低优先级',
    hits: [expect.objectContaining({ term: 'Rock', verdict: '低优先级' })],
  })
  expect(check('Authentic USA Crew Neck T-Shirt').verdict).toBe('低优先级')
  expect(check('Apple Slicer').verdict).toBe('通过')
  expect(check('Cross Stitch Wall Art').verdict).toBe('通过')
  expect(check('Fox Sweet Rolls，Portable Folding Makeup Mirror with Stand').verdict).toBe('通过')
})

it('reviews graphic themes and compatibility separately within one listing title', () => {
  const check = buildTitleAuditInspector([])
  expect(check('Floor Mats Compatible with Jeep Wrangler').verdict).toBe('通过')
  const result = check('Black Panther Decal Compatible with Jeep Wrangler')
  expect(result.verdict).toBe('重点提醒')
  expect(result.hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ term: 'Black Panther', verdict: '重点提醒' }),
    expect.objectContaining({ term: 'Jeep', verdict: '通过' }),
  ]))
  expect(check('Official Jeep Floor Mats').verdict).toBe('重点提醒')
  expect(check('Outdoor Jeep Crew Neck T-Shirt').verdict).toBe('重点提醒')
  expect(check('Black Panther Wildlife Poster').verdict).toBe('通过')
})

it('flags risky title wording without requiring an image or assuming an IP family', () => {
  const check = buildTitleAuditInspector([])
  for (const title of ['Cyber Punk Dog Tag Key Ring', 'Dark-Knight Dog Tag Key Ring', 'Jaguar Logo Graphic T-Shirt', 'Stitch Happy Sign']) {
    const result = check(title)
    expect(result.verdict, title).toBe('重点提醒')
    const hit = result.hits.find(h => h.verdict === '重点提醒')!
    if (!title.startsWith('Stitch')) expect(hit.families).toEqual([])
    expect(hit.term).toBe(title.slice(hit.start, hit.end))
  }
  expect(check('Cyberpunk Style Neon City Poster').verdict).toBe('低优先级')
  expect(check('Cyber Punk 2077 Key Ring').hits.some(h => h.families.includes('Cyberpunk'))).toBe(true)
  expect(check('Jaguar Wildlife Poster').verdict).toBe('通过')
  const custom = buildTitleAuditInspector([{ id: 1, name: 'Dark Knight', family: '运营词', aliases: '[]', reason: '运营要求核对' }])
  expect(custom('Dark Knight Dog Tag Key Ring')).toMatchObject({
    verdict: '重点提醒',
    hits: expect.arrayContaining([expect.objectContaining({ term: 'Dark Knight', reason: '运营要求核对' })]),
  })
})

it('uses the role of a standalone letter before assigning title risk, even for configured brands', () => {
  const check = buildTitleAuditInspector([])
  const withLetterBrands = buildTitleAuditInspector(['X', 'M', 'C'].map((name, id) => ({
    id, name, family: '测试品牌', aliases: '[]', reason: '运营重点词',
  })))

  for (const title of ['8 x 10 in Wall Art', 'Size M Cotton Hoodie', 'M Size Cotton Hoodie', 'USB-C Cable',
    'Model X Phone Mount', 'X-2026 Replacement Part', 'Initial X Monogram Keychain']) {
    expect(withLetterBrands(title).hits.some(hit => hit.verdict === '重点提醒'), title).toBe(false)
  }
  for (const title of ['Unisex X Logo T-Shirt', 'T-Shirt by X', 'Brand: X Cotton T-Shirt', 'X™ Graphic Tee']) {
    expect(check(title), title).toMatchObject({
      verdict: '重点提醒',
      hits: expect.arrayContaining([expect.objectContaining({ term: 'X', verdict: '重点提醒' })]),
    })
  }
  expect(check('A Cotton T-Shirt').verdict).toBe('低优先级')
  expect(check('Cotton Hoodie with a Logo').verdict).not.toBe('重点提醒')
  expect(check('X Logo T-Shirt').hits.filter(hit => hit.verdict === '重点提醒').map(hit => hit.term)).toEqual(['X'])
  expect(withLetterBrands('X Cotton T-Shirt').verdict).toBe('低优先级')
  expect(withLetterBrands('Official X T-Shirt, Size M').hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ term: 'X', verdict: '重点提醒' }),
    expect.objectContaining({ term: 'M', verdict: '通过' }),
  ]))
})
