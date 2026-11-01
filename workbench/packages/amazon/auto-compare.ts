import { type ConnectionBindings, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { AmazonUS } from './adapter'
import { amazonComparisonVersion } from './comparison-policy'
import { comparisonTerms, qualify } from './comparison-terms'

export interface AmazonComparison {
  methodVersion?: number
  queries?: string[]
  productId: string
  sourceTitle: string
  sourcePrice: number | null
  sourceCurrency: string | null
  sourceSold: number | null
  sourceSpecs: string | null
  query: string
  checkedAt: string
  status: 'found' | 'no_results' | 'unavailable' | 'no_query'
  message: string
  candidates: {
    asin: string
    title: string | null
    specs: string | null
    rank: number | null
    rankCategory: string | null
    price: number | null
    shipping: number | null
    priceStatus: string
    basis: string
  }[]
}
type Catalog = Awaited<ReturnType<AmazonUS['search']>>
type Candidate = AmazonComparison['candidates'][number]
const numberOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const failureCode = (e: unknown) => (e instanceof PublicError ? e.code : 'SOURCE_UNAVAILABLE')
async function comparisonId(run: string, product: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['amazon-us/v1', run, product])),
    ),
  )
  // Stable lease key across matching-rule revisions.
  bytes[6] = (bytes[6] & 15) | 128
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join(
    '-',
  )
}
async function selectCandidates(
  db: D1Database,
  product: string,
  catalog: Catalog,
  terms: ReturnType<typeof comparisonTerms>,
) {
  if (!catalog.items.length) return []
  const rejected = await db
    .prepare(
      "SELECT asin FROM amazon_matches WHERE product_id=? AND status='rejected' AND asin IN (" +
        catalog.items.map(() => '?').join(',') +
        ')',
    )
    .bind(product, ...catalog.items.map((i) => i.asin))
    .all<{ asin: string }>()
  const excluded = new Set(rejected.results.map((r) => r.asin))
  return catalog.items
    .flatMap((item) => {
      if (excluded.has(item.asin)) return []
      const match = qualify(item, terms)
      return match ? [{ item, ...match }] : []
    })
    .sort((a, b) => b.score - a.score || a.item.asin.localeCompare(b.item.asin))
    .slice(0, 3)
}
async function offers(api: AmazonUS, selected: Awaited<ReturnType<typeof selectCandidates>>) {
  const candidates: Candidate[] = []
  let halted = false
  for (const { item, basis } of selected) {
    const { asin, title, specs, rank, rankCategory } = item
    const candidate: Candidate = {
      asin,
      title,
      specs,
      rank,
      rankCategory,
      basis,
      price: null,
      shipping: null,
      priceStatus: 'not_checked',
    }
    if (candidates.length < 2 && !halted) {
      try {
        const offer = await api.offer(item.asin)
        candidate.price = offer.price
        candidate.shipping = offer.shipping
        candidate.priceStatus = offer.price === null ? 'unavailable' : 'available'
      } catch (e) {
        candidate.priceStatus = failureCode(e)
        halted = ['SOURCE_RATE_LIMIT', 'SOURCE_AUTH', 'SOURCE_UNAVAILABLE'].includes(
          candidate.priceStatus,
        )
      }
    }
    candidates.push(candidate)
  }
  return candidates
}
function catalogEvidence(db: D1Database, id: string, result: AmazonComparison, catalog: Catalog) {
  const { productId, checkedAt, candidates } = result
  const statements = [
    db
      .prepare('INSERT INTO amazon_searches VALUES(?,?,?,?,?,?,?)')
      .bind(
        id,
        productId,
        result.query,
        checkedAt,
        catalog.items.length,
        Number(catalog.hasMore),
        'system:amazon-comparison',
      ),
    db.prepare('INSERT INTO amazon_pages VALUES(?,?,NULL)').bind(id, catalog.nextToken),
    ...catalog.items.map((item) =>
      db
        .prepare('INSERT INTO amazon_catalog_evidence VALUES(?,?,?)')
        .bind(id, item.asin, JSON.stringify(item)),
    ),
  ]
  for (const candidate of candidates) {
    // Changing latest_search can fire check_amazon_specs, which invalidates a human review.
    statements.push(
      db
        .prepare(`INSERT INTO amazon_matches(product_id,asin,latest_search) VALUES(?,?,?)
      ON CONFLICT(product_id,asin) DO UPDATE SET latest_search=excluded.latest_search
      WHERE amazon_matches.status='pending' AND amazon_matches.reviewer IS NULL AND amazon_matches.reviewed_at IS NULL`)
        .bind(productId, candidate.asin, id),
    )
    if (candidate.priceStatus !== 'not_checked')
      statements.push(
        db
          .prepare(`INSERT INTO amazon_prices(product_id,asin,price,currency,shipping,status,fetched_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM amazon_matches WHERE product_id=? AND asin=? AND latest_search=?)`)
          .bind(
            productId,
            candidate.asin,
            candidate.price,
            candidate.price === null ? null : 'USD',
            candidate.shipping,
            candidate.priceStatus,
            checkedAt,
            productId,
            candidate.asin,
            id,
          ),
      )
  }
  return statements
}
export async function compareAmazonProduct(
  env: ConnectionBindings,
  runId: string,
  product: Record<string, unknown>,
  variants: unknown[],
  proposedQuery?: string,
  caller?: import('../operations/service-queue').DispatchIdentity,
): Promise<AmazonComparison> {
  const db = env.DB,
    productId = String(product.id)
  const terms = comparisonTerms(product, variants, proposedQuery)
  const id = await comparisonId(runId, productId),
    token = crypto.randomUUID(),
    now = Date.now()
  const saved = () =>
    db
      .prepare('SELECT lease_token,result_json FROM amazon_auto_comparisons WHERE id=?')
      .bind(id)
      .first<{ lease_token: string; result_json: string | null }>()
  const busy = () =>
    new PublicError('COMPARISON_BUSY', '该商品正在比对，请稍后刷新。', 409, 'amazon', true)
  const lease = await db
    .prepare(`INSERT INTO amazon_auto_comparisons(id,run_id,product_id,lease_token,lease_until)
    VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
    WHERE lease_until<=? AND (result_json IS NULL OR COALESCE(json_extract(result_json,'$.methodVersion'),1)<?
      OR json_extract(result_json,'$.status')='unavailable'
      OR (json_extract(result_json,'$.status')='no_query' AND ?!='')) RETURNING id`)
    .bind(id, runId, productId, token, now + 120_000, now, amazonComparisonVersion, terms.query)
    .first()
  if (!lease) {
    const replay = await saved()
    if (replay?.result_json) return JSON.parse(replay.result_json) as AmazonComparison
    throw busy()
  }
  const { sourceTitle, sourceSpecs, query } = terms
  const result: AmazonComparison = {
    methodVersion: amazonComparisonVersion,
    productId,
    sourceTitle,
    sourceSpecs,
    query,
    sourcePrice: numberOrNull(product.min_price),
    sourceCurrency: typeof product.currency === 'string' ? product.currency : null,
    sourceSold: numberOrNull(product.total_sold),
    checkedAt: new Date(now).toISOString(),
    status: 'no_query',
    message: '来源证据不足，无法提取可用于美国站的具体商品词；未发起检索。',
    candidates: [],
  }
  let failed: string | undefined
  const evidence: D1PreparedStatement[] = []
  if (query) {
    try {
      const { credentials } = await providerCredentials(env, 'amazon')
      const api = new AmazonUS(credentials, undefined, env.DB,caller)
      const queries = [...new Set([query, terms.fallbackQuery].filter((v): v is string => !!v))]
      result.queries = []
      for (const keyword of queries) {
        result.query = keyword
        result.queries.push(keyword)
        const catalog = await api.search(keyword, 6)
        catalog.items = [...new Map(catalog.items.slice(0, 6).map((item) => [item.asin, item])).values()]
        const selected = await selectCandidates(db, productId, catalog, { ...terms, query: keyword })
        result.candidates = await offers(api, selected)
        result.checkedAt = new Date().toISOString()
        // Separate evidence IDs retain the original catalog page when a search is refined or upgraded.
        evidence.push(...catalogEvidence(db, crypto.randomUUID(), result, catalog))
        result.status = selected.length ? 'found' : 'no_results'
        result.message = selected.length
          ? 'Amazon 美国站找到 ' + selected.length + ' 个待核对候选。'
          : catalog.items.length
            ? '本页没有可比较的候选（商品用途不符、依据不足或已人工排除）。'
            : 'Amazon 美国站目录未返回该检索词的商品。'
        if (selected.length) break
      }
    } catch (e) {
      if (!(e instanceof PublicError)) throw e
      failed = e.code
      result.status = 'unavailable'
      result.message = e.message
    }
  }
  result.checkedAt = new Date().toISOString()
  const statements = [
    db
      .prepare(`UPDATE amazon_auto_comparisons SET result_json=?,lease_until=?,
    lease_token=CASE WHEN lease_token=? THEN lease_token ELSE NULL END WHERE id=?`)
      .bind(JSON.stringify(result), failed ? Date.now() + 60_000 : 0, token, id),
  ]
  statements.push(...evidence)
  if (failed)
    statements.push(
      db
        .prepare('INSERT INTO amazon_search_failures VALUES(?,?,?,?,?,?)')
        .bind(token, productId, result.query, result.checkedAt, failed, 'system:amazon-comparison'),
    )
  try {
    // The NOT NULL lease token fences expired workers; a lost lease rolls back the entire D1 batch.
    await db.batch(statements)
  } catch (e) {
    const latest = await saved()
    if (latest?.lease_token !== token) {
      if (latest?.result_json) return JSON.parse(latest.result_json) as AmazonComparison
      throw busy()
    }
    throw e
  }
  return result
}
