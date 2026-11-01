import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesColumn,
  ChevronDown,
  CircleCheck,
  Files,
  ScanSearch,
} from 'lucide-react'
import type { AdminReport, ReportProduct } from '../../../packages/operations/admin-reports'
import { CompareAgain, ComparisonEvidence, needsAmazonLookup } from './amazon-comparison'
import {
  amount,
  BackLink,
  date,
  dollars,
  Empty,
  ErrorBox,
  Loading,
  money,
  Notice,
  PageLink,
  productUrl,
  useData,
  useLocation,
  useWrite,
} from './ui'
import './admin-reports.css'
import './selection-sheet.css'

const archiveUrl = '/daily?view=preview'
const names = { selection: '选品日报', tracking: '商品追踪日报' }
const taskUrl = (id: string) => '/tasks?id=' + encodeURIComponent(id)
const detailUrl = (r: AdminReport) =>
  archiveUrl + '&' + new URLSearchParams({ kind: r.kind, run: r.runId })
const shortDay = (day: string) => day.slice(5).replace('-', '/')
const scopeLabel = (r: AdminReport) => r.scope.replace(/类目 9711(?= · |$)/, '家居')
const diff = (p: ReportProduct) =>
  p.today == null || p.yesterday == null ? null : p.today - p.yesterday
function difference(p: ReportProduct) {
  const n = diff(p)
  return n == null
    ? '待补齐两日数据'
    : n === 0
      ? '持平'
      : (n > 0 ? '增加 ' : '减少 ') + amount(Math.abs(n)) + ' 件'
}
function totalChange(r: AdminReport) {
  const pairs = r.items.filter((p) => p.today != null && p.yesterday != null)
  const before = pairs.reduce((sum, p) => sum + p.yesterday!, 0),
    after = pairs.reduce((sum, p) => sum + p.today!, 0)
  return { count: pairs.length, before, after, delta: after - before }
}
function ReportCost({ report: r }: { report: AdminReport }) {
  return (
    <span className="rp-cost">
      {amount(r.points)} 积分 · {dollars(r.aiMicros)}
      {(r.pendingPoints > 0 || r.pendingMicros > 0) && (
        <small>
          另有待核用量 {amount(r.pendingPoints)} 积分 · {dollars(r.pendingMicros)}
        </small>
      )}
    </span>
  )
}
function OutcomeBand({ r }: { r: AdminReport }) {
  const per = r.examined ? (100 * r.matched) / r.examined : 0
  return (
    <div className="rp-band" aria-hidden="true">
      <span style={{ width: per + '%' }} />
    </div>
  )
}
function SelectionChart({ r }: { r: AdminReport }) {
  const byUnit = r.examined > 0 && r.examined <= 100
  return (
    <section className="rp-chart">
      <header>
        <div>
          <span className="rp-kicker">本轮检索</span>
          <h2>商品筛选分布</h2>
        </div>
        <ScanSearch size={22} aria-hidden="true" />
      </header>
      {r.examined ? (
        <>
          {byUnit ? (
            <div className="rp-unit-grid" aria-hidden="true">
              {Array.from({ length: r.examined }, (_, i) => (
                <i key={i} className={i < r.matched ? 'rp-match' : ''} />
              ))}
            </div>
          ) : (
            <OutcomeBand r={r} />
          )}
          <div className="rp-key">
            <span>
              <i className="current" />
              符合条件 <b>{amount(r.matched)}</b>
            </span>
            <span>
              <i className="prior" />
              未入选 <b>{amount(r.examined - r.matched)}</b>
            </span>
          </div>
          <p className="rp-caption">
            {byUnit ? '每一格代表一件已检查的商品。' : '按本轮实际检查的商品数量计算。'}
          </p>
        </>
      ) : (
        <p className="rp-caption">本轮没有可统计的检索记录。</p>
      )}
    </section>
  )
}
function Bar({
  value,
  max,
  prior,
  label,
}: {
  value: number | null
  max: number
  prior?: boolean
  label: string
}) {
  return (
    <div className={'rp-bar-row' + (prior ? ' prior' : '')}>
      <span className="rp-bar-label">{label}</span>
      <div className="rp-track" aria-hidden="true">
        {value != null && <i style={{ width: (value / max) * 100 + '%' }} />}
      </div>
      <b>{value == null ? '缺数据' : amount(value)}</b>
    </div>
  )
}
function TrackingChart({ r }: { r: AdminReport }) {
  const max = Math.max(1, ...r.items.flatMap((p) => [p.today ?? 0, p.yesterday ?? 0]))
  return (
    <section className="rp-chart">
      <header>
        <div>
          <span className="rp-kicker">近两日观测</span>
          <h2>逐件日销量对比</h2>
        </div>
        <ChartNoAxesColumn size={22} aria-hidden="true" />
      </header>
      <div className="rp-key">
        <span>
          <i className="prior" />
          {shortDay(r.previousDay)}
        </span>
        <span>
          <i className="current" />
          {shortDay(r.day)}
        </span>
        <small>单位 · 件</small>
      </div>
      {r.items.length ? (
        r.items.map((p) => (
          <div className="rp-bar-group" key={p.id}>
            <div className="rp-chart-name" title={p.title}>
              {p.title || p.id}
            </div>
            <Bar label={shortDay(r.previousDay)} value={p.yesterday} max={max} prior />
            <Bar label={shortDay(r.day)} value={p.today} max={max} />
          </div>
        ))
      ) : (
        <p className="rp-caption">本轮没有跟进商品。</p>
      )}
    </section>
  )
}
function Summary({ r }: { r: AdminReport }) {
  const selection = r.kind === 'selection',
    change = totalChange(r)
  const pct = r.examined ? Number(((100 * r.matched) / r.examined).toFixed(1)) : null
  const main = selection
    ? pct == null
      ? '—'
      : amount(pct)
    : change.count
      ? (change.delta > 0 ? '+' : '') + amount(change.delta)
      : '—'
  return (
    <div className="rp-spread">
      <section className="rp-lead">
        <span className="rp-flag">
          <i />
          {selection ? '筛选结果' : '跟进结果'}
        </span>
        <div className="rp-lead-core">
          <h2>{selection ? '本轮商品入选率' : '可比商品合计日销量变化'}</h2>
          <p className="rp-number">
            {main}
            <small>{selection ? '%' : '件'}</small>
          </p>
        </div>
        <div className="rp-lead-foot">
          {selection ? (
            <>
              <div>
                <span>实际检查</span>
                <b>
                  {amount(r.examined)} <small>件</small>
                </b>
              </div>
              <ArrowRight />
              <div>
                <span>符合条件</span>
                <b>
                  {amount(r.matched)} <small>件</small>
                </b>
              </div>
            </>
          ) : (
            <>
              <div>
                <span>{shortDay(r.previousDay)} 合计</span>
                <b>
                  {amount(change.count ? change.before : null)} <small>件</small>
                </b>
              </div>
              <ArrowRight />
              <div>
                <span>{shortDay(r.day)} 合计</span>
                <b>
                  {amount(change.count ? change.after : null)} <small>件</small>
                </b>
              </div>
            </>
          )}
        </div>
        <p className="rp-lead-note">
          {selection
            ? '按本轮实际检索的商品计算'
            : amount(change.count) + ' / ' + amount(r.items.length) + ' 件商品有连续两天的数据'}
        </p>
      </section>
      {selection ? <SelectionChart r={r} /> : <TrackingChart r={r} />}
    </div>
  )
}
function ProductEvidence({ p, r }: { p: ReportProduct; r: AdminReport }) {
  const select = r.kind === 'selection'
  const stale = !p.snapshotAt || Date.parse(p.snapshotAt) < Date.parse(r.previousDay + 'T00:00:00+08:00')
  return (
    <article className="rp-product">
      <div className="rp-product-head">
        <PageLink className="rp-product-name" href={productUrl(p.id, detailUrl(r))} title={p.title}>
          {p.title || p.id}
        </PageLink>
        {select ? (
          <span className={'rp-status ' + (stale ? 'caution' : '')}>
            {p.snapshotAt ? '来源更新 ' + date(p.snapshotAt) : '来源日期未知'}
            {stale ? ' · 需复核近期销量' : ''}
          </span>
        ) : (
          <span className={'rp-status ' + (diff(p) == null ? 'caution' : '')}>
            {diff(p) != null &&
              (diff(p)! > 0 ? (
                <ArrowUpRight size={14} />
              ) : diff(p)! < 0 ? (
                <ArrowDownRight size={14} />
              ) : null)}
            日销量较前一日 · {difference(p)}
          </span>
        )}
      </div>
      <div className="rp-product-sub">{p.selectionBasis}</div>
      <div className="rp-product-facts">
        <span>
          最低价 <b>{money(p.price)}</b>
        </span>
        <span>
          累计销量 <b>{amount(p.sold)}</b>
        </span>
        <span>
          日销量 <b>{amount(p.daily)}</b>
        </span>
      </div>
      <p className="rp-advice">{p.reason || '尚无跟进建议。'}</p>
      {select && p.aiReading && <aside className="rp-model-reading">
        <strong>AI 判断 · {({ research: '进入深入研究', observe: '继续观察', review: '需要人工复核' } as Record<string,string>)[p.aiReading.route] ?? '查看研究记录'}</strong>
        {p.aiReading.reason && <p>{p.aiReading.reason}</p>}
        {p.aiReading.next && <p>下一步 · {p.aiReading.next}</p>}
        {p.researchId && <PageLink href={taskUrl(p.researchId)}>查看原始分析 →</PageLink>}
      </aside>}
      {select && (
        <>
          {p.amazonComparison ? (
            <ComparisonEvidence comparison={p.amazonComparison} />
          ) : (
            <p className="rp-product-sub">
              {p.researchId
                ? '本轮关联研究尚无这件商品的 Amazon 对照记录。'
                : '本轮未对这件商品开展 AI 研究，暂无 Amazon 对照。'}
            </p>
          )}
          {p.researchId && p.amazonEligible && needsAmazonLookup(p.amazonComparison) && (
            <CompareAgain runId={p.researchId} />
          )}
        </>
      )}
      <details className="rp-evidence">
        <summary>
          查看数据依据 <ChevronDown size={14} />
        </summary>
        <div>
          <span>
            商品编号 <b>{p.id}</b>
          </span>
          {select && (
            <span>
              来源更新时间 <b>{date(p.snapshotAt, true)}</b>
            </span>
          )}
          {!select && (
            <>
              <span>
                前日观测 <b>{date(p.yesterdayAt, true)}</b>
              </span>
              <span>
                本日观测 <b>{date(p.todayAt, true)}</b>
              </span>
              <span>
                详情核对 <b>{date(p.detailAt, true)}</b>
              </span>
            </>
          )}
          {p.researchId && (
            <PageLink href={taskUrl(p.researchId)}>
              查看单品研究 <ArrowUpRight size={14} />
            </PageLink>
          )}
        </div>
      </details>
    </article>
  )
}
function SelectionOverview({ r }: { r: AdminReport }) {
  if (!r.examined) return null
  const series = r.items.flatMap(p => p.weeks?.length ? [{p, w:p.weeks}] : [])
  const rising = series.filter(({w}) => w[w.length-1] > w[w.length-2]).sort((a,b)=>(b.w.at(-1)!-b.w.at(-2)!)-(a.w.at(-1)!-a.w.at(-2)!))
  const stable = series.filter(({w}) => w.length===4 && Math.min(...w)>=100 && Math.max(...w)<=Math.min(...w)*1.25).sort((a,b)=>Math.min(...b.w)-Math.min(...a.w))
  return <section className="rp-chart erp-summary"><h2>本期选品总览</h2><div className="erp-summary-grid"><div>
    <div className="selection-counts">{[['检查',r.examined],['入选',r.matched],['未入选',r.examined-r.matched]].map(([label,count])=><div key={label}><small>{label}</small><strong>{count}<i>款</i></strong></div>)}</div>
    {!!r.exclusions?.length && <><h3>未入选的主要原因</h3>{r.exclusions.map(x=><Bar key={x.reason} label={x.reason} value={x.n} max={Math.max(...r.exclusions!.map(v=>v.n))}/>)}</>}
    </div>{!!rising.length && <div><h3>销量增长 · 近两周对比</h3>{rising.slice(0,3).map(({p,w})=><p key={p.id}>{p.title.slice(0,24)} · {w.at(-2)} → {w.at(-1)} 件</p>)}</div>}
    {!!stable.length && <div><h3>稳定有量 · 近四周</h3><small>每周至少 100 件，最高周比最低周至多高 25%</small>{stable.slice(0,3).map(({p,w})=><p key={p.id}>{p.title.slice(0,24)} · {w.join(' / ')} 件</p>)}</div>}</div></section>
}
function SelectionList({r}:{r:AdminReport}){
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[filter,setFilter]=useState('全部')
  const status=(p:ReportProduct)=>p.aiReading?.route==='review'?'待复核':p.aiReading?.route==='observe'?'观察':p.aiReading?'已分析':'初筛入选'
  const filters=['全部',...new Set(r.items.map(status))]
  const rows=r.items.filter(p=>(filter==='全部'||status(p)===filter)&&(p.title+' '+p.id).toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="erp-list"><header className="selection-controls"><div>{filters.map(f=><button key={f} aria-pressed={filter===f} onClick={()=>{setFilter(f);setPage(0)}}>{f} {f==='全部'?r.items.length:r.items.filter(p=>status(p)===f).length}</button>)}</div><input aria-label="搜索入选商品" placeholder="搜索商品名称或编号" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/></header>
  <div className="selection-columns"><span>商品 / 来源</span><span>累计销量</span><span>Amazon 报价</span><span>判断 / 入选依据</span></div>
  {rows.slice(page*25,page*25+25).map(p=>{
    const prices=(p.amazonPriceScreen?.candidates ?? p.amazonComparison?.candidates ?? []).flatMap(c=>c.price!=null && c.price>0?[c.price]:[])
    const note=(p.reason||p.selectionBasis).split('〕').at(-1)?.trim()||p.selectionBasis
    return <details key={p.id}><summary className="selection-line"><div className="identity">{p.thumbnail ? <img src={p.thumbnail} alt="" referrerPolicy="no-referrer"/> : <span className="erp-thumb">商品</span>}<div><b title={p.title}>{p.title}</b><small>{p.id.startsWith('amazon:')?'Amazon':'Temu'} · 美国站</small></div></div>
    <strong className="sold"><i>累计销量 </i>{amount(p.sold)}</strong><strong className="quote"><i>Amazon </i>{prices.length?money(Math.min(...prices)):'待核价'}</strong>
    <div className="judgement"><em data-review={status(p)==='待复核'}>{status(p)}</em><span title={note}>{note}</span></div><span className="chev">›</span></summary><ProductEvidence p={p} r={r}/></details>
  })}{!rows.length && <p>没有匹配的商品</p>}{rows.length>25 && <div className="erp-pages"><button disabled={!page} onClick={()=>setPage(page-1)}>上一页</button> {page+1} / {Math.ceil(rows.length/25)} <button disabled={(page+1)*25>=rows.length} onClick={()=>setPage(page+1)}>下一页</button></div>}</section>
}
function ReportView({ r, related }: { r: AdminReport; related?: AdminReport }) {
  const selection = r.kind === 'selection'
  return (
    <div className={selection?'rp selection-sheet':'rp'}>
      <div className="rp-nav">
        <BackLink href={archiveUrl} label="返回管理员日报档案" />
        {related && (
          <PageLink className="rp-other" href={detailUrl(related)}>
            查看同轮{names[related.kind]} <ArrowRight size={15} />
          </PageLink>
        )}
      </div>
      <header className="rp-heading">
        <div>
          <span className="rp-kicker">
            <CalendarDays size={14} />
            {r.day}
          </span>
          <h1>{names[r.kind]}</h1>
          <p>{scopeLabel(r)}</p>
        </div>
      </header>
      {selection && <SelectionOverview r={r} />}
      {selection && r.expansion && <section className="rp-chart erp-summary"><h2>Amazon 扩筛 · {r.expansion.day}</h2>
        <p>{r.expansion.seeds} 款来源商品 → {r.expansion.hits} 条检索结果 → 去重后 {r.expansion.unique} 个 ASIN，取得 {r.expansion.priced} 个有效报价。</p>
        <p>低于 $4：{r.expansion.low} 款　·　$4 至不足 $6：{r.expansion.middle} 款</p>
        {!!r.expansion.shortlist.length && <details><summary>查看低于 $6 的价格候选</summary>
        {r.expansion.shortlist.map(c=><div className="rp-screen-row" key={c.asin}><a href={'https://www.amazon.com/dp/'+c.asin} target="_blank" rel="noreferrer" title={c.title}>{c.title}</a><b>{money(c.price)}</b></div>)}
        </details>}<small>按商品价初筛，运费另计。是否同款及 Haul 归属需核实。</small></section>}
      {!selection && <Summary r={r} />}
      <div className="rp-section-title">
        <div>
          <span className="rp-kicker">{selection ? '筛选明细' : '逐件复核'}</span>
          <h2>
            {selection ? '入选商品' : '跟进商品'} <small>{amount(r.items.length)} 件</small>
          </h2>
        </div>
        {selection && (
          <span className="rp-caption">
            {amount(r.items.filter((p) => p.researchId).length)} 件已关联研究
          </span>
        )}
      </div>
      {selection && r.items.length ? <SelectionList key={r.runId} r={r}/> : r.items.length ? (
        <div className={'rp-products ' + (selection ? 'selection' : 'tracking')}>
          {r.items.map((p) => (
            <ProductEvidence p={p} r={r} key={p.id} />
          ))}
        </div>
      ) : (
        <Empty title="本次没有商品明细" />
      )}
      <footer className="rp-receipt">
        <div>
          <CircleCheck size={17} />
          <span>
            已归档 · {date(r.createdAt, true)}（北京） · {r.actor}
          </span>
        </div>
        <div>
          本轮用量 <ReportCost report={r} />
        </div>
        <PageLink href={taskUrl(r.runId)}>
          查看来源任务 <ArrowUpRight size={14} />
        </PageLink>
      </footer>
    </div>
  )
}
function ReportCard({ r }: { r: AdminReport }) {
  const selection = r.kind === 'selection',
    change = totalChange(r)
  const max = Math.max(1, change.before, change.after)
  return (
    <article className={'archive-card rp-cover ' + (selection ? 'selection' : 'tracking')}>
      <header>
        <span>
          {selection ? <ScanSearch size={18} /> : <ChartNoAxesColumn size={18} />} {r.day}
        </span>
        <h3>
          <PageLink href={detailUrl(r)}>{names[r.kind]}</PageLink>
        </h3>
      </header>
      {selection ? (
        <div className="rp-cover-chart">
          <p>
            <b>{amount(r.matched)}</b> 件符合条件 <small>共检查 {amount(r.examined)} 件</small>
          </p>
          <OutcomeBand r={r} />
        </div>
      ) : (
        <div className="rp-cover-chart">
          <Bar
            label={shortDay(r.previousDay)}
            value={change.count ? change.before : null}
            max={max}
            prior
          />
          <Bar label={shortDay(r.day)} value={change.count ? change.after : null} max={max} />
          <small>两日均有观测的 {change.count} 件商品合计日销量</small>
        </div>
      )}
      <footer>
        <ReportCost report={r} />
        <PageLink href={detailUrl(r)}>
          查看{names[r.kind]} <ArrowRight size={15} />
        </PageLink>
      </footer>
    </article>
  )
}
export function AdminReports() {
  const { params } = useLocation(),
    archive = useData<{ reports: AdminReport[]; latestRun: string | null }>('/admin-reports'),
    create = useWrite<unknown>()
  const reports = archive.data?.reports ?? [],
    latest = archive.data?.latestRun,
    run = params.get('run'),
    kind = params.get('kind') || 'selection'
  const generated =
    latest &&
    ['selection', 'tracking'].every((k) => reports.some((r) => r.kind === k && r.runId === latest))
  if (archive.isPending) return <Loading />
  if (archive.isError)
    return (
      <>
        <BackLink href="/daily" label="返回选品日报" />
        <ErrorBox error={archive.error} retry={() => void archive.refetch()} />
      </>
    )
  if (run) {
    const r = reports.find((row) => row.runId === run && row.kind === kind)
    return r ? (
      <ReportView
        key={run + kind}
        r={r}
        related={reports.find((row) => row.runId === run && row.kind !== kind)}
      />
    ) : (
      <>
        <BackLink href={archiveUrl} label="返回管理员日报档案" />
        <Empty title="未找到这份归档日报" />
      </>
    )
  }
  return (
    <div className="rp">
      <div className="rp-nav">
        <BackLink href="/daily" label="返回选品日报" />
      </div>
      <header className="rp-heading">
        <div>
          <span className="rp-kicker">
            <Files size={15} /> 报告中心
          </span>
          <h1>管理员日报档案</h1>
          <p>查看每轮选品结果，比较跟进商品的两天销量。</p>
        </div>
      </header>
      {reports.length ? (
        <div className="rp-library">
          {reports.map((r) => (
            <ReportCard key={r.runId + r.kind} r={r} />
          ))}
        </div>
      ) : (
        <Empty title="尚无归档日报" detail="完成一轮在线调查后，可以在这里生成并保存报告。" />
      )}
      <section className="rp-generate">
        <div>
          <h2>生成两份日报</h2>
          <p>按最近一轮调查生成选品日报，另查最多两件商品做跟进。两件详情通常共用 20 积分。</p>
          {latest ? (
            <PageLink href={taskUrl(latest)}>
              查看本轮来源任务 <ArrowUpRight size={14} />
            </PageLink>
          ) : (
            <small>暂无可生成日报的发现任务。</small>
          )}
        </div>
        <button
          type="button"
          className="primary"
          disabled={!latest || !!generated || create.isPending || archive.isFetching}
          onClick={() => latest && create.mutate({ path: '/admin-reports', body: { runId: latest } })}
        >
          {create.isPending
            ? '正在核对并保存…'
            : generated
              ? '本轮两份日报已保存'
              : '查询并生成两份日报'}
        </button>
      </section>
      {create.isSuccess && <Notice success>本轮两份日报已保存。</Notice>}
      <ErrorBox error={create.error} />
    </div>
  )
}
import { useState } from 'react'
