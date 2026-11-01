import { z } from 'zod'
import { acquireSlot, observeLimit, pacedOperation } from './request-pacing'
import { dispatch, type DispatchIdentity } from '../operations/service-queue'
type PublicQuote = {price:number|null;currency:string|null;shipping:number|null}
import { redactJson } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { skuIsJit } from '../store-sales/report'

export interface AmazonSecrets {
  SP_CLIENT_ID?: string
  SP_CLIENT_SECRET?: string
  SP_REFRESH_TOKEN?: string
}
const market = 'ATVPDKIKX0DER'
const origin = 'https://sellingpartnerapi-na.amazon.com'
const rank = z.object({ rank: z.number().int().positive(), title: z.string().optional() })
const catalogItem = z.object({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  summaries: z
    .array(
      z.object({
        marketplaceId: z.string(),
        itemName: z.string().optional(),
        brand: z.string().optional(),
        size: z.string().optional(),
        color: z.string().optional(),
        packageQuantity: z.number().optional(),
      }),
    )
    .optional(),
  salesRanks: z
    .array(
      z.object({
        marketplaceId: z.string(),
        displayGroupRanks: z.array(rank).optional(),
        classificationRanks: z.array(rank).optional(),
      }),
    )
    .optional(),
})
const catalogPage = z.object({
  items: z.array(catalogItem).max(20),
  pagination: z.object({ nextToken: z.string().optional() }).optional(),
})
const listingRelationship = z.object({
  type: z.string().nullish(),
  parentSkus: z.array(z.string()).nullish(),
  childSkus: z.array(z.string()).nullish(),
})
const listingSample = z.object({
  sku: z.string().nullish(),
  summaries: z
    .array(
      z.object({
        marketplaceId: z.string(),
        createdDate: z.string().nullish(),
      }),
    )
    .nullish(),
  relationships: z
    .array(
      z.object({
        marketplaceId: z.string(),
        relationships: z.array(listingRelationship).nullish(),
      }),
    )
    .nullish(),
})
function variationRole(item: z.infer<typeof listingSample>) {
  const groups = item.relationships?.filter((group) => group.marketplaceId === market)
  if (groups?.length !== 1 || !groups[0].relationships) return 'unknown'
  const relationships = groups[0].relationships
  if (relationships.length === 0) return 'standalone'
  const roles = new Set<'parent' | 'child'>()
  for (const relation of relationships) {
    if (relation.type === 'PACKAGE_HIERARCHY') continue
    if (relation.type !== 'VARIATION') return 'unknown'
    const hasParents = !!relation.parentSkus?.some((sku) => sku.trim())
    const hasChildren = !!relation.childSkus?.some((sku) => sku.trim())
    if (hasParents === hasChildren) return 'unknown'
    roles.add(hasParents ? 'child' : 'parent')
  }
  if (roles.size !== 1) return 'unknown'
  return roles.has('parent') ? 'parent' : 'child'
}
const money = z.object({ Amount: z.number().nonnegative(), CurrencyCode: z.string().length(3) })
const offerPage = z.object({
  payload: z.object({ Offers: z.array(z.object({ ListingPrice: money, Shipping: money.optional() })) }),
})
const invalid = () =>
  new PublicError('DATA_INCOMPLETE', 'Amazon 返回的数据缺少必要字段。', 502, 'amazon')
function sourceError(status: number) {
  if (status === 429)
    return new PublicError('SOURCE_RATE_LIMIT', 'Amazon 触发限流，请稍后再试。', 429, 'amazon', true)
  if (status === 401 || status === 403 || status === 400)
    return new PublicError('SOURCE_AUTH', '请核对 SP-API 授权、角色及请求范围。', 403, 'amazon')
  return new PublicError('SOURCE_UNAVAILABLE', 'Amazon 请求未完成。', 502, 'amazon', status >= 500)
}

export class AmazonUS {
  private token?: string
  constructor(
    private readonly secrets: AmazonSecrets,
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
    private readonly pacingDB?: D1Database,
    private readonly caller: DispatchIdentity = {owner:'interactive'},
  ) {}
  private async json(url: URL | string, init: RequestInit = {}): Promise<unknown> {
    const operation = pacedOperation(url)
    if (operation && this.pacingDB) await acquireSlot(this.pacingDB, operation)
    if(operation && this.pacingDB && this.caller.attempt!==undefined){
      const active=await this.pacingDB.prepare("SELECT 1 FROM job_runs WHERE id=? AND attempt=? AND status='running'")
        .bind(this.caller.runId!,this.caller.attempt).first()
      if(!active) throw new PublicError('CONFLICT','任务已暂停或取消。',409)
    }
    let response: Response
    try {
      response = await this.send(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      })
    } catch {
      throw new PublicError('SOURCE_UNAVAILABLE', 'Amazon 请求超时或连接失败。', 503, 'amazon', true)
    }
    if (operation && this.pacingDB) await observeLimit(this.pacingDB, operation, response.headers, response.status === 429)
    if (!response.ok) throw sourceError(response.status)
    return response.json().catch(() => {
      throw invalid()
    })
  }
  private async authorize() {
    if (this.token) return this.token
    const { SP_CLIENT_ID, SP_CLIENT_SECRET, SP_REFRESH_TOKEN } = this.secrets
    if (!SP_CLIENT_ID || !SP_CLIENT_SECRET || !SP_REFRESH_TOKEN)
      throw new PublicError('NOT_CONFIGURED', '请先绑定 Amazon SP-API 服务端凭据。', 409, 'amazon')
    const response = await this.json('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: SP_CLIENT_ID,
        client_secret: SP_CLIENT_SECRET,
        refresh_token: SP_REFRESH_TOKEN,
      }),
    })
    const parsed = z.object({ access_token: z.string().min(1) }).safeParse(response)
    if (!parsed.success) throw invalid()
    this.token = parsed.data.access_token
    return this.token
  }
  private async get(path: string, params: Record<string, string>) {
    const url = new URL(path, origin)
    url.search = new URLSearchParams(params).toString()
    const body = await this.json(url, {
      headers: {
        'x-amz-access-token': await this.authorize(),
        'user-agent': 'SelectionWorkbench/0.1 (Language=TypeScript)',
        accept: 'application/json',
      },
    })
    return redactJson(body, [
      this.secrets.SP_CLIENT_ID,
      this.secrets.SP_CLIENT_SECRET,
      this.secrets.SP_REFRESH_TOKEN,
      this.token,
    ])
  }
  async checkHaulOrderFields() {
    // Sample one page, without buyer, recipient or package data. Nothing is persisted.
    const end = Date.now() - 5 * 60_000
    const start = new Date(end - 7 * 86_400_000).toISOString()
    const through = new Date(end).toISOString()
    const body = await this.get('/orders/2026-01-01/orders', {
      marketplaceIds: market,
      createdAfter: start,
      createdBefore: through,
      maxResultsPerPage: '5',
      includedData: 'PROCEEDS',
    })
    const item = z.object({
      quantityOrdered: z.number().int().nonnegative().optional(),
      product: z.object({ sellerSku: z.string().optional() }).optional(),
      proceeds: z
        .object({
          breakdowns: z
            .array(
              z.object({
                type: z.string(),
                subtotal: z.object({ amount: z.string(), currencyCode: z.string() }).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    const page = z
      .object({
        orders: z
          .array(
            z.object({
              programs: z.array(z.string()).optional(),
              salesChannel: z.object({ marketplaceId: z.string() }),
              orderItems: z.array(item),
            }),
          )
          .max(5),
      })
      .safeParse(body)
    if (!page.success || page.data.orders.some((order) => order.salesChannel.marketplaceId !== market))
      throw invalid()
    const haul = page.data.orders.filter((order) => order.programs?.includes('AMAZON_HAUL'))
    const rows = haul.flatMap((order) => order.orderItems)
    const skus = rows.flatMap((row) => (row.product?.sellerSku?.trim() ? [row.product.sellerSku] : []))
    const jit = skus.filter(skuIsJit).length
    return {
      start,
      through,
      orders: page.data.orders.length,
      haulOrders: haul.length,
      haulRows: rows.length,
      jit,
      standard: skus.length - jit,
      missingSku: rows.length - skus.length,
      withQuantity: rows.filter((row) => row.quantityOrdered !== undefined).length,
      withItemAmount: rows.filter((row) =>
        row.proceeds?.breakdowns?.some(
          (part) =>
            part.type === 'ITEM' &&
            part.subtotal?.currencyCode === 'USD' &&
            /^\d+(\.\d+)?$/.test(part.subtotal.amount),
        ),
      ).length,
    }
  }

  async searchListingsItems(sellerId: string) {
    if (!/^[A-Z0-9]{5,64}$/.test(sellerId))
      throw new PublicError('INVALID_INPUT', '请填写卖家中心的 Seller ID（Merchant Token）。', 400)
    const raw = await this.get('/listings/2021-08-01/items/' + sellerId, {
      marketplaceIds: market,
      includedData: 'summaries,relationships',
      sortBy: 'createdDate',
      sortOrder: 'DESC',
      pageSize: '5',
    })
    const page = z.object({ items: z.array(listingSample).max(5) }).safeParse(raw)
    if (!page.success) throw invalid()
    const result = {
      sampled: page.data.items.length,
      withSku: 0,
      withCreatedDate: 0,
      parent: 0,
      child: 0,
      standalone: 0,
      unknown: 0,
    }
    const timestamp = z.iso.datetime({ offset: true })
    for (const item of page.data.items) {
      if (item.sku?.trim()) result.withSku++
      if (
        item.summaries?.some(
          (summary) =>
            summary.marketplaceId === market && timestamp.safeParse(summary.createdDate).success,
        )
      )
        result.withCreatedDate++
      result[variationRole(item)]++
    }
    return result
  }

  async reviewTopics(asin: string) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new PublicError('INVALID_INPUT', '子 ASIN 格式无效。', 400)
    const url = new URL('/customerFeedback/2024-06-01/items/' + asin + '/reviews/topics', origin)
    url.search = new URLSearchParams({ marketplaceId: market, sortBy: 'MENTIONS' }).toString()
    const response = await this.send(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: { 'x-amz-access-token': await this.authorize(), 'user-agent': 'SelectionWorkbench/0.1' },
    })
    if (response.status === 204) return { asin, topics: [], period: null }
    if (response.status === 403)
      throw new PublicError(
        'FEEDBACK_FORBIDDEN',
        'Amazon 拒绝了评论查询。请管理员核对 Selling Partner Insights 角色和店铺授权。',
        403,
      )
    if (response.status === 404)
      throw new PublicError('FEEDBACK_NOT_FOUND', 'Amazon 未找到该子 ASIN 的反馈记录。', 404)
    if (!response.ok) throw sourceError(response.status)
    const data = z
      .object({
        asin: z.literal(asin),
        marketplaceId: z.literal(market),
        dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
        topics: z.object({
          negativeTopics: z
            .array(
              z.object({
                topic: z.string(),
                asinMetrics: z.object({ numberOfMentions: z.number().nullish() }).nullish(),
                reviewSnippets: z.array(z.string()).nullish(),
              }),
            )
            .nullish(),
        }),
      })
      .safeParse(await response.json().catch(() => null))
    if (!data.success) throw invalid()
    return {
      asin,
      period: data.data.dateRange,
      topics: (data.data.topics.negativeTopics ?? []).map((item) => ({
        name: item.topic,
        mentions: item.asinMetrics?.numberOfMentions ?? null,
        snippets: item.reviewSnippets ?? [],
      })),
    }
  }
  async test() {
    const check=()=>this.searchCatalog('desk organizer',1)
    if(this.pacingDB) await dispatch(this.pacingDB,'catalog',this.caller,check)
    else await check()
  }
  async search(query: string, pageSize = 6, pageToken?: string) {
    const read=()=>this.searchCatalog(query,pageSize,pageToken)
    const db=this.pacingDB
    if(!db) return read()
    return dispatch(db,'catalog',this.caller,async()=>{
      const key=JSON.stringify([market,query,pageSize,pageToken??null])
      const cached=await db.prepare('SELECT result FROM public_amazon_searches WHERE query_key=? AND checked_at>unixepoch()-300')
        .bind(key).first<{result:string}>()
      if(cached) return JSON.parse(cached.result) as Awaited<ReturnType<typeof read>>
      const result=await read()
      await db.prepare(`INSERT INTO public_amazon_searches VALUES(?,?,unixepoch()) ON CONFLICT(query_key)
        DO UPDATE SET result=excluded.result,checked_at=excluded.checked_at`).bind(key,JSON.stringify(result)).run()
      return result
    })
  }
  private async searchCatalog(query:string,pageSize:number,pageToken?:string) {
    const identifier = /^[A-Z0-9]{10}$/.test(query)
    const params: Record<string, string> = identifier
      ? { identifiers: query, identifiersType: 'ASIN' }
      : { keywords: query }
    if (pageToken) params.pageToken = pageToken
    const raw = await this.get('/catalog/2022-04-01/items', {
      ...params,
      marketplaceIds: market,
      pageSize: String(pageSize),
      includedData: 'summaries,salesRanks',
    })
    const parsed = catalogPage.safeParse(raw)
    if (!parsed.success) throw invalid()
    const items = parsed.data.items.map((item) => {
      const summary = item.summaries?.find((s) => s.marketplaceId === market)
      const ranks = item.salesRanks?.find((r) => r.marketplaceId === market)
      const signal = ranks?.displayGroupRanks?.[0] ?? ranks?.classificationRanks?.[0]
      const specs = [summary?.brand, summary?.size, summary?.color].filter(Boolean).join(' · ')
      return {
        asin: item.asin,
        title: summary?.itemName ?? null,
        specs: specs || null,
        // Catalog packaging levels do not identify how many spoons, pieces, etc. are inside a set.
        packageQuantity: summary?.packageQuantity ?? null,
        rank: signal?.rank ?? null,
        rankCategory: signal?.title ?? null,
        price: null,
        currency: null,
        method: identifier ? 'asin' : 'keyword',
      }
    })
    return {
      items,
      hasMore: Boolean(parsed.data.pagination?.nextToken),
      nextToken: parsed.data.pagination?.nextToken ?? null,
    }
  }
  async batchOffers(asins: string[]) {
    if (!asins.length) return new Map<string,PublicQuote>()
    if (asins.length > 20 || asins.some(id => !/^[A-Z0-9]{10}$/.test(id))) throw invalid()
    return this.sharedOffers(asins,ids=>this.fetchBatch(ids))
  }
  // All callers use the US marketplace, New condition, Consumer and USD.
  private async sharedOffers(asins:string[],fetchMissing:(ids:string[])=>Promise<Map<string,PublicQuote>>) {
    const db=this.pacingDB
    if(!db) return fetchMissing(asins)
    return dispatch(db,'pricing',this.caller,async()=>{
      const cached=await db.prepare(`SELECT asin,quote FROM public_amazon_offers WHERE asin IN
        (SELECT value FROM json_each(?)) AND checked_at>unixepoch()-300`).bind(JSON.stringify(asins)).all<{asin:string;quote:string}>()
      const values=new Map(cached.results.map(r=>[r.asin,JSON.parse(r.quote) as PublicQuote]))
      const missing=[...new Set(asins)].filter(id=>!values.has(id))
      if(missing.length){
        const fresh=await fetchMissing(missing)
        const writes=[]
        for(const [asin,quote] of fresh){
          values.set(asin,quote)
          if(quote.price!==null) writes.push(db.prepare(`INSERT INTO public_amazon_offers VALUES(?,?,unixepoch())
            ON CONFLICT(asin) DO UPDATE SET quote=excluded.quote,checked_at=excluded.checked_at`).bind(asin,JSON.stringify(quote)))
        }
        if(writes.length) await db.batch(writes)
      }
      return values
    })
  }
  private async fetchBatch(asins:string[]) {
    const raw = await this.json(origin + '/batches/products/pricing/v0/itemOffers', {
      method: 'POST',
      headers: { 'x-amz-access-token': await this.authorize(), 'content-type': 'application/json' },
      body: JSON.stringify({ requests: asins.map(id => ({
        uri: '/products/pricing/v0/items/' + id + '/offers', method: 'GET',
        MarketplaceId: market, ItemCondition: 'New', CustomerType: 'Consumer',
      })) }),
    })
    const batch = z.object({ responses: z.array(z.object({
      status: z.object({ statusCode: z.number() }), body: z.unknown(),
    })) }).parse(raw)
    const result = new Map<string, ReturnType<AmazonUS['parseOffer']>>()
    for (const row of batch.responses) {
      if (row.status.statusCode === 429) {
        if (this.pacingDB) await observeLimit(this.pacingDB,'batch',new Headers(),true)
        throw sourceError(429)
      }
      if (row.status.statusCode !== 200) continue
      const id = z.object({ payload: z.object({ ASIN: z.string() }) }).parse(row.body).payload.ASIN
      result.set(id, this.parseOffer(row.body))
    }
    return result
  }
  async offer(asin: string) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new PublicError('INVALID_INPUT', 'ASIN 格式无效。', 400)
    const result=await this.sharedOffers([asin],async()=>new Map([[asin,await this.fetchOffer(asin)]]))
    return result.get(asin)!
  }
  private async fetchOffer(asin:string){
    const raw = await this.get('/products/pricing/v0/items/' + asin + '/offers', {
      MarketplaceId: market,
      ItemCondition: 'New',
      CustomerType: 'Consumer',
    })
    return this.parseOffer(raw)
  }
  private parseOffer(raw: unknown) {
    const parsed = offerPage.safeParse(raw)
    if (!parsed.success) throw invalid()
    const offers = parsed.data.payload.Offers.filter((o) => o.ListingPrice.CurrencyCode === 'USD').sort(
      (a, b) => a.ListingPrice.Amount - b.ListingPrice.Amount,
    )
    const best = offers[0]
    return {
      price: best?.ListingPrice.Amount ?? null,
      currency: best?.ListingPrice.CurrencyCode ?? null,
      shipping: best?.Shipping?.CurrencyCode === 'USD' ? best.Shipping.Amount : null,
    }
  }
}
