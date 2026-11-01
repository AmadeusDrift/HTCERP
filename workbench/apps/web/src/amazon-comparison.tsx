import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import type { AmazonComparison } from '../../../packages/amazon/auto-compare'
import { haulPriceTier } from '../../../packages/amazon/haul-price-tier'
import type { Match } from './models'
import { Select } from './select'
import { amount, date, ErrorBox, money, useAccess, useWrite } from './ui'
import './amazon-comparison.css'

export { needsAmazonLookup } from '../../../packages/amazon/comparison-policy'

export function CompareAgain({ runId }: { runId: string }) {
  const { edit } = useAccess()
  const request = useWrite()
  if (!edit) return null
  return (
    <div className="amz-retry">
      <button
        type="button"
        disabled={request.isPending}
        onClick={() =>
          request.mutate({ path: '/jobs/' + encodeURIComponent(runId) + '/amazon-compare', body: {} })
        }
      >
        {request.isPending ? '正在补查…' : '补查 Amazon'}
      </button>
      <small>只补查本次研究的 Amazon 数据。</small>
      <ErrorBox error={request.error} />
    </div>
  )
}

function offerLabel(status: string) {
  if (status === 'not_checked') return '本次未查报价'
  if (status === 'unavailable') return '暂无美元报价'
  if (status === 'SOURCE_RATE_LIMIT') return '报价查询受限'
  if (status === 'SOURCE_AUTH') return '报价授权不足'
  return '报价未取得'
}

const statusLabel = {
  found: '已找到候选',
  no_results: '目录未命中',
  unavailable: '目录查询未完成',
  no_query: '缺少检索词',
}

export function ComparisonEvidence({
  comparison: c,
  reviews,
}: {
  comparison: AmazonComparison
  reviews?: Match[]
}) {
  const [asin, setAsin] = useState('')
  const candidate = c.candidates.find((item) => item.asin === asin) ?? c.candidates[0]
  const priceGap =
    c.sourceCurrency === 'USD' && c.sourcePrice != null && candidate?.price != null
      ? Math.round((candidate.price - c.sourcePrice) * 100) / 100
      : null
  const review = reviews?.find((item) => item.asin === candidate?.asin)
  const reviewLabel =
    review?.status === 'confirmed'
      ? '人工已确认可比'
      : review?.status === 'rejected'
        ? '人工已排除'
        : reviews
          ? '待人工确认'
          : '自动候选 · 需人工核对'
  return (
    <section className="amz-compare" aria-label="来源与 Amazon 对照">
      <div className="amz-heading">
        <strong>Amazon Haul 低价商城</strong>
        <a className="btn" target="_blank" rel="noreferrer"
          href={c.query ? 'https://www.amazon.com/s?' + new URLSearchParams({
            k: c.query, i: 'bazaar', srs: '121974693011',
          }) : 'https://www.amazon.com/haul/store'}>
          {c.query ? '去低价商城搜这件商品' : '打开低价商城'} <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="amz-heading">
        <strong>美国站通用目录对照</strong>
        <span>{c.status === 'found' ? c.candidates.length + ' 个目录候选' : statusLabel[c.status]}</span>
      </div>
      {candidate ? (
        <>
          {c.candidates.length > 1 && (
            <Select
              aria-label="切换 Amazon 候选"
              variant="compact"
              value={candidate.asin}
              onValueChange={setAsin}
              options={c.candidates.map((item, i) => ({
                value: item.asin,
                label: i + 1 + ' · ' + (item.title || '未取得标题'),
              }))}
            />
          )}
          <table aria-label="商品证据并排对照">
            <thead>
              <tr>
                <th scope="col">来源商品</th>
                <th scope="col">Amazon 美国站</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>{c.sourceTitle || '来源标题未取得'}</b>
                </td>
                <td>
                  <a
                    href={'https://www.amazon.com/dp/' + encodeURIComponent(candidate.asin)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {candidate.title || '查看 Amazon 商品'} <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                  <small>ASIN · {candidate.asin}</small>
                </td>
              </tr>
              <tr>
                <td>
                  <small>来源规格</small>
                  {c.sourceSpecs || '未取得'}
                </td>
                <td>
                  <small>目录规格</small>
                  {candidate.specs || '未取得'}
                </td>
              </tr>
              <tr>
                <td>
                  <small>来源最低展示价</small>
                  {c.sourcePrice == null
                    ? '未取得'
                    : c.sourceCurrency
                      ? money(c.sourcePrice, c.sourceCurrency) + ' ' + c.sourceCurrency
                      : amount(c.sourcePrice) + '（币种未知）'}
                </td>
                <td>
                  <small>商品报价 · USD</small>
                  {candidate.price == null ? offerLabel(candidate.priceStatus) : money(candidate.price)}
                  <small>运费 {candidate.shipping == null ? '未取得' : money(candidate.shipping)}</small>
                </td>
              </tr>
              <tr>
                <td>
                  <small>来源累计销量</small>
                  {c.sourceSold == null ? '未取得' : amount(c.sourceSold) + ' 件'}
                </td>
                <td>
                  <small>Amazon 类目排名</small>
                  {candidate.rank == null ? '未取得' : '#' + amount(candidate.rank)}
                  {candidate.rankCategory
                    ? ' · ' + candidate.rankCategory
                    : candidate.rank != null
                      ? ' · 类目未返回'
                      : ''}
                  <small>竞品销量未取得</small>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="amz-basis">
            <span><b>低价商城初筛</b> · {haulPriceTier(candidate.price)}</span>
            <small>按 Amazon 整组美元报价判断，不含运费。实际商城归属以前台核验为准。</small>
            <b>{reviewLabel}</b>
            {priceGap != null && (
              <span>
                按各自刊登的包装和规格，Amazon 整组报价
                {priceGap === 0
                  ? '与来源展示价持平'
                  : '比来源展示价' + (priceGap > 0 ? '高 ' : '低 ') + money(Math.abs(priceGap))}
                （不含运费）。
              </span>
            )}
            <span>入选依据 · {candidate.basis || '未记录'}</span>
            {review?.note && <span>人工说明 · {review.note}</span>}
          </div>
        </>
      ) : (
        <div className="amz-empty">
          <b>{c.sourceTitle || '来源标题未取得'}</b>
          <span>{c.message || statusLabel[c.status]}</span>
        </div>
      )}
      <div className="amz-meta">
        <span>检索词 · {c.queries?.length ? c.queries.join(' → ') : c.query || '未生成'}</span>
        <span>核对时间 · {date(c.checkedAt, true)}（北京）</span>
      </div>
    </section>
  )
}
