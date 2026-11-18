import { z } from 'zod'
import { auditPage } from '../title-audit/listings'
import { type DispatchIdentity, dispatch } from '../operations/service-queue'
import { acquirePartnerOrders, acquireSlot, amazonRetrySeconds, observeLimit, observePartnerOrders, pacedOperation } from './request-pacing'
import { listingPage } from '../weekly-feedback/model'

type PublicQuote = { price: number | null; currency: string | null; shipping: number | null }

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
const catalogImageItem = z.object({
  asin: z.string(),
  images: z.array(z.object({
    marketplaceId: z.string(),
    images: z.array(z.object({ variant: z.string(), link: z.string(), height: z.number().optional() })),
  })).optional(),
})
function catalogMainImage(item: z.infer<typeof catalogImageItem>) {
  return item.images?.find((group) => group.marketplaceId === market)?.images
    .filter((entry) => entry.variant === 'MAIN')
    .sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity))[0]?.link ?? null
}
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
    private readonly caller: DispatchIdentity = { owner: 'interactive' },
  ) {}
  private async json(url: URL | string, init: RequestInit = {}, imageStage?: string): Promise<unknown> {
    const partner = this.caller.owner.startsWith('partner:')
    const ordersRead = new URL(url).pathname === '/orders/2026-01-01/orders'
    const operation = pacedOperation(url, partner)
    if (operation && this.pacingDB) await acquireSlot(this.pacingDB, operation, partner ? 2000 : undefined)
    if (operation && this.pacingDB && this.caller.attempt !== undefined) {
      const active = await this.pacingDB
        .prepare("SELECT 1 FROM job_runs WHERE id=? AND attempt=? AND status='running'")
        .bind(this.caller.runId!, this.caller.attempt)
        .first()
      if (!active) throw new PublicError('CONFLICT', '任务已暂停或取消。', 409)
    }
    let response: Response
    if (this.caller.shouldContinue && !(await this.caller.shouldContinue()))
      throw new PublicError('CONFLICT', '任务授权已变化，未发送请求。', 409)
    if (ordersRead && this.pacingDB)
      await acquirePartnerOrders(this.pacingDB, this.caller.owner.startsWith('performance:'))
    await this.caller.beforeSend?.()
    try {
      response = await this.send(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      })
    } catch {
      throw new PublicError('SOURCE_UNAVAILABLE', 'Amazon 请求超时或连接失败。', 503, 'amazon', true)
    }
    if (operation && this.pacingDB)
      await observeLimit(this.pacingDB, operation, response.headers, response.status === 429)
    if (ordersRead && this.pacingDB) await observePartnerOrders(this.pacingDB, response)
    if ((partner || ordersRead) && response.status === 429)
      throw new PublicError('SOURCE_THROTTLED','Amazon 配额暂时忙，请稍后重试。',429,'amazon',true,amazonRetrySeconds(response.headers,60))
    if (!response.ok) {
      const error = sourceError(response.status)
      if (imageStage) {
        const requestId = response.headers.get('x-amzn-requestid')
        const trace = requestId && /^[a-z0-9-]{1,80}$/i.test(requestId) ? `，请求 ID ${requestId}` : ''
        error.message += `（${imageStage}，HTTP ${response.status}${trace}）`
      }
      throw error
    }
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
  private async get(path: string, params: Record<string, string>, imageStage?: string) {
    const url = new URL(path, origin)
    url.search = new URLSearchParams(params).toString()
    const body = await this.json(url, {
      headers: {
        'x-amz-access-token': await this.authorize(),
        'user-agent': 'SelectionWorkbench/0.1 (Language=TypeScript)',
        accept: 'application/json',
      },
    }, imageStage)
    return redactJson(body, [
      this.secrets.SP_CLIENT_ID,
      this.secrets.SP_CLIENT_SECRET,
      this.secrets.SP_REFRESH_TOKEN,
      this.token,
    ])
  }

  async submitDataKioskQuery(query: string, paginationToken?: string) {
    const result = await this.json(new URL('/dataKiosk/2023-11-15/queries', origin), {
      method: 'POST',
      headers: {
        'x-amz-access-token': await this.authorize(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, paginationToken }),
    })
    return z.object({ queryId: z.string().min(1) }).parse(result).queryId
  }

  async dataKioskQueryStatus(id: string) {
    const result = await this.get('/dataKiosk/2023-11-15/queries/' + encodeURIComponent(id), {})
    return z.object({
      processingStatus: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FATAL']),
      dataDocumentId: z.string().optional(),
      errorDocumentId: z.string().optional(),
      pagination: z.object({ nextToken: z.string().optional() }).optional(),
    }).parse(result)
  }

  async dataKioskDocument(id: string) {
    const result = await this.get('/dataKiosk/2023-11-15/documents/' + encodeURIComponent(id), {})
    const { documentUrl } = z.object({ documentUrl: z.url({ protocol: /^https$/ }) }).parse(result)
    const response = await this.send(documentUrl, { redirect: 'manual', signal: AbortSignal.timeout(60000) })
    if (!response.ok || !response.body) throw sourceError(response.status)
    return response.body
  }
  async partnerSales(start: string, end: string, sku?: string) {
    const raw = await this.get('/sales/v1/orderMetrics', {
      marketplaceIds: market,
      amazonProgram: 'AmazonHaul',
      interval: start + '--' + end,
      granularity: 'Total',
      ...(sku ? { sku } : {}),
    })
    const result = z.object({ payload: z.array(z.object({
      interval: z.string(),
      unitCount: z.number().int().nonnegative(),
      orderItemCount: z.number().int().nonnegative(),
      totalSales: z.object({
        amount: z.union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()]).transform(String),
        currencyCode: z.literal('USD'),
      }),
    })).min(1).max(1) }).safeParse(raw)
    if (!result.success) throw invalid()
    return result.data.payload[0]
  }

  async partnerOrders(since: string, until: string, token?: string) {
    return this.get('/orders/2026-01-01/orders', {
      marketplaceIds: market,
      lastUpdatedAfter: since,
      lastUpdatedBefore: until,
      maxResultsPerPage: '40',
      includedData: 'PROCEEDS,FULFILLMENT,CANCELLATION',
      ...(token ? { paginationToken: token } : {}),
    })
  }

  async performanceOrders(from: string, through: string, basis: 'created' | 'updated', token?: string) {
    return this.get('/orders/2026-01-01/orders', {
      marketplaceIds: market,
      ...(basis === 'created' ? { createdAfter: from, createdBefore: through }
        : { lastUpdatedAfter: from, lastUpdatedBefore: through }),
      maxResultsPerPage: '100',
      includedData: 'PROCEEDS,FULFILLMENT,CANCELLATION',
      ...(token ? { paginationToken: token } : {}),
    })
  }

  async partnerListings(seller: string, since: string, until: string, token?: string) {
    const raw = await this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), {
      marketplaceIds: market, includedData: 'summaries,relationships,attributes,offers',
      lastUpdatedAfter: since, lastUpdatedBefore: until, sortBy: 'sku', sortOrder: 'ASC',
      pageSize: '20', ...(token ? { pageToken: token } : {}),
    })
    const base = listingPage.shape.items.element
    const result = listingPage.extend({items: z.array(base.extend({
      summaries: z.array(base.shape.summaries.unwrap().element.extend({
        createdDate: z.string().nullish(), lastUpdatedDate: z.string().nullish(),
      })).optional(),
    }))}).parse(raw)
    return {
      items: result.items.map((item) => ({ ...item, kind: variationRole(item) })),
      nextToken: result.pagination?.nextToken,
      numberOfResults: result.numberOfResults,
    }
  }

  async partnerListing(seller: string, sku: string, includedData: 'summaries,issues' | 'summaries,attributes,fulfillmentAvailability,offers') {
    return this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller) + '/' + encodeURIComponent(sku), {
      marketplaceIds: market, includedData,
    })
  }

  async partnerPatch(seller: string, sku: string, body: unknown, preview: boolean, beforeMutation?: () => void) {
    const url = new URL('/listings/2021-08-01/items/' + encodeURIComponent(seller) + '/' + encodeURIComponent(sku), origin)
    url.searchParams.set('marketplaceIds', market)
    if (preview) url.searchParams.set('mode', 'VALIDATION_PREVIEW')
    const token = await this.authorize()
    if (this.pacingDB) await acquireSlot(this.pacingDB, 'listing-write', 2000)
    if (this.caller.shouldContinue && !(await this.caller.shouldContinue()))
      throw new PublicError('CONFLICT', '写入授权已经变化。', 409)
    beforeMutation?.()
    const response = await this.send(url, {
      method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'x-amz-access-token': token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (this.pacingDB) await observeLimit(this.pacingDB, 'listing-write', response.headers, response.status === 429)
    if (!response.ok) {
      if ([400, 401, 403, 404, 409, 415, 422, 429].includes(response.status))
        return { accepted: false, reference: null, outcome: 'AMAZON_HTTP_' + response.status }
      throw sourceError(response.status)
    }
    const result = z.object({
      sku: z.literal(sku), submissionId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).optional(),
      status: z.enum(['ACCEPTED','VALID','INVALID']),
      issues: z.array(z.object({ severity: z.string() })).optional(),
    }).parse(await response.json())
    return {
      accepted: preview ? result.status === 'VALID' && !result.issues?.some((issue) => issue.severity === 'ERROR')
        : result.status === 'ACCEPTED',
      reference: result.submissionId ?? null,
      outcome: result.status,
    }
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

  async haulSalesPage(start: string, end: string, pageToken?: string) {
    const raw = await this.get('/orders/2026-01-01/orders', {
      marketplaceIds: market,
      createdAfter: start,
      createdBefore: end,
      maxResultsPerPage: '100',
      ...(pageToken ? { paginationToken: pageToken } : {}),
    })
    const page = z.object({
      orders: z.array(z.object({
        createdTime: z.iso.datetime({ offset: true }),
        programs: z.array(z.string()).optional(),
        salesChannel: z.object({ marketplaceId: z.string() }),
        orderId: z.unknown(),
        orderItems: z.unknown(),
      })),
      pagination: z.object({ nextToken: z.string().min(1).optional() }).optional(),
    }).safeParse(raw)
    if (!page.success || page.data.orders.some((order) => order.salesChannel.marketplaceId !== market))
      throw invalid()
    const from = Date.parse(start), to = Date.parse(end)
    const orders = page.data.orders
      .filter((order) => {
        const time = Date.parse(order.createdTime)
        return time >= from && time < to && order.programs?.includes('AMAZON_HAUL')
      })
      .map((order) => {
        const parsed = z.object({
          orderId: z.string().min(1),
          orderItems: z.array(z.object({
            orderItemId: z.string().min(1),
            quantityOrdered: z.number().int().nonnegative(),
            product: z.object({ sellerSku: z.string().nullish() }).nullish(),
          })),
        }).safeParse(order)
        if (!parsed.success) throw invalid()
        return {
          id: parsed.data.orderId,
          createdTime: order.createdTime,
          items: parsed.data.orderItems.map((item) => ({
            id: item.orderItemId, sku: item.product?.sellerSku?.trim() || null, units: item.quantityOrdered,
          })),
        }
      })
    return { orders, nextToken: page.data.pagination?.nextToken ?? null }
  }

  async auditListings(sellerId: string, start: number, end: number, pageToken?: string, includeHaulSignals = false) {
    const raw = await this.get('/listings/2021-08-01/items/' + encodeURIComponent(sellerId), {
      marketplaceIds: market, includedData: includeHaulSignals ? 'summaries,issues,attributes,offers' : 'summaries,issues', pageSize: '20',
      createdAfter: new Date(start).toISOString(), createdBefore: new Date(end).toISOString(),
      sortBy: 'sku', sortOrder: 'ASC', ...(pageToken ? { pageToken } : {}),
    })
    return auditPage.parse(raw)
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

  async recentlyUpdatedListings(seller: string, start: number, end: number, pageToken?: string, severity?: 'ERROR' | 'WARNING') {
    const raw = await this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), {
      marketplaceIds: market, includedData: 'summaries,issues', issueLocale: 'en_US', pageSize: '20',
      lastUpdatedAfter: new Date(start).toISOString(), lastUpdatedBefore: new Date(end).toISOString(),
      sortBy: 'sku', sortOrder: 'ASC', ...(pageToken ? { pageToken } : {}),
      ...(severity ? { withIssueSeverity: severity } : {}),
    })
    return auditPage.parse(raw)
  }

  async listingTitleBySku(seller: string, sku: string) {
    const raw = await this.get(
      '/listings/2021-08-01/items/' + encodeURIComponent(seller) + '/' + encodeURIComponent(sku),
      { marketplaceIds: market, includedData: 'summaries,attributes' },
    )
    const item = z.object({
      sku: z.string(),
      summaries: auditPage.shape.items.element.shape.summaries,
      attributes: z.object({
        item_name: z.array(z.object({
          marketplace_id: z.string().optional(),
          value: z.string(),
        })).optional(),
      }).optional(),
    }).parse(raw)
    if (item.sku !== sku) return null
    const summary = item.summaries?.find((row) => row.marketplaceId === market)
    const names = item.attributes?.item_name
    const title = summary?.itemName?.trim() ||
      names?.find((row) => row.marketplace_id === market && row.value.trim())?.value.trim() ||
      names?.find((row) => !row.marketplace_id && row.value.trim())?.value.trim() ||
      null
    return { asin: summary?.asin ?? null, title }
  }

  async feedbackListings(seller: string, start: number, end: number, pageToken?: string) {
    const raw = await this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), {
      marketplaceIds: market, includedData: 'summaries,relationships', pageSize: '20',
      createdAfter: new Date(start).toISOString(), createdBefore: new Date(end).toISOString(),
      sortBy: 'sku', sortOrder: 'ASC', ...(pageToken ? { pageToken } : {}),
    })
    return listingPage.parse(raw)
  }
  async feedbackListingsBySku(seller: string, skus: string[]) {
    const path = '/listings/2021-08-01/items/' + encodeURIComponent(seller)
    const options = { marketplaceIds: market, includedData: 'summaries,relationships,attributes' }
    const batch = skus.filter((sku) => !sku.includes(','))
    const rawItems = batch.length
      ? z.object({ items: z.array(z.unknown()) }).parse(
          await this.get(path, { ...options, identifiersType: 'SKU', identifiers: batch.join(','), pageSize: '20' }),
        ).items
      : []
    for (const sku of skus) {
      if (!sku.includes(',')) continue
      rawItems.push(await this.get(path + '/' + encodeURIComponent(sku), options))
    }
    return { items: rawItems.flatMap((raw) => {
      const item = listingPage.shape.items.element.safeParse(raw)
      return item.success ? [item.data] : []
    }) }
  }
  async feedbackListingsByAsin(seller: string, asins: string[], pageToken?: string) {
    const raw = await this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), {
      marketplaceIds: market, includedData: 'summaries,relationships,attributes,offers', identifiersType: 'ASIN',
      identifiers: asins.join(','), pageSize: '20', ...(pageToken ? { pageToken } : {}),
    })
    return listingPage.parse(raw)
  }
  async reviewTopics(asin: string, sortBy: 'MENTIONS' | 'STAR_RATING_IMPACT' = 'MENTIONS') {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new PublicError('INVALID_INPUT', '子 ASIN 格式无效。', 400)
    const url = new URL('/customerFeedback/2024-06-01/items/' + asin + '/reviews/topics', origin)
    url.search = new URLSearchParams({ marketplaceId: market, sortBy }).toString()
    const token = await this.authorize()
    if (this.caller.shouldContinue && !(await this.caller.shouldContinue()))
      throw new PublicError('CONFLICT', '任务授权已变化，未发送请求。', 409)
    await this.caller.beforeSend?.()
    if (this.pacingDB) await acquireSlot(this.pacingDB, 'feedback', this.caller.owner.startsWith('partner:') ? 2000 : undefined)
    const response = await this.send(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: { 'x-amz-access-token': token, 'user-agent': 'SelectionWorkbench/0.1' },
    })
    if (this.pacingDB) await observeLimit(this.pacingDB, 'feedback', response.headers, response.status === 429)
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
                asinMetrics: z.object({ numberOfMentions: z.number().nullish(), occurrencePercentage: z.number().nullish(), starRatingImpact: z.number().nullish() }).nullish(),
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
        ...(item.asinMetrics?.occurrencePercentage != null ? { occurrence: item.asinMetrics.occurrencePercentage } : {}),
        ...(item.asinMetrics?.starRatingImpact != null ? { impact: item.asinMetrics.starRatingImpact } : {}),
      })),
    }
  }
  async test() {
    const check = () => this.searchCatalog('desk organizer', 1)
    if (this.pacingDB) await dispatch(this.pacingDB, 'catalog', this.caller, check)
    else await check()
  }
  async search(query: string, pageSize = 6, pageToken?: string) {
    const read = () => this.searchCatalog(query, pageSize, pageToken)
    const db = this.pacingDB
    if (!db) return read()
    return dispatch(db, 'catalog', this.caller, async () => {
      const key = JSON.stringify([market, query, pageSize, pageToken ?? null])
      const cached = await db
        .prepare(
          'SELECT result FROM public_amazon_searches WHERE query_key=? AND checked_at>unixepoch()-300',
        )
        .bind(key)
        .first<{ result: string }>()
      if (cached) return JSON.parse(cached.result) as Awaited<ReturnType<typeof read>>
      const result = await read()
      await db
        .prepare(`INSERT INTO public_amazon_searches VALUES(?,?,unixepoch()) ON CONFLICT(query_key)
        DO UPDATE SET result=excluded.result,checked_at=excluded.checked_at`)
        .bind(key, JSON.stringify(result))
        .run()
      return result
    })
  }
  async mainImages(asins: string[]) {
    const raw = await this.get('/catalog/2022-04-01/items', {
      identifiers: asins.join(','), identifiersType: 'ASIN', marketplaceIds: market,
      pageSize: String(asins.length), includedData: 'images',
    })
    const data = z.object({ items: z.array(catalogImageItem) }).parse(raw)
    return data.items.flatMap((item) => {
      const url = catalogMainImage(item)
      return url && asins.includes(item.asin) ? [{ asin: item.asin, url }] : []
    })
  }
  async mainImageByAsin(asin: string) {
    const raw = await this.get('/catalog/2022-04-01/items/' + encodeURIComponent(asin), {
      marketplaceIds: market, includedData: 'images',
    })
    const item = catalogImageItem.parse(raw)
    return item.asin === asin ? catalogMainImage(item) : null
  }
  /** Exact seller SKU -> child ASIN -> largest MAIN. Existing thumbnail consumers stay unchanged. */
  async productMainImage(seller: string, sku: string) {
    const listing = z.object({ sku: z.string(), summaries: z.array(z.object({
      marketplaceId: z.string(), asin: z.string().regex(/^[A-Z0-9]{10}$/),
      mainImage: z.object({ link: z.string() }).optional(),
    })) }).parse(await this.get('/listings/2021-08-01/items/' + encodeURIComponent(seller) + '/' + encodeURIComponent(sku), {
      marketplaceIds: market, includedData: 'summaries',
    }, 'SKU 刊登'))
    if (listing.sku !== sku) throw invalid()
    const summary = listing.summaries.find(s => s.marketplaceId === market)
    if (!summary) throw invalid()
    const item = catalogImageItem.parse(await this.get('/catalog/2022-04-01/items/' + encodeURIComponent(summary.asin), {
      marketplaceIds: market, includedData: 'images',
    }, '商品目录图片'))
    if (item.asin !== summary.asin) throw invalid()
    const url = item.images?.find(g => g.marketplaceId === market)?.images
      .filter(i => i.variant === 'MAIN').sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]?.link ?? summary.mainImage?.link
    if (!url) throw new PublicError('PRODUCT_IMAGE_MISSING', '亚马逊暂未提供该 SKU 的主图。', 404)
    return { asin: summary.asin, url }
  }
  private async searchCatalog(query: string, pageSize: number, pageToken?: string) {
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
    if (!asins.length) return new Map<string, PublicQuote>()
    if (asins.length > 20 || asins.some((id) => !/^[A-Z0-9]{10}$/.test(id))) throw invalid()
    return this.sharedOffers(asins, (ids) => this.fetchBatch(ids))
  }
  // All callers use the US marketplace, New condition, Consumer and USD.
  private async sharedOffers(
    asins: string[],
    fetchMissing: (ids: string[]) => Promise<Map<string, PublicQuote>>,
  ) {
    const db = this.pacingDB
    if (!db) return fetchMissing(asins)
    return dispatch(db, 'pricing', this.caller, async () => {
      const cached = await db
        .prepare(`SELECT asin,quote FROM public_amazon_offers WHERE asin IN
        (SELECT value FROM json_each(?)) AND checked_at>unixepoch()-300`)
        .bind(JSON.stringify(asins))
        .all<{ asin: string; quote: string }>()
      const values = new Map(cached.results.map((r) => [r.asin, JSON.parse(r.quote) as PublicQuote]))
      const missing = [...new Set(asins)].filter((id) => !values.has(id))
      if (missing.length) {
        const fresh = await fetchMissing(missing)
        const writes = []
        for (const [asin, quote] of fresh) {
          values.set(asin, quote)
          if (quote.price !== null)
            writes.push(
              db
                .prepare(`INSERT INTO public_amazon_offers VALUES(?,?,unixepoch())
            ON CONFLICT(asin) DO UPDATE SET quote=excluded.quote,checked_at=excluded.checked_at`)
                .bind(asin, JSON.stringify(quote)),
            )
        }
        if (writes.length) await db.batch(writes)
      }
      return values
    })
  }
  private async fetchBatch(asins: string[]) {
    const raw = await this.json(origin + '/batches/products/pricing/v0/itemOffers', {
      method: 'POST',
      headers: { 'x-amz-access-token': await this.authorize(), 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: asins.map((id) => ({
          uri: '/products/pricing/v0/items/' + id + '/offers',
          method: 'GET',
          MarketplaceId: market,
          ItemCondition: 'New',
          CustomerType: 'Consumer',
        })),
      }),
    })
    const batch = z
      .object({
        responses: z.array(
          z.object({
            status: z.object({ statusCode: z.number() }),
            body: z.unknown(),
          }),
        ),
      })
      .parse(raw)
    const result = new Map<string, ReturnType<AmazonUS['parseOffer']>>()
    for (const row of batch.responses) {
      if (row.status.statusCode === 429) {
        if (this.pacingDB) await observeLimit(this.pacingDB, 'batch', new Headers(), true)
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
    const result = await this.sharedOffers(
      [asin],
      async () => new Map([[asin, await this.fetchOffer(asin)]]),
    )
    return result.get(asin)!
  }
  private async fetchOffer(asin: string) {
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
