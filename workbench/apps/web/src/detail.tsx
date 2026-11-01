import {
  ArrowUpRight,
  Bookmark,
  ChevronRight,
  ClipboardList,
  Database,
  ExternalLink,
  Fingerprint,
  FlaskConical,
  Search,
  ShieldCheck,
  Store,
} from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { marketplaceLink } from '../../../packages/contracts/presentation'
import './detail-analysis.css'
import { CompareAgain, ComparisonEvidence, needsAmazonLookup } from './amazon-comparison'
import { CandidateForm } from './catalog'
import {
  type AmazonPanel,
  type Detail,
  lines,
  type Match,
  type Observation,
  type PageResult,
  type Product,
  platforms,
  stages,
} from './models'
import { platformIcons } from './platform-icons'
import { ProductReviews } from './reviews'
import { Select, selectOptions } from './select'
import {
  amount,
  usePhoneScreen,
  BackLink,
  Badge,
  Dialog,
  date,
  Empty,
  ErrorBox,
  Field,
  Form,
  Loading,
  money,
  Notice,
  PageLink,
  Panel,
  Platform,
  productUrl,
  researchUrl,
  StageBadge,
  safeBack,
  Thumb,
  useAccess,
  useData,
  useLocation,
  useWrite,
} from './ui'
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '未取得'}</dd>
        </div>
      ))}
    </dl>
  )
}
// Older saved products may lack optional fields that newer observations provide.
type SourceProduct = Product & {
  max_price?: number | null
  brand?: string | null
  on_sale_at?: string | null
}
type DatedReading = Observation & {
  rating?: number | null
  review_count?: number | null
  currency?: string | null
}
type Sku = Detail['variants'][number] & { thumbnail?: string; stock?: number }
type ProductAnalysis = Omit<Detail, 'product' | 'history' | 'snapshots' | 'variants'> & {
  product: SourceProduct
  history: DatedReading[]
  snapshots: DatedReading[]
  variants: Sku[]
  hasMore?: { history: boolean; snapshots: boolean; feedback: boolean }
}
const indicators = {
  day_sold: '日销量',
  total_sold: '累计销量',
  min_price: '最低价',
  rating: '评分',
  review_count: '评论数',
  week_sold: '近 7 日销量',
  month_sold: '近 30 日销量',
}
type Indicator = keyof typeof indicators
const dayMs = 86400000
// Use the same Beijing calendar day shown by the detail table, including on DST transition dates.
function dayNumber(instant: number) {
  return Math.floor((instant + 8 * 3600000) / dayMs)
}
function dayLabel(day: number) {
  return new Date(day * dayMs).toISOString().slice(0, 10)
}
function HistoryChart({ history, product }: { history: DatedReading[]; product: Product }) {
  const [metric, setMetric] = useState<Indicator>('day_sold')
  const [span, setSpan] = useState('30')
  const days = new Map<number, { time: number; row: DatedReading }>()
  for (const row of history) {
    const time = Date.parse(row.observed_at || '')
    if (!Number.isFinite(time)) continue
    const day = dayNumber(time)
    if ((days.get(day)?.time ?? -Infinity) <= time) days.set(day, { time, row })
  }
  const ordered = [...days.keys()].sort((a, b) => a - b)
  const last = ordered.at(-1)
  const first =
    last == null ? 0 : span === 'all' ? ordered[0] : Math.max(ordered[0], last - Number(span) + 1)
  const points = ordered.flatMap((day) => {
    const row = days.get(day)!.row
    const value = row[metric]
    return day >= first && typeof value === 'number' && Number.isFinite(value) ? [{ day, value }] : []
  })
  const currency = product.currency || 'USD'
  const fmt = (value: number | null | undefined) =>
    metric === 'min_price' ? money(value, currency) : amount(value)
  const ymax =
    metric === 'rating'
      ? Math.max(5, ...points.map((p) => p.value))
      : Math.max(1, ...points.map((p) => p.value))
  const x = (day: number) => 82 + (566 * (day - first)) / Math.max(1, (last ?? first) - first)
  const y = (value: number) => 124 - (94 * value) / ymax
  const bar = metric === 'day_sold'
  return (
    <Panel
      title="历史趋势"
      extra={
        <Select
          variant="compact"
          aria-label="历史日期范围"
          value={span}
          onValueChange={setSpan}
          options={selectOptions({
            '7': '近 7 天',
            '30': '近 30 天',
            '90': '近 90 天',
            all: '全部已存日期',
          })}
        />
      }
    >
      <div className="da-chart-body">
        <div className="da-chart-controls">
          <Select
            variant="compact"
            aria-label="历史指标"
            value={metric}
            onValueChange={(v) => setMetric(v as Indicator)}
            options={selectOptions(indicators)}
          />
          <small>
            {last == null ? '尚无按日记录' : dayLabel(first) + ' 至 ' + dayLabel(last) + ' · 北京时间'}
          </small>
        </div>
        {points.length < 2 ? (
          <div className="da-reading">
            <small>
              {points.length
                ? dayLabel(points[0].day) + ' · 唯一有效观测'
                : '当前商品快照 · ' + date(product.updated_at)}
            </small>
            <strong>{fmt(points.length ? points[0].value : product[metric])}</strong>
            <span>
              {points.length ? '仅有一天的观测，无法判断趋势。' : '所选范围没有该指标的历史值。'}
            </span>
          </div>
        ) : (
          <>
            <svg
              className="bar-chart da-plot"
              viewBox="0 0 680 155"
              role="img"
              aria-label="按来源日期绘制的历史观测值"
            >
              <title>
                {indicators[metric]} · {points.length} 天
              </title>
              {[0, 0.5, 1].map((t) => (
                <g key={t}>
                  <line x1="76" x2="655" y1={y(t * ymax)} y2={y(t * ymax)} />
                  <text x="67" y={y(t * ymax) + 4} textAnchor="end">
                    {fmt(t * ymax)}
                  </text>
                </g>
              ))}
              {points.map((p, i) => (
                <g key={p.day}>
                  {!bar && i > 0 && p.day - points[i - 1].day === 1 && (
                    <line
                      className="da-segment"
                      x1={x(points[i - 1].day)}
                      y1={y(points[i - 1].value)}
                      x2={x(p.day)}
                      y2={y(p.value)}
                    />
                  )}
                  {bar && p.value !== 0 ? (
                    <rect x={x(p.day) - 2.5} y={y(p.value)} width="5" height={124 - y(p.value)}>
                      <title>
                        {dayLabel(p.day)} · {fmt(p.value)}
                      </title>
                    </rect>
                  ) : (
                    <circle cx={x(p.day)} cy={y(p.value)} r="3.4">
                      <title>
                        {dayLabel(p.day)} · {fmt(p.value)}
                      </title>
                    </circle>
                  )}
                </g>
              ))}
              <text x="76" y="149">
                {dayLabel(first)}
              </text>
              <text x="655" y="149" textAnchor="end">
                {dayLabel(last!)}
              </text>
            </svg>
            <small>有效观测 {points.length} 天；同一天取最后一条记录，缺少数据的日期留空。</small>
          </>
        )}
      </div>
    </Panel>
  )
}
function HistoryTable({
  items,
  source,
  more,
}: {
  items: DatedReading[]
  source: boolean
  more?: boolean
}) {
  return (
    <Panel
      title={source ? '历史观测明细' : '已保存快照'}
      extra={
        <span className="subtle-pill">
          {more ? '最近 ' : ''}
          {items.length} 条
        </span>
      }
    >
      {items.length ? (
        <div className="table-scroll history-scroll">
          <table>
            <thead>
              <tr>
                {[
                  source ? '观测日期' : '更新时间',
                  '最低价',
                  '累计销量',
                  '日销',
                  '7 日销量',
                  '30 日销量',
                  ...(source ? ['评分', '评论数'] : []),
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: old snapshots may share all fields; the table renders immutable, non-editable rows in source order.
                <tr key={String(v.observed_at || v.updated_at) + '/' + i}>
                  <td>{date(v.observed_at || v.updated_at, true)}</td>
                  <td>{money(v.min_price, v.currency || 'USD')}</td>
                  <td>{amount(v.total_sold)}</td>
                  <td>{amount(v.day_sold)}</td>
                  <td>{amount(v.week_sold)}</td>
                  <td>{amount(v.month_sold)}</td>
                  {source && (
                    <>
                      <td>{amount(v.rating)}</td>
                      <td>{amount(v.review_count)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="暂无记录" />
      )}
    </Panel>
  )
}
function formatValue(v: unknown): string {
  if (v == null || v === '') return '未取得'
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(formatValue).join('、') || '未取得'
  if (typeof v === 'object')
    return (
      Object.entries(v)
        .map(([k, x]) => k + ' ' + formatValue(x))
        .join(' · ') || '未取得'
    )
  return String(v)
}
function Amazon({ product }: { product: Product }) {
  const path = '/products/' + encodeURIComponent(product.id) + '/amazon',
    data = useData<AmazonPanel>(path),
    { edit, admin } = useAccess()
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState<Match | null>(null),
    [note, setNote] = useState(''),
    [status, setStatus] = useState<Match['status']>('confirmed')
  const search = useWrite<AmazonPanel>(),
    review = useWrite<AmazonPanel>(() => setSelected(null))
  const d = data.data
  return (
    <Panel
      title="Amazon 复核"
      extra={
        <span className="subtle-pill">
          <Store size={12} />
          美国常规商城
        </span>
      }
    >
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <ErrorBox error={data.error} retry={() => void data.refetch()} />
      ) : (
        <div className="panel-body stack">
          {d?.automation?.comparison ? (
            <ComparisonEvidence comparison={d.automation.comparison} reviews={d.matches} />
          ) : (
            <div>
              <h3>来源与 Amazon 对照</h3>
              <p className="muted">
                {d?.automation
                  ? '这次研究尚无已保存的 Amazon 对照。'
                  : '尚无这件商品的在线研究对照记录。'}
              </p>
            </div>
          )}
          {d?.automation?.canBackfill && needsAmazonLookup(d.automation.comparison) && (
            <CompareAgain runId={d.automation.runId} />
          )}
          <div className="connection-strip">
            <div className="connector-icon amazon">a</div>
            <div>
              <b>Amazon Selling Partner API</b>
              <p>
                {d?.configured
                  ? 'AI 初步分析后会自动检索美国站。也可以输入关键词或 ASIN，补充查找其他商品。'
                  : '连接美国站账号后，即可检索目录、对照规格并核验可用报价。'}
              </p>
            </div>
            <Badge tone={d?.configured ? 'blue' : 'amber'}>
              {d?.configured ? '凭据已绑定' : '待配置'}
            </Badge>
            {admin && !d?.configured && (
              <PageLink className="btn" href="/settings?tab=connections">
                前往配置 <ChevronRight />
              </PageLink>
            )}
          </div>
          <Form
            className="inline amazon-search"
            onSubmit={() => {
              if (query.trim())
                search.mutate(
                  { path: path + '/search', body: { query: query.trim() } },
                  { onError: () => void data.refetch() },
                )
            }}
          >
            <div className="input-icon">
              <Search />
              <input
                aria-label="Amazon 关键词或 ASIN"
                placeholder="关键词或明确的 ASIN"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                required
                minLength={2}
                maxLength={180}
              />
            </div>
            <button
              type="submit"
              disabled={!d?.configured || !edit || !query.trim() || search.isPending}
            >
              {search.isPending ? '检索中…' : '检索 Amazon'}
            </button>
          </Form>
          <ErrorBox error={search.error} />
          {!!d?.matches.length && (
            <div className="match-list">
              {d.matches.map((m) => (
                <article className="match" key={m.asin}>
                  <div className="spread">
                    <div>
                      <small>ASIN · {m.asin}</small>
                      <h3>{m.title || '未取得标题'}</h3>
                    </div>
                    <Badge
                      tone={
                        m.status === 'confirmed' ? 'teal' : m.status === 'rejected' ? 'neutral' : 'amber'
                      }
                    >
                      {m.status === 'confirmed'
                        ? '人工已确认'
                        : m.status === 'rejected'
                          ? '已排除'
                          : '待人工确认'}
                    </Badge>
                  </div>
                  <Facts
                    rows={[
                      ['匹配方式', m.method === 'asin' ? 'ASIN 精确检索' : '关键词检索'],
                      ['规格', formatValue(m.specs)],
                      ['可用报价', m.price == null ? '未取得' : money(m.price, m.currency || 'USD')],
                      [
                        '类目排名',
                        m.rank == null
                          ? '未取得'
                          : amount(m.rank) + ' · ' + (m.rankCategory || '类目未返回'),
                      ],
                      ['目录采集', date(m.fetchedAt, true)],
                      [
                        '报价状态',
                        m.priceStatus === 'available'
                          ? '报价已取得'
                          : m.priceStatus === 'unavailable'
                            ? '暂无可用报价'
                            : m.priceStatus || '待核验',
                      ],
                      ['运费', m.shipping == null ? '未取得' : money(m.shipping, m.currency || 'USD')],
                      ['报价采集', date(m.priceFetchedAt, true)],
                      ['人工说明', m.note || '待补充'],
                      ['复核人员', m.reviewer || '待确认'],
                      ['复核时间', date(m.reviewedAt, true)],
                    ]}
                  />
                  <button
                    type="button"
                    disabled={!edit}
                    onClick={() => {
                      setSelected(m)
                      setStatus(m.status === 'pending' ? 'confirmed' : m.status)
                      setNote(m.note || '')
                      review.reset()
                    }}
                  >
                    <ShieldCheck />
                    人工复核
                  </button>
                </article>
              ))}
            </div>
          )}
          {d?.searches.length ? (
            <details>
              <summary>检索记录 · {d.searches.length} 次</summary>
              <ul className="log-list">
                {d.searches.map((s) => (
                  <li key={s.id}>
                    <b>{s.query}</b>
                    <span>
                      {date(s.fetchedAt, true)} ·{' '}
                      {s.status === 'succeeded'
                        ? '本次返回 ' + s.returned + ' 条'
                        : '检索失败 · ' + s.status}
                      {s.hasMore ? ' · 上游还有更多结果' : ''}
                    </span>
                    {s.hasMore && (
                      <button
                        type="button"
                        className="linkbtn"
                        disabled={!edit || !d.configured || search.isPending}
                        onClick={() =>
                          search.mutate(
                            { path: path + '/search', body: { query: s.query, after: s.id } },
                            { onError: () => void data.refetch() },
                          )
                        }
                      >
                        继续检索
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <small className="muted">尚无检索记录</small>
          )}
          <Notice>排名可辅助比较。竞品销量待核验，检索未命中时仍需补充证据。</Notice>
        </div>
      )}
      {selected && (
        <Dialog title="保存人工复核" onClose={() => setSelected(null)}>
          <Form
            className="dialog-body stack"
            onSubmit={() =>
              review.mutate({
                path: path + '/matches/' + encodeURIComponent(selected.asin),
                body: { searchId: selected.searchId, status, note: note.trim() },
              })
            }
          >
            <div>
              <small>ASIN · {selected.asin}</small>
              <h3>{selected.title}</h3>
            </div>
            <Field label="匹配判定">
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as Match['status'])}
                options={selectOptions({
                  confirmed: '确认可比',
                  rejected: '排除匹配',
                  pending: '待确认',
                })}
              />
            </Field>
            <Field label="规格差异与判定依据">
              <textarea
                required
                rows={4}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="记录尺寸、组合、材质等可比依据"
              />
            </Field>
            <ErrorBox error={review.error} />
            <div className="dialog-actions">
              <button type="button" onClick={() => setSelected(null)}>
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!edit || review.isPending || !note.trim()}
              >
                保存复核
              </button>
            </div>
          </Form>
        </Dialog>
      )}
    </Panel>
  )
}
const marketName = (p: Product) => (p.market === 'US' ? '美国站' : p.market || '站点未记录')
function SkuPanel({ variants }: { variants: Sku[] }) {
  const [query, setQuery] = useState('')
  const specText = (v: Sku) => (v.specs ?? []).map((s) => s.specKey + '：' + s.specValue).join(' · ')
  const matches = variants.filter((v) =>
    (v.sku_id + ' ' + specText(v)).toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <Panel
      title="SKU 明细"
      extra={<span className="subtle-pill">已收录 {amount(variants.length)} 个 SKU</span>}
    >
      {variants.length > 0 ? (
        <>
          <div className="da-table-tools">
            <div className="input-icon">
              <Search />
              <input
                aria-label="查找 SKU 或规格"
                placeholder="查找 SKU 或规格"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {matches.length ? (
            <div className="table-scroll da-sku">
              <table>
                <thead>
                  <tr>
                    {['SKU / 规格', '库存（件）', 'SKU 售价', 'SKU 销量', '销量占比', 'SKU 评分'].map(
                      (key) => (
                        <th scope="col" key={key}>
                          {key}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {matches.map((v) => (
                    <tr key={v.sku_id}>
                      <td>
                        <div className="da-variant">
                          {v.thumbnail && (
                            <img
                              src={v.thumbnail}
                              alt=""
                              width="42"
                              height="42"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          )}
                          <div>
                            <code>{v.sku_id}</code>
                            <small>{specText(v) || '未记录规格'}</small>
                          </div>
                        </div>
                      </td>
                      <td>{amount(v.stock)}</td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="没有匹配的规格" detail="可以改用 SKU 编号的一部分查找。" />
          )}
        </>
      ) : (
        <Empty title="当前快照未收录独立 SKU" />
      )}
      <p className="da-footnote">
        “—”表示未取得。缺少各 SKU 的独立销量和评分，暂不能判断哪种规格更受欢迎。
      </p>
    </Panel>
  )
}
function Regions({ product: p }: { product: Product }) {
  return (
    <Panel title="地区销量分布" extra={<span className="subtle-pill">按站点查看</span>}>
      <div className="panel-body stack">
        <div className="da-region-lead">
          <strong>{marketName(p)}</strong>
          <span>商品编号 {p.external_id}</span>
        </div>
        <div className="da-stat-grid">
          {(
            [
              ['日销量', p.day_sold],
              ['近 7 日销量', p.week_sold],
              ['近 30 日销量', p.month_sold],
              ['累计销量', p.total_sold],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <small>{k}</small>
              <strong>{amount(v)}</strong>
            </div>
          ))}
        </div>
        <p>当前仅有该站点商品记录。缺少同一商品在各地区、同一周期内可比较的销量，无法计算地区占比。</p>
        <small>商品数据更新时间：{date(p.updated_at, true)}（北京时间）</small>
      </div>
    </Panel>
  )
}
function candidateTerms(p: Product) {
  const found = new Map<string, { term: string; origin: string; evidence: string }>()
  function add(value: string, origin: string, evidence: string) {
    const term = value.trim()
    if (term.length < 2 || term.length > 42 || !/[\p{L}]/u.test(term) || found.has(term.toLowerCase()))
      return
    found.set(term.toLowerCase(), { term, origin, evidence })
  }
  const categories = (p.category_path || p.category_name || '').split(/\s*\/\s*/u).filter(Boolean)
  if (categories.length) add(categories.at(-1)!, '末级类目', categories.join(' / '))
  for (const [label, title] of [
    ['中文标题', p.title_cn],
    ['商品原名', p.title],
  ] as const) {
    if (!title) continue
    let count = 0
    for (const phrase of title.split(/[,，;；:：。|｜、!！()（）[\]]+/u)) {
      const clean = phrase.trim()
      if (!clean || !/\p{L}/u.test(clean)) continue
      // Prefer verbatim title phrases. For a long clause, choose a short contiguous excerpt.
      const tokens =
        clean.length <= 32
          ? [clean]
          : /[\p{Script=Han}]/u.test(clean)
            ? Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(clean))
                .filter((t) => t.isWordLike && t.segment.length >= 2)
                .map((t) => t.segment)
            : [clean.split(/\s+/u).slice(0, 4).join(' ')]
      for (const token of tokens) {
        const prior = found.size
        if (!/^(这个|产品|商品|一个|适合|可以|使用|一个|包括|the|for|with)$/i.test(token))
          add(token, label, title)
        if (found.size > prior) count++
        if (count >= 3) break
      }
      if (count >= 3) break
    }
  }
  return [...found.values()]
}
function Keywords({ product: p }: { product: Product }) {
  const terms = candidateTerms(p)
  const [selected, setSelected] = useState(terms[0]?.term || '')
  const query = new URLSearchParams({ platform: p.platform, market: p.market, q: selected })
  const list = useData<PageResult<Product>>('/products?' + query + '&pageSize=5', !!selected)
  const catalogUrl = '/?' + query
  return (
    <div className="stack">
      <Panel title="相关关键词" extra={<span className="subtle-pill">标题与类目</span>}>
        <div className="panel-body stack">
          <p>
            选一个词，查看同平台商品库里的匹配商品。这些词来自当前商品的文字资料，不代表买家实际搜索过。
          </p>
          {terms.length ? (
            <div className="da-terms">
              {terms.map((t) => (
                <button
                  type="button"
                  key={t.term}
                  aria-pressed={selected === t.term}
                  onClick={() => setSelected(t.term)}
                >
                  {t.term}
                  <small>{t.origin}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>没有可用的标题或类目词。</p>
          )}
          {selected && (
            <dl className="da-quote">
              <dt>取词依据 · {terms.find((t) => t.term === selected)?.origin}</dt>
              <dd>{terms.find((t) => t.term === selected)?.evidence}</dd>
            </dl>
          )}
        </div>
      </Panel>
      {selected && (
        <Panel
          title={'库内检索：' + selected}
          extra={
            <PageLink className="linkbtn" href={catalogUrl}>
              查看全部匹配 <ArrowUpRight size={14} />
            </PageLink>
          }
        >
          {list.isPending ? (
            <Loading />
          ) : list.isError ? (
            <ErrorBox error={list.error} retry={() => void list.refetch()} />
          ) : (
            <>
              <p className="da-result-count">
                {platforms[p.platform] || p.platform} · {marketName(p)} · 已存商品中匹配{' '}
                <b>{amount(list.data.total)}</b> 件{list.data.total > 5 ? '，以下列出前 5 件。' : '。'}
              </p>
              {list.data.items.length > 0 && (
                <ul className="da-result-list">
                  {list.data.items.map((item) => (
                    <li key={item.id}>
                      <PageLink href={productUrl(item.id, catalogUrl)}>
                        {item.title_cn || item.title}
                      </PageLink>
                      <small>{item.external_id}</small>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="da-footnote">尚无该词的市场搜索量、销售额和竞争指数。</p>
        </Panel>
      )}
    </div>
  )
}
function PhoneProductTitle({ title }: { title: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const heading = ref.current!
    function measure() {
      const style = getComputedStyle(heading)
      const limit = Number(style.getPropertyValue('--title-lines')) * Number.parseFloat(style.lineHeight)
      const exceedsLimit = heading.scrollHeight > limit + 1
      setOverflows(exceedsLimit)
      if (!exceedsLimit) setExpanded(false)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(heading)
    document.fonts.addEventListener('loadingdone', measure)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
    }
  }, [])
  return (
    <>
      <h1 ref={ref} id={id} className="phone-product-title" data-expanded={expanded}>
        {title}
      </h1>
      {overflows && (
        <button
          type="button"
          className="linkbtn title-toggle"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起标题' : '展开标题'}
        </button>
      )}
    </>
  )
}
const tabs = [
  ['overview', '商品概况'],
  ['history', '历史趋势'],
  ['sku', 'SKU 分析'],
  ['region', '地区销量'],
  ['reviews', '评论分析'],
  ['keywords', '相关关键词'],
  ['amazon', 'Amazon 复核'],
  ['evidence', '证据与反馈'],
]
export function ProductDetail({ id }: { id: string }) {
  const { params } = useLocation(),
    back = safeBack(params.get('back')),
    [tab, setTab] = useState('overview'),
    [editNote, setEditNote] = useState(false),
    { edit } = useAccess()
  const phone = usePhoneScreen()
  const d = useData<ProductAnalysis>('/products/' + encodeURIComponent(id))
  if (d.isPending) return <Loading />
  if (d.isError)
    return (
      <>
        <BackLink href={back} label="返回列表" />
        <ErrorBox error={d.error} retry={() => void d.refetch()} />
      </>
    )
  const { product: p, history, variants, feedback, snapshots } = d.data
  const range = p.min_price != null && p.max_price != null && p.max_price > p.min_price
  const href = marketplaceLink(p.source_url)
  const originalLink = href && (
    <a href={href} target="_blank" rel="noreferrer">
      打开平台商品页 <ExternalLink size={12} />
    </a>
  )
  const followUpActions = (
          <div className="inline">
            <button type="button" disabled={!edit} onClick={() => setEditNote(true)}>
              <Bookmark />
              {p.stage ? '更新跟进记录' : '加入候选池'}
            </button>
            <PageLink className="btn primary" href={researchUrl(id)}>
              <FlaskConical />
              发起 AI 研究
            </PageLink>
          </div>
  )
  return (
    <>
      <BackLink
        href={back}
        label={
          back.startsWith('/candidates')
            ? '返回候选与观察池'
            : back.startsWith('/potential') ? '返回潜力新品' : back.startsWith('/daily')
              ? '返回选品日报'
              : '返回发现商品'
        }
      />
      <div className="detail-intro panel">
        <Thumb p={p} big />
        <div className="detail-meta">
          <div className="inline">
            {platformIcons.has(p.platform) ? (
              <span className="da-platform">
                <img src={platformIcons.get(p.platform)} alt="" width="22" height="22" />
                {platforms[p.platform]}
              </span>
            ) : (
              <Platform id={p.platform} />
            )}
            <span className="meta-divider">/</span>
            <small>{marketName(p)}</small>
            <StageBadge stage={p.stage} />
          </div>
          {phone ? (
            <PhoneProductTitle key={p.id + (p.title_cn || p.title)} title={p.title_cn || p.title} />
          ) : (
            <h1>{p.title_cn || p.title}</h1>
          )}
          <small>
            商品 ID <code>{p.external_id}</code>
            {p.category_path && <span className="da-category">{p.category_path}</span>}
          </small>
          <div className="detail-price">
            {money(p.min_price, p.currency || 'USD')}
            {range && ' – ' + money(p.max_price, p.currency || 'USD')}{' '}
            <small>
              {p.currency || 'USD'} · {range ? '价格区间' : '最低价'}
            </small>
          </div>
          {phone ? <small>数据更新于 {date(p.updated_at, true)}</small> : followUpActions}
        </div>
      </div>
      <div className="metric-strip">
        {[
          ['累计销量', p.total_sold],
          ['日销量', p.day_sold],
          ['近 7 日销量', p.week_sold],
          ['近 30 日销量', p.month_sold],
          ['评分', p.rating],
          ['评论数', p.review_count],
        ].map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            <strong>{amount(v as number | null)}</strong>
          </div>
        ))}
      </div>
      {phone && <details className="phone-followup"><summary>跟进与研究</summary>{followUpActions}</details>}
      <nav className="tabs da-tabs" aria-label="商品详情栏目">
        {tabs.map(([k, v]) => (
          <button
            type="button"
            key={k}
            className={k === tab ? 'active' : ''}
            aria-pressed={k === tab}
            onClick={() => setTab(k)}
          >
            {v}
          </button>
        ))}
      </nav>
      <div className="stack">
        {tab === 'overview' && (
          <>
            <div className="split-chart">
              <HistoryChart product={p} history={history} />
              <Panel title="当前快照" extra={<Database size={16} />}>
                <Facts
                  rows={[
                    ['更新时间', date(p.updated_at, true)],
                    ['历史记录', (d.data.hasMore?.history ? '最近 ' : '') + history.length + ' 条'],
                    ['采集时间', date(p.fetched_at, true)],
                    ['已收录 SKU', variants.length + ' 个'],
                  ]}
                />
              </Panel>
            </div>
            <Panel title="商品资料">
              <Facts
                rows={[
                  ['商品类目', p.category_path || p.category_name],
                  ['店铺 ID', p.shop_id],
                  ['品牌', p.brand],
                  ['上架时间', date(p.on_sale_at)],
                  ['商品原名', p.title],
                  ['商品原链接', originalLink],
                ]}
              />
              {p.category_id && (
                <div className="panel-end">
                  <PageLink
                    className="linkbtn"
                    href={
                      '/?platform=' +
                      encodeURIComponent(p.platform) +
                      '&category=' +
                      encodeURIComponent(p.platform + ':' + p.category_id)
                    }
                  >
                    查看同类商品 <ArrowUpRight size={14} />
                  </PageLink>
                </div>
              )}
            </Panel>
            <Panel title="平台排名">
              <p className="da-footnote">
                当前商品尚无已核实的站点、类目、店铺或全托管排名，也未取得新品上榜记录。
              </p>
            </Panel>
            <Amazon product={p} />
          </>
        )}
        {tab === 'sku' && <SkuPanel variants={variants} />}
        {tab === 'region' && <Regions product={p} />}
        {tab === 'keywords' && <Keywords product={p} />}
        {tab === 'reviews' && <ProductReviews key={p.id} product={p} />}
        {tab === 'history' && (
          <>
            <HistoryChart product={p} history={history} />
            <HistoryTable items={history} source more={d.data.hasMore?.history} />
            <HistoryTable items={snapshots || []} source={false} more={d.data.hasMore?.snapshots} />
          </>
        )}
        {tab === 'amazon' && <Amazon product={p} />}
        {tab === 'evidence' && (
          <>
            <Panel title="来源证据" extra={<Fingerprint size={16} />}>
              <Facts
                rows={[
                  ['商品平台', platforms[p.platform]],
                  ['商品标识', p.id],
                  ['更新时间', date(p.updated_at, true)],
                  ['采集时间', date(p.fetched_at, true)],
                  ['商品原链接', originalLink],
                ]}
              />
            </Panel>
            <Panel
              title="人工反馈"
              extra={
                <button type="button" disabled={!edit} onClick={() => setEditNote(true)}>
                  <ClipboardList />
                  添加记录
                </button>
              }
            >
              {feedback.length ? (
                <ul className="log-list">
                  {feedback.map((f) => (
                    <li key={JSON.stringify([f.author, f.created_at, f.stage, f.lines, f.note])}>
                      <b>
                        {stages[f.stage]} · {f.author}
                      </b>
                      <p>{f.note || '未填写备注'}</p>
                      <small>
                        {f.lines.map((l) => lines[l]).join(' / ')} {date(f.created_at, true)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="暂无人工反馈" detail="记录机会类型、判断依据和下一步跟进事项。" />
              )}
            </Panel>
          </>
        )}
      </div>
      {editNote && <CandidateForm p={p} close={() => setEditNote(false)} />}
    </>
  )
}
