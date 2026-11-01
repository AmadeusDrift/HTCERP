import { type AmazonComparison, compareAmazonProduct } from '../amazon/auto-compare'
import { haulPriceTier } from '../amazon/haul-price-tier'
import type { JobInput, JobRow, OpsBindings, StepResult } from './model'
import { Stop } from './providers'

type Product = Record<string, unknown>
export function researchProducts(plan: Record<string, unknown>): Product[] {
  const rows = plan.target
    ? [plan.target]
    : Array.isArray(plan.examples)
      ? plan.examples.slice(0, 3)
      : []
  if (!rows.length || !rows.every((p) => p && typeof p === 'object' && typeof p.id === 'string'))
    throw new Stop('缓存范围内缺少可引用的商品样本，请选择商品或调整筛选条件')
  return rows as Product[]
}

// Keep a per-product slice of live evidence in Terra's bounded input. Full results stay in the step.
export function amazonModelFacts(comparisons: AmazonComparison[], compact = false) {
  return comparisons.map((item) => ({
    productId: item.productId,
    query: item.query.slice(0, 100),
    checkedAt: item.checkedAt,
    status: item.status,
    message: item.status !== 'found' ? item.message.slice(0, 150) : undefined,
    sourceSpecs: item.sourceSpecs?.slice(0, compact ? 80 : 220),
    candidates: item.candidates.slice(0, compact ? 1 : 3).map((p) => ({
      asin: p.asin,
      title: p.title?.slice(0, compact ? 90 : 180),
      specs: p.specs?.slice(0, compact ? 70 : 140),
      rank: p.rank,
      rankCategory: p.rankCategory?.slice(0, 60),
      price: p.price,
      haulPriceEstimate: haulPriceTier(p.price),
      shipping: p.shipping,
      priceStatus: p.priceStatus,
      basis: p.basis.slice(0, compact ? 80 : 160),
    })),
  }))
}

// Search pages can contain unrelated products. Read each pinned archive once and key every title by ID.
async function archivedTitles(env: OpsBindings, ref: string) {
  const titles = new Map<string, string>()
  if (!ref.startsWith('jobs/')) return titles
  // The English name is optional. Historical runs may reference local-only or unreadable snapshots.
  const data = await env.ARCHIVE.get(ref)
    .then((object) => object?.json<{ body?: { data?: { list?: Product[]; goods?: Product } } }>())
    .then((envelope) => envelope?.body?.data)
    .catch(() => undefined)
  const rows = Array.isArray(data?.list) ? data.list : data?.goods ? [data.goods] : []
  for (const row of rows) {
    if (row && row.goodsId != null && typeof row.goodsNameEn === 'string' && row.goodsNameEn.trim())
      titles.set(String(row.goodsId), row.goodsNameEn.trim())
  }
  return titles
}

export async function runAmazonComparison(
  env: OpsBindings,
  job: JobRow,
  plan: Record<string, unknown>,
  decision: Record<string, unknown>,
): Promise<StepResult> {
  const input = JSON.parse(job.inputs_json) as JobInput
  if (
    job.kind !== 'research' ||
    input.mode !== 'live' ||
    !['research', 'review', 'observe'].includes(String(decision.choice))
  )
    throw new Stop('需要在线研究任务和已完成的模型分流')
  const products = researchProducts(plan)
  if (
    (input.productId && (products.length !== 1 || products[0].id !== input.productId)) ||
    (Array.isArray(decision.products) &&
      JSON.stringify(decision.products) !== JSON.stringify(products.map((p) => p.id)))
  )
    throw new Stop('分流商品与锁定的研究快照不一致')
  const titles = new Map<string, Map<string, string>>()
  const comparisons: AmazonComparison[] = []
  for (const product of products) {
    const ref = String(product.evidence_ref ?? '')
    if (!titles.has(ref)) titles.set(ref, await archivedTitles(env, ref))
    const english = titles.get(ref)?.get(String(product.id).split(':')[2])
    const variants = plan.target ? plan.variants : product.variants
    comparisons.push(
      await compareAmazonProduct(
        env,
        job.id,
        english ? { ...product, title_en: english } : product,
        Array.isArray(variants) ? variants : [],
        undefined,
        {owner:job.actor,runId:job.id,attempt:job.status==='running'?job.attempt:undefined},
      ),
    )
  }
  const found = comparisons.filter((item) => item.status === 'found').length
  const empty = comparisons.filter((item) => item.status === 'no_results').length
  const unavailable = comparisons.length - found - empty
  const summary =
    'Amazon 美国站对照中，' +
    [
      found ? found + ' 件找到待核对的竞品' : '',
      empty ? empty + ' 件未搜到候选' : '',
      unavailable ? unavailable + ' 件未取得检索数据' : '',
    ]
      .filter(Boolean)
      .join('，') +
    '。'
  return { summary, result: { comparisons, summary } }
}
