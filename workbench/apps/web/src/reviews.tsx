import { useState } from 'react'
import type { Product } from './models'
import { Select, selectOptions } from './select'
import { amount, date, ErrorBox, Form, Loading, Panel, useAccess, useData, useWrite } from './ui'

type Report = { updatedAt: string } & (
  | {
      platform: 'temu'
      data: {
        total: number
        rows: number
        withText: number
        summary: string | null
        comments: string[]
        modelIssue?: string
        modelStatus?: number
      }
    }
  | {
      platform: 'amazon'
      data: {
        topics: { name: string; mentions: number | null; snippets: string[] }[]
        period: { startDate: string; endDate: string } | null
      }
    }
)
type ReviewPlatform = 'amazon' | 'temu'
function ReportPanel({ platform, id }: { platform: ReviewPlatform; id: string }) {
  const path = '/reviews/' + platform + '/' + encodeURIComponent(id)
  const saved = useData<{ report: Report | null }>(path)
  const run = useWrite<Report>()
  const { admin } = useAccess()
  const r = run.data ?? saved.data?.report
  return (
    <div className="da-report stack">
      <div className="da-report-head">
        <div>
          <small>{platform === 'temu' ? 'Temu · 美国站 · 1–2 星' : 'Amazon · 美国站 · 负面主题'}</small>
          <h3>
            {platform === 'temu' ? '商品 ID ' : '子 ASIN '}
            {id}
          </h3>
        </div>
        {admin && (
          <button
            type="button"
            disabled={run.isPending || saved.isPending}
            onClick={() => run.mutate({ path, body: {} })}
          >
            {run.isPending ? '正在分析…' : r ? '更新分析' : '生成分析'}
          </button>
        )}
      </div>
      <ErrorBox error={run.error ?? saved.error} />
      {saved.isPending && !r ? (
        <Loading />
      ) : r ? (
        <>
          <small>报告更新时间：{date(r.updatedAt, true)}（北京时间）</small>
          {r.platform === 'temu' ? (
            <>
              <div className="da-stat-grid">
                {(
                  [
                    ['符合筛选的低星评价', r.data.total],
                    ['本页读取', r.data.rows],
                    ['有正文的评价', r.data.withText],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <small>{k}</small>
                    <strong>
                      {amount(v)} <small>条</small>
                    </strong>
                  </div>
                ))}
              </div>
              <div className="da-summary">
                <h4>低星样本的主要问题</h4>
                <p>
                  {r.data.summary ||
                    (r.data.modelIssue
                      ? r.data.modelIssue + '。可展开已读取的正文核对。'
                      : r.data.withText
                        ? '尚无已保存的总结，可展开查看评价正文。'
                        : '本页没有可供分析的评价正文。')}
                </p>
              </div>
              {r.data.comments.length > 0 && (
                <details className="da-evidence">
                  <summary>查看分析依据 · {r.data.comments.length} 条正文</summary>
                  <ol>
                    {r.data.comments.map((comment, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the saved report cites precisely these immutable, one-based evidence positions, including repeated text.
                      <li key={i}>{comment}</li>
                    ))}
                  </ol>
                </details>
              )}
              <small>仅分析第一页，最多 30 条。问题仅代表本页有正文的低星样本。</small>
            </>
          ) : (
            <>
              <div className="da-stat-grid">
                <div>
                  <small>负面主题</small>
                  <strong>
                    {amount(r.data.topics.length)} <small>个</small>
                  </strong>
                </div>
                <div>
                  <small>代表性摘录</small>
                  <strong>
                    {amount(r.data.topics.reduce((n, t) => n + t.snippets.length, 0))} <small>条</small>
                  </strong>
                </div>
              </div>
              {r.data.period && (
                <small>
                  Amazon 统计区间：{r.data.period.startDate.slice(0, 10)} 至{' '}
                  {r.data.period.endDate.slice(0, 10)}
                </small>
              )}
              {r.data.topics.length ? (
                <div className="da-topic-list">
                  {r.data.topics.map((t) => (
                    <article key={t.name}>
                      <div className="da-report-head">
                        <h4>{t.name}</h4>
                        <small>
                          {t.mentions != null ? '提及 ' + amount(t.mentions) + ' 次' : '提及数未提供'}
                        </small>
                      </div>
                      {t.snippets.length ? (
                        t.snippets.map((q, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: quotations can repeat in an immutable Amazon response.
                          <blockquote key={j}>{q}</blockquote>
                        ))
                      ) : (
                        <small>本主题没有代表性摘录。</small>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p>暂无已返回的负面主题。</p>
              )}
              <small>
                主题和摘录按子 ASIN
                汇总；未取得全部低星评论数，不能据此计算差评率，也不能归因给某个卖家。
              </small>
            </>
          )}
        </>
      ) : (
        !saved.error && (
          <p>
            暂无已保存的分析。
            {admin ? '点“生成分析”可读取该商品的反馈。' : '管理员生成后，可在这里查看。'}
          </p>
        )
      )}
    </div>
  )
}
function targetId(platform: ReviewPlatform, input: string) {
  const value = input.trim()
  const valid = platform === 'amazon' ? /^[A-Z0-9]{10}$/i : /^[0-9]{1,24}$/
  if (valid.test(value)) return value.toUpperCase()
  try {
    const link = new URL(value)
    if (link.protocol !== 'https:' || link.username || link.password || link.port) return ''
    const id =
      platform === 'amazon' && /^(www\.)?amazon\.com$/i.test(link.hostname)
        ? link.pathname.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1]
        : platform === 'temu' && /^(www\.)?temu\.com$/i.test(link.hostname)
          ? link.pathname.match(/-g-(\d+)\.html$/i)?.[1] ||
            (/(?:^|\/)goods\.html$/i.test(link.pathname) ? link.searchParams.get('goods_id') : '')
          : ''
    return id && valid.test(id) ? id.toUpperCase() : ''
  } catch {
    return ''
  }
}
function ComparedReport({ own }: { own: boolean }) {
  const [platform, setPlatform] = useState<ReviewPlatform>('amazon')
  const [input, setInput] = useState('')
  const [id, setId] = useState('')
  const [error, setError] = useState('')
  return (
    <div className="stack">
      <p>
        {own ? '输入自家商品，核对需要改进的问题。' : '输入竞品，查看买家反复提到的问题。'}
        本次由你选择商品归属。
      </p>
      <Form
        className="da-review-form"
        onSubmit={() => {
          const result = targetId(platform, input)
          if (!result) {
            setId('')
            setError(
              platform === 'amazon'
                ? '请输入 10 位子 ASIN 或美国站商品链接。'
                : '请输入数字商品 ID 或 Temu 商品链接。',
            )
            return
          }
          setError('')
          setId(result)
        }}
      >
        <Select
          aria-label="反馈平台"
          value={platform}
          options={selectOptions({ amazon: 'Amazon 美国站', temu: 'Temu 美国站' })}
          onValueChange={(v) => {
            setPlatform(v as ReviewPlatform)
            setInput('')
            setError('')
            setId('')
          }}
        />
        <input
          aria-label={platform === 'amazon' ? 'Amazon 子 ASIN 或商品链接' : 'Temu 商品 ID 或商品链接'}
          value={input}
          placeholder={
            platform === 'amazon' ? '子 ASIN 或美国站商品链接' : '数字商品 ID 或 Temu 商品链接'
          }
          required
          maxLength={2048}
          onChange={(e) => {
            setInput(e.target.value)
            setError('')
          }}
        />
        <button type="submit">查看反馈</button>
      </Form>
      {error && <p role="alert">{error}</p>}
      {id && <ReportPanel key={platform + ':' + id} platform={platform} id={id} />}
    </div>
  )
}
export function ProductReviews({ product }: { product: Product }) {
  const [focus, setFocus] = useState<'own' | 'competitor'>('own')
  return (
    <div className="stack">
      <Panel title="当前商品评价">
        <div className="panel-body stack">
          <div className="da-stat-grid">
            <div>
              <small>商品总评论数</small>
              <strong>{amount(product.review_count)}</strong>
            </div>
            <div>
              <small>商品平均评分</small>
              <strong>{amount(product.rating)}</strong>
            </div>
          </div>
          <small>商品快照：{date(product.updated_at)}。未收录完整星级分布，无法计算好评率。</small>
          {product.platform === 'temu' && product.market === 'US' ? (
            <ReportPanel platform="temu" id={product.external_id} />
          ) : (
            <p>
              当前商品尚未接入逐条低星评价。可在下方输入 Amazon 子 ASIN 或 Temu 商品编号，查看对应反馈。
            </p>
          )}
        </div>
      </Panel>
      <Panel title="自家与竞品反馈">
        <div className="panel-body stack">
          <fieldset className="segmented da-review-modes" aria-label="反馈对象">
            <button
              type="button"
              aria-pressed={focus === 'own'}
              className={focus === 'own' ? 'selected' : ''}
              onClick={() => setFocus('own')}
            >
              自家商品
            </button>
            <button
              type="button"
              aria-pressed={focus === 'competitor'}
              className={focus === 'competitor' ? 'selected' : ''}
              onClick={() => setFocus('competitor')}
            >
              竞品
            </button>
          </fieldset>
          <div hidden={focus !== 'own'}>
            <ComparedReport own />
          </div>
          <div hidden={focus !== 'competitor'}>
            <ComparedReport own={false} />
          </div>
        </div>
      </Panel>
    </div>
  )
}
