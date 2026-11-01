import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { compareAmazonProduct } from '../../packages/amazon/auto-compare'
import { acquireSlot, observeLimit } from '../../packages/amazon/request-pacing'
import { dispatch } from '../../packages/operations/service-queue'
import { AmazonUS } from '../../packages/amazon/adapter'
import { comparisonTerms, qualify } from '../../packages/amazon/comparison-terms'
import type { ConnectionBindings } from '../../packages/connections/credentials'

const product = {
  id: 'temu:US:9',
  title: '1.69盎司量匙，2件装狗粮勺，适用于化妆品粉末的实验室塑料勺',
  title_en:
    '1.69oz Measuring Spoon, 2pcs Dog Food Scoop, Laboratory Plastic Spoons Suitable for Cosmetic Powder Kitchen',
  min_price: 1.29,
  currency: 'USD',
  total_sold: 300,
}
const variants = [{ skuId: '99', specs: [{ key: '包装', value: '2pcs' }] }]
let sql: DatabaseSync, env: ConnectionBindings
beforeEach(() => {
  sql = new DatabaseSync(':memory:')
  for (const name of [
    '0001_catalog',
    '0003_access_amazon',
    '0004_review_consistency',
    '0009_connection_credentials',
    '0019_amazon_auto_comparisons',
    '0021_amazon_request_pacing',
    '0022_service_queue',
  ])
    sql.exec(readFileSync('migrations/' + name + '.sql', 'utf8'))
  sql
    .prepare("INSERT INTO products(id,external_id,platform,market,title) VALUES (?,'9','temu','US',?)")
    .run(product.id, product.title)
  function prepare(query: string, values: SQLInputValue[] = []) {
    const statement = sql.prepare(query)
    return {
      bind: (...args: SQLInputValue[]) => prepare(query, args),
      first: () => statement.get(...values) ?? null,
      all: () => ({ results: statement.all(...values) }),
      run: () => ({ meta: statement.run(...values) }),
    }
  }
  env = {
    DB: {
      prepare,
      batch: (batch: ReturnType<typeof prepare>[]) => {
        sql.exec('BEGIN')
        try {
          const rows = batch.map((s) => s.all())
          sql.exec('COMMIT')
          return rows
        } catch (e) {
          sql.exec('ROLLBACK')
          throw e
        }
      },
    } as unknown as D1Database,
    SP_CLIENT_ID: 'fixture-id',
    SP_CLIENT_SECRET: 'fixture-secret',
    SP_REFRESH_TOKEN: 'fixture-refresh',
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  sql.close()
})
it('paces simultaneous callers per operation and shares stricter Amazon limits',async()=>{
  const sent=await Promise.all([1,2,3].map(async()=>{await acquireSlot(env.DB,'catalog');return Date.now()}))
  sent.sort((a,b)=>a-b)
  expect(sent[1]-sent[0]).toBeGreaterThanOrEqual(600)
  expect(sent[2]-sent[1]).toBeGreaterThanOrEqual(600)
  await acquireSlot(env.DB,'batch')
  await observeLimit(env.DB,'batch',new Headers({'x-amzn-RateLimit-Limit':'0.05','retry-after':'60'}),true)
  const pace=sql.prepare("SELECT interval_ms,next_at,slow_until FROM amazon_request_pacing WHERE operation='batch'").get()!
  expect(pace.interval_ms).toBe(25000)
  expect(Number(pace.next_at)-Date.now()).toBeGreaterThan(59000)
  expect(Number(pace.slow_until)-Date.now()).toBeGreaterThan(590000)
})
it('rotates owners before additional queued tasks from the last owner',async()=>{
  const order:string[]=[]
  let release!:()=>void, ready!:()=>void
  const started=new Promise<void>(r=>ready=r),hold=new Promise<void>(r=>release=r)
  const first=dispatch(env.DB,'pricing',{owner:'A'},async()=>{order.push('A1');ready();await hold})
  await started
  const enqueue=(owner:string,label:string)=>dispatch(env.DB,'pricing',{owner},async()=>{order.push(label)})
  const work=[enqueue('A','A2'),enqueue('A','A3'),enqueue('B','B1')]
  await dispatch(env.DB,'catalog',{owner:'B'},async()=>{order.push('catalog')})
  release()
  await Promise.all([first,...work])
  expect(order).toEqual(['A1','catalog','B1','A2','A3'])
},10000)
it('uses one upstream offer for overlapping operator requests',async()=>{
  const send=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('auth/o2')?
    Response.json({access_token:'fixture'}):Response.json({payload:{Offers:[{ListingPrice:{Amount:4.5,CurrencyCode:'USD'}}]}}))
  const results=await Promise.all(['A','B'].map(owner=>new AmazonUS(env,send,env.DB,{owner}).offer('B000000001')))
  expect(results.map(x=>x.price)).toEqual([4.5,4.5])
  expect(send.mock.calls.filter(([url])=>String(url).endsWith('Consumer')).length).toBe(1)
  expect(sql.prepare('SELECT count(*) n FROM service_tickets').get()?.n).toBe(0)
})
function item(n: number, title: string, pack: number) {
  const marketplaceId = 'ATVPDKIKX0DER'
  return {
    asin: 'B' + String(n).padStart(9, '0'),
    summaries: [{ marketplaceId, itemName: title, packageQuantity: pack }],
    salesRanks: [{ marketplaceId, classificationRanks: [{ rank: 150, title: 'Measuring Utensils' }] }],
  }
}
function mockMarket(items: ReturnType<typeof item>[], priced = true) {
  const send = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.includes('/auth/')) return Response.json({ access_token: 'fixture-token' })
    if (url.pathname.includes('/catalog/')) return Response.json({ items })
    if (url.pathname.includes('/pricing/'))
      return Response.json({
        payload: {
          Offers: priced
            ? [
                {
                  ListingPrice: { Amount: 4.25, CurrencyCode: 'USD' },
                  Shipping: { Amount: 0, CurrencyCode: 'USD' },
                },
              ]
            : [],
        },
      })
    throw Error('unexpected request')
  })
  vi.stubGlobal('fetch', send)
  return send
}
it('compares a pinned Chinese listing against actual US catalog & offers, preserves human decisions, and replays the same snapshot', async () => {
  const original = crypto.randomUUID()
  sql
    .prepare("INSERT INTO amazon_searches VALUES(?,?,?,'2026-01-01',2,0,'tester')")
    .run(original, product.id, 'measuring spoon')
  for (const [n, status] of [
    [2, 'confirmed'],
    [3, 'rejected'],
  ] as const) {
    const { asin } = item(n, '', 0)
    sql
      .prepare('INSERT INTO amazon_catalog_evidence VALUES(?,?,?)')
      .run(original, asin, JSON.stringify({ asin, title: 'Old title', specs: 'old specs' }))
    sql
      .prepare("INSERT INTO amazon_matches VALUES(?,?,?,?,'人工证据','2026-01-01','human')")
      .run(product.id, asin, original, status)
  }
  const send = mockMarket([
    item(1, 'Plastic Kitchen Measuring Spoons, 6-Piece Set for Baking', 1),
    item(2, 'Plastic Dog Food Scoops, 1.69 oz, Pack of 2', 1),
    item(3, 'Dog Food Scoop, 2 Pieces', 1),
    item(4, 'Plastic Pet Kibble Scoop, set of 2', 1),
    item(5, 'Plastic Measuring Cup for Dog Food, set of 5', 1),
    item(6, 'Multicolor Plastic Measuring Spoons, Set of 5', 1),
  ])
  const result = await compareAmazonProduct(env, 'job1', product, variants)
  expect(result).toMatchObject({
    sourceTitle: product.title,
    sourcePrice: 1.29,
    sourceSold: 300,
    sourceSpecs: expect.stringContaining('1.69 oz'),
    status: 'found',
    query: 'plastic dog food scoop 1.69 oz',
    candidates: [
      {
        asin: 'B000000002',
        price: 4.25,
        shipping: 0,
        priceStatus: 'available',
        basis: expect.stringContaining('1.69 oz'),
        rank: 150,
        rankCategory: 'Measuring Utensils',
      },
      { asin: 'B000000004', price: 4.25, priceStatus: 'available' },
      {
        asin: 'B000000005',
        price: null,
        priceStatus: 'not_checked',
        basis: expect.stringContaining('包装数量不同'),
      },
    ],
  })
  expect(send).toHaveBeenCalledTimes(4) // one LWA token, one catalog page, two offer reads
  const search = sql
    .prepare("SELECT id FROM amazon_searches WHERE actor='system:amazon-comparison'")
    .get()!
  expect(z.uuid().safeParse(search.id).success).toBe(true)
  const reviews = sql
    .prepare("SELECT latest_search,status,note FROM amazon_matches WHERE reviewer='human' ORDER BY asin")
    .all()
  expect(reviews).toEqual([
    { latest_search: original, status: 'confirmed', note: '人工证据' },
    { latest_search: original, status: 'rejected', note: '人工证据' },
  ])
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM amazon_catalog_evidence WHERE search_id=?').get(search.id),
  ).toEqual({ n: 6 })
  expect(
    await compareAmazonProduct(env, 'job1', { ...product, min_price: 17 }, [], 'another query'),
  ).toEqual(result)
  expect(send).toHaveBeenCalledTimes(4)
})
it('distinguishes zero qualifying hits, missing offers, and untranslated names without inventing comparisons', async () => {
  const send = mockMarket([item(1, 'Hooks for measuring spoons', 2)])
  expect(await compareAmazonProduct(env, 'not-comparable', product, variants)).toMatchObject({
    status: 'no_results',
    message: expect.stringContaining('没有可比较'),
    candidates: [],
  })
  expect(
    send.mock.calls.flatMap(([input]) => new URL(String(input)).searchParams.getAll('keywords')),
  ).toEqual(['plastic dog food scoop 1.69 oz', 'plastic dog food scoop'])
  const noEnglish = { ...product, title_en: undefined }
  sql.exec('UPDATE public_amazon_searches SET checked_at=0')
  mockMarket([item(2, '50ml Plastic Scoop for Dog Food', 1)], false)
  expect(await compareAmazonProduct(env, 'cn', noEnglish, [])).toMatchObject({
    query: 'plastic dog food scoop 1.69 oz',
    status: 'found',
    candidates: [{ price: null, shipping: null, priceStatus: 'unavailable' }],
  })
  const empty = mockMarket([])
  sql.exec('UPDATE public_amazon_searches SET checked_at=0')
  expect(
    await compareAmazonProduct(env, 'unknown', { ...noEnglish, title: '某未知商品' }, []),
  ).toMatchObject({ status: 'no_query', query: '' })
  expect(empty).not.toHaveBeenCalled()
  expect(await compareAmazonProduct(env, 'empty', product, [])).toMatchObject({
    status: 'no_results',
    message: expect.stringContaining('未返回'),
  })
})
it('reuses short-lived failure evidence and allows a later retry after configuration is fixed', async () => {
  const send = mockMarket([])
  const failed = await compareAmazonProduct(
    { ...env, SP_CLIENT_SECRET: undefined },
    'retry',
    product,
    [],
  )
  expect(failed).toMatchObject({
    status: 'unavailable',
    message: expect.stringContaining('凭据'),
    candidates: [],
  })
  expect(await compareAmazonProduct(env, 'retry', product, [])).toEqual(failed)
  expect(send).not.toHaveBeenCalled()
  sql.exec('UPDATE amazon_auto_comparisons SET lease_until=0')
  expect(await compareAmazonProduct(env, 'retry', product, [])).toMatchObject({ status: 'no_results' })
  expect(send).toHaveBeenCalledTimes(3)
  expect(sql.prepare('SELECT status FROM amazon_search_failures').all()).toEqual([
    { status: 'NOT_CONFIGURED' },
  ])
})
it('leases the upstream operation across concurrent callers before sending', async () => {
  let finish!: (r: Response) => void
  const send = mockMarket([])
  send.mockImplementationOnce(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  const first = compareAmazonProduct(env, 'concurrent', product, [])
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  await expect(compareAmazonProduct(env, 'concurrent', product, [])).rejects.toMatchObject({
    code: 'COMPARISON_BUSY',
  })
  expect(send).toHaveBeenCalledTimes(1)
  finish(Response.json({ access_token: 'valid' }))
  expect(await first).toMatchObject({ status: 'no_results' })
})
it('prioritizes a specific use across clauses, checks units explicitly, and distinguishes pieces from outer packages', () => {
  const terms = comparisonTerms(product, variants, 'plastic measuring spoon')
  expect(terms).toMatchObject({
    query: 'plastic dog food scoop 1.69 oz',
    fallbackQuery: 'plastic dog food scoop',
  })
  const check = (title: string, specs: string | null = null) => qualify({ title, specs }, terms)
  expect(check('Plastic Measuring Spoons for Cooking, 6-piece kitchen set')).toBeNull()
  expect(check('Plastic Cat Litter Scoop')).toBeNull()
  expect(check('Replacement handle for a dog food scoop')).toBeNull()
  expect(check('Plastic Pet Food Scoop', '50 mL — 6-Piece (Pack of 1)')?.basis).toMatch(
    /Amazon 6 件装.*规格需核实：来源 1.69 oz，Amazon 50 ml/,
  )
  expect(check('Dog Food Scoop, set of 5 (Pack of 1)')?.basis).toContain('Amazon 5 件装')
  expect(check('Dog Food Scoop, Pack of 2')?.basis).toContain('Amazon 2 件装')
  expect(check('Dog Food Scoop, 1/2 cup')?.basis).toContain('规格需核实')
  expect(check('Dog Food Scoop')?.basis).toContain('Amazon 件数待核')
})
it('compares other uses, original Chinese product names and unlabelled numbers without adding a capacity', () => {
  const terms = comparisonTerms({ title: 'Storage Rack, Bamboo Shoe Rack for the Entryway' }, [])
  expect(terms).toMatchObject({ query: 'bamboo shoe rack', fallbackQuery: '' })
  expect(qualify({ title: 'Bamboo Spice Rack for Kitchen', specs: null }, terms)).toBeNull()
  expect(qualify({ title: 'Bamboo Footwear Rack', specs: null }, terms)?.basis).toContain('用途：shoe')
  const brush = comparisonTerms({ title: '刷子，婴儿奶瓶刷 2件套' }, [])
  expect(brush.query).toBe('baby bottle brush')
  expect(qualify({ title: 'Bottle Brush for Baby Feeding Bottles', specs: null }, brush)).not.toBeNull()
  expect(qualify({ title: 'Plastic Hair Brush', specs: null }, brush)).toBeNull()
  expect(comparisonTerms({ title: 'Dog Food Scoop 50, Pack of 2' }, []).query).toBe('dog food scoop')
  expect(comparisonTerms({ title: '便携封口机' }, []).query).toBe('便携封口机')
})
