import {
  ArrowDownWideNarrow,
  ArrowRight,
  Bookmark,
  Boxes,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Columns3,
  Database,
  Filter,
  GalleryVerticalEnd,
  Grid2X2,
  Layers3,
  List,
  ListFilter,
  type LucideIcon,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Table2,
} from 'lucide-react'
import { useState } from 'react'
import {
  lines,
  type Meta,
  type PageResult,
  type Product,
  platforms,
  type Stage,
  type Strategy,
  strategyCatalogFilters,
  stages,
  tierNames,
} from './models'
import { PresetsDialog, usePersonal } from './personal'
import { platformIcons } from './platform-icons'
import { Select, selectOptions } from './select'
import {
  amount,
  usePhoneScreen,
  Dialog,
  date,
  Empty,
  ErrorBox,
  Field,
  Form,
  Loading,
  money,
  PageLink,
  Pager,
  Panel,
  Platform,
  productUrl,
  SearchForm,
  StageBadge,
  Thumb,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
  useWrite,
} from './ui'

export function CandidateForm({ p, close }: { p: Product; close: () => void }) {
  const [stage, setStage] = useState<Stage>(p.stage || 'candidate'),
    [tags, setTags] = useState<string[]>(p.lines || []),
    [note, setNote] = useState(p.note || '')
  const mutation = useWrite(close),
    { edit } = useAccess()
  return (
    <Dialog title={p.stage ? '更新跟进记录' : '加入候选与观察池'} onClose={close}>
      <Form
        className="dialog-body stack"
        onSubmit={() =>
          mutation.mutate({
            path: '/products/' + encodeURIComponent(p.id) + '/candidate',
            body: { stage, lines: tags, note: note.trim() },
          })
        }
      >
        <div className="selected-product">
          <Thumb p={p} />
          <div>
            <b>{p.title_cn || p.title}</b>
            <small>
              {platforms[p.platform]} · {p.external_id}
            </small>
          </div>
        </div>
        <Field label="跟进阶段">
          <Select
            value={stage}
            onValueChange={(value) => setStage(value as Stage)}
            options={selectOptions(stages)}
          />
        </Field>
        <fieldset>
          <legend>机会类型</legend>
          <div className="inline">
            {Object.entries(lines).map(([k, v]) => (
              <label className="check" key={k}>
                <input
                  type="checkbox"
                  checked={tags.includes(k)}
                  onChange={(e) =>
                    setTags(e.target.checked ? [...tags, k] : tags.filter((t) => t !== k))
                  }
                />
                {v}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="运营备注" hint="意见将与操作者、阶段和时间一并保存。">
          <textarea
            rows={4}
            maxLength={500}
            placeholder="记录入池理由、规格差异或下次核验事项…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!edit || mutation.isPending}>
            <Check size={15} />
            保存记录
          </button>
        </div>
      </Form>
    </Dialog>
  )
}
export function Metric({
  label,
  value,
  sub,
  icon: Icon,
  children,
}: {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  children?: React.ReactNode
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Icon size={16} />
      </div>
      <strong>{value}</strong>
      {children || <small>{sub}</small>}
    </div>
  )
}
function useFilters() {
  const { path, params, url } = useLocation(),
    go = useGo()
  function update(updates: Record<string, string | null>, reset = true) {
    const next = new URLSearchParams(params)
    if (reset) next.delete('page')
    for (const [k, v] of Object.entries(updates)) {
      if (!v) next.delete(k)
      else next.set(k, v)
    }
    go(path + (next.size ? '?' + next : ''))
  }
  return { params, url, update, clear: () => go(path) }
}
function SelectFilter({
  label,
  value,
  options,
  change,
}: {
  label: string
  value: string
  options: Record<string, string>
  change: (v: string) => void
}) {
  return (
    <Select
      variant="filter"
      prefix={label}
      aria-label={label}
      value={value}
      onValueChange={change}
      options={selectOptions({ '': '全部', ...options })}
    />
  )
}
const advancedFields = [
  ['minPrice', '最低价（USD）'],
  ['maxPrice', '价格上限（USD）'],
  ['minSold', '累计销量至少'],
  ['maxSold', '累计销量上限'],
  ['minDaySold', '日销量下限'],
  ['maxDaySold', '日销量上限'],
  ['minWeekSold', '近 7 日销量下限'],
  ['maxWeekSold', '近 7 日销量上限'],
  ['minMonthSold', '近 30 日销量下限'],
  ['maxMonthSold', '近 30 日销量上限'],
  ['updatedFrom', '更新起始日期'],
  ['updatedTo', '更新截止日期'],
] as const
export function Discovery() {
  const { params, url, update, clear } = useFilters(),
    { edit } = useAccess()
  const go = useGo()
  const phone = usePhoneScreen()
  const personal = usePersonal()
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [showOverview, setShowOverview] = useState(false)
  const strategy = useData<Strategy>('/strategy')
  const [more, setMore] = useState(false),
    [pick, setPick] = useState<Product | null>(null)
  const page = Number(params.get('page') || 1),
    size = Number(params.get('pageSize') ?? personal.data?.pageSize ?? 50),
    grid = (params.get('view') ?? personal.data?.view) === 'grid'
  const apiParams = new URLSearchParams(params)
  const sortKey = params.get('sort') || (phone ? 'updated_at' : 'total_sold')
  apiParams.set('sort', sortKey)
  apiParams.delete('view')
  apiParams.set('page', String(page))
  apiParams.set('pageSize', String(size))
  const meta = useData<Meta>('/catalog/meta'),
    result = useData<PageResult<Product>>(
      '/products?' + apiParams,
      !!params.get('pageSize') || !personal.isPending,
    )
  const data = meta.data,
    counts = data?.tiers.find((t) => t.tier === '50k')?.count
  const active = Array.from(params).filter(
    ([k]) => !['page', 'pageSize', 'view', 'sort', 'order'].includes(k),
  ).length
  const categories = Object.fromEntries(
    (data?.categories || [])
      .filter((c) => !params.get('platform') || !c.platform || c.platform === params.get('platform'))
      .map((c) => [c.value, c.label]),
  )
  const select = (key: string) => (v: string) => update({ [key]: v })
  const order = params.get('order') || 'desc'
  function sort(k: string) {
    update({ sort: k, order: sortKey === k && order === 'desc' ? 'asc' : 'desc' })
  }
  function applyStrategy() {
    const settings = strategy.data?.settings
    if (!settings) return
    const next = strategyCatalogFilters(settings)
    if (params.has('view')) next.set('view', params.get('view')!)
    if (params.has('pageSize')) next.set('pageSize', String(size))
    go('/?' + next)
  }
  return (
    <>
      <Title
        eyebrow="PRODUCT DISCOVERY"
        title={phone ? "商品动态" : "发现商品"}
        desc={phone ? "查看商品最近更新、销量和价格。" : "按平台、价格和销量找商品。打开详情查看趋势、规格和评论，再决定是否跟进。"}
      >
        {phone ? <PageLink className="btn" href="/daily">查看选品日报 <ArrowRight size={15} /></PageLink> : <>
        <PageLink className="btn" href="/research?kind=discovery">
          <ListFilter />
          新建发现任务
        </PageLink>
        <PageLink className="btn primary" href="/research">
          <Plus />
          新建研究
        </PageLink>
        </>}
      </Title>
      <button type="button" className="mobile-overview" aria-expanded={showOverview}
        aria-controls="catalog-overview" onClick={() => setShowOverview(!showOverview)}>
        商品库概况 <span>{showOverview ? '收起' : '展开'}</span>
      </button>
      <div id="catalog-overview" className="metrics">
        <Metric label="商品库" value={amount(data?.total)} icon={Database}>
          <div className="source-band" title="商品来源分布">
            {data?.platforms.map((p) => (
              <i
                key={p.platform}
                className={p.platform}
                style={{ width: (p.count / data.total) * 100 + '%' }}
              />
            ))}
          </div>
          <small>{data ? data.platforms.length : '—'} 个来源平台</small>
        </Metric>
        <Metric
          label="高累计销量商品"
          value={amount(counts)}
          icon={Layers3}
          sub="累计销量至少 50,000 件"
        />
        <Metric
          label="有历史记录"
          value={amount(data?.historyProducts)}
          icon={ChartNoAxesCombined}
          sub="可查看历史价格或销量的商品"
        />
        <Metric label="候选与观察" value={amount(data?.candidates)} icon={Bookmark}>
          <PageLink className="metric-link" href="/candidates">
            查看跟进记录 <ArrowRight size={12} />
          </PageLink>
        </Metric>
      </div>
      <ErrorBox error={meta.error} retry={() => void meta.refetch()} />
      <div className="section-heading">
        <div>
          <h2>商品目录</h2>
          <span className="subtle-pill">美国站 · US</span>
        </div>
        <div className="inline">
          <button type="button" className="linkbtn" onClick={() => setPresetsOpen(true)}>
            <Bookmark size={14} /> 我的预设
          </button>
          <button
            type="button"
            className="linkbtn"
            disabled={!strategy.data}
            onClick={applyStrategy}
            title="用已发布策略筛选库内商品"
          >
            应用当前策略
          </button>
        </div>
      </div>
      {phone && <nav aria-label="数据流排序" className="feed-sorts">
        {[['updated_at', '最近更新'], ['day_sold', '日销量最高'], ['week_sold', '近七日热销']].map(([key, label]) => (
          <button key={key} type="button" aria-pressed={sortKey === key && order === 'desc'}
            onClick={() => update({ sort: key, order: 'desc' })}>{label}</button>
        ))}
      </nav>}
      <Panel className="catalog-panel">
        <section className="source-tabs" aria-label="来源平台">
          <button
            type="button"
            className={!params.get('platform') ? 'active' : ''}
            aria-pressed={!params.get('platform')}
            onClick={() => update({ platform: null, category: null })}
          >
            <Boxes />
            全部平台 <em>{amount(data?.total)}</em>
          </button>
          {(data?.platforms || [])
            .slice()
            .sort((a, b) => b.count - a.count)
            .map((p) => (
              <button
                type="button"
                key={p.platform}
                className={params.get('platform') === p.platform ? 'active' : ''}
                aria-pressed={params.get('platform') === p.platform}
                onClick={() => update({ platform: p.platform, category: null })}
              >
                <Platform id={p.platform} />
                <em>{amount(p.count)}</em>
              </button>
            ))}
        </section>
        <div className="catalog-toolbar">
          <SearchForm value={params.get('q') || ''} onSearch={select('q')} />
          <div className="segmented view-toggle">
            <button
              type="button"
              aria-label="表格视图"
              aria-pressed={!grid}
              className={!grid ? 'selected' : ''}
              onClick={() => update({ view: 'table' }, false)}
            >
              <List />
            </button>
            <button
              type="button"
              aria-label="网格视图"
              aria-pressed={grid}
              className={grid ? 'selected' : ''}
              onClick={() => update({ view: 'grid' }, false)}
            >
              <Grid2X2 />
            </button>
          </div>
          <div className="catalog-filters">
            <SelectFilter
              label="类目"
              value={params.get('category') || ''}
              options={categories}
              change={select('category')}
            />
            <SelectFilter
              label="累计销量"
              value={params.get('tier') || ''}
              options={tierNames}
              change={select('tier')}
            />
            <button type="button" onClick={() => setMore(true)} className={active ? 'accent-outline' : ''}>
              <SlidersHorizontal />
              更多筛选{active > 0 && <em>{active}</em>}
            </button>
          </div>
        </div>
        {advancedFields.some(([k]) => params.has(k)) && (
          <div className="applied-filters">
            {advancedFields
              .filter(([k]) => params.has(k))
              .map(([k, label]) => (
                <button
                  type="button"
                  key={k}
                  title={'移除' + label}
                  onClick={() => update({ [k]: null })}
                >
                  {label} {params.get(k)} <span aria-hidden="true">×</span>
                </button>
              ))}
          </div>
        )}
        <div className="result-bar">
          <span>
            <span role="status" aria-live="polite">{result.isFetching ? '正在筛选…' : result.data ? amount(result.data.total) + ' 件商品' : '暂未取得结果'}</span>
            {active > 0 && (
              <button type="button" className="linkbtn" onClick={clear}>
                <RotateCcw size={12} />
                清除筛选
              </button>
            )}
          </span>
          <Select
            variant="quiet"
            prefix={<ArrowDownWideNarrow size={14} />}
            aria-label="排序"
            value={sortKey + ':' + order}
            onValueChange={(value) => {
              const [s, o] = value.split(':')
              update({ sort: s, order: o })
            }}
            options={[
              ['total_sold', '累计销量'],
              ['min_price', '价格'],
              ['day_sold', '日销'],
              ['week_sold', '近 7 日销量'],
              ['month_sold', '近 30 日销量'],
              ['updated_at', '更新时间'],
            ].flatMap(([k, label]) =>
              ['desc', 'asc'].map((o) => ({
                value: k + ':' + o,
                label: label + ' · ' + (o === 'desc' ? '降序' : '升序'),
              })),
            )}
          />
        </div>
        {result.isPending ? (
          <Loading />
        ) : result.isError ? (
          <ErrorBox error={result.error} retry={() => void result.refetch()} />
        ) : !result.data.items.length ? (
          <Empty title="没有符合条件的商品" detail="调整平台、类目或销量范围后重新筛选。">
            <button type="button" onClick={clear}>
              清除筛选
            </button>
          </Empty>
        ) : grid ? (
          <div className="product-grid">
            {result.data.items.map((p) => (
              <div className="product-card" key={p.id}>
                <PageLink href={productUrl(p.id, url)}>
                  <Thumb p={p} big />
                </PageLink>
                <div className="card-body">
                  <div className="spread">
                    <Platform id={p.platform} />
                    <StageBadge stage={p.stage} />
                  </div>
                  <PageLink className="product-name" href={productUrl(p.id, url)}>
                    {p.title_cn || p.title}
                  </PageLink>
                  <div className="spread">
                    <b>{money(p.min_price, p.currency || 'USD')}</b>
                    <small>累计 {amount(p.total_sold)}</small>
                  </div>
                  <div className="spread">
                    <small>{date(p.updated_at)}</small>
                    <button
                      type="button"
                      className="linkbtn"
                      disabled={!edit}
                      onClick={() => setPick(p)}
                    >
                      <Bookmark size={13} />
                      {p.stage ? '更新' : '入池'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="products-table">
              <thead>
                <tr>
                  <th className="product-platform-col" scope="col">
                    平台
                  </th>
                  <th scope="col">商品信息</th>
                  <th className="num">
                    <button type="button" onClick={() => sort('min_price')}>
                      价格 <ChevronDown />
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" onClick={() => sort('total_sold')}>
                      累计销量 <ChevronDown />
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" onClick={() => sort('day_sold')}>
                      日销 <ChevronDown />
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" onClick={() => sort('month_sold')}>
                      近 30 日 <ChevronDown />
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => sort('updated_at')}>
                      更新时间 <ChevronDown />
                    </button>
                  </th>
                  <th>跟进状态</th>
                  <th aria-label="操作"></th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="product-platform-col">
                      {platformIcons.has(p.platform) ? (
                        <img
                          className="product-platform-icon"
                          src={platformIcons.get(p.platform)}
                          alt={platforms[p.platform]}
                          title={platforms[p.platform]}
                          width={28}
                          height={28}
                        />
                      ) : (
                        <span title={p.platform}>—</span>
                      )}
                    </td>
                    <td>
                      <PageLink className="product-cell" href={productUrl(p.id, url)}>
                        <Thumb p={p} />
                        <div>
                          <b title={p.title_cn || p.title}>{p.title_cn || p.title}</b>
                          <small>{p.external_id}</small>
                        </div>
                      </PageLink>
                    </td>
                    <td className="num" data-label="价格">{money(p.min_price, p.currency || 'USD')}</td>
                    <td className="num sold" data-label="累计销量">{amount(p.total_sold)}</td>
                    <td className="num" data-label="日销">{amount(p.day_sold)}</td>
                    <td className="num" data-label="近 30 日">{amount(p.month_sold)}</td>
                    <td className="date-cell" data-label="更新">{date(p.updated_at)}</td>
                    <td>
                      <StageBadge stage={p.stage} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon row-btn"
                        disabled={!edit}
                        aria-label={'记录 ' + (p.title_cn || p.title)}
                        title="记录候选或观察"
                        onClick={() => setPick(p)}
                      >
                        <Bookmark size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.data && (
          <Pager
            total={result.data.total}
            page={page}
            size={size}
            onPage={(n) => update({ page: String(n) }, false)}
            onSize={(n) => update({ pageSize: String(n) })}
          />
        )}
      </Panel>
      <div className="page-foot">
        <span>更新时间按北京时间显示</span>
        <span>缺失字段以「—」表示</span>
      </div>
      {pick && <CandidateForm p={pick} close={() => setPick(null)} />}
      {presetsOpen && (
        <PresetsDialog
          params={params}
          close={() => setPresetsOpen(false)}
          apply={(filters) => {
            const next = new URLSearchParams(filters)
            for (const key of ['view', 'pageSize']) if (params.has(key)) next.set(key, params.get(key)!)
            go('/' + (next.size ? '?' + next : ''))
            setPresetsOpen(false)
          }}
        />
      )}
      {more && (
        <AdvancedFilters
          params={params}
          close={() => setMore(false)}
          save={(values) => {
            update(values)
            setMore(false)
          }}
        />
      )}
    </>
  )
}
function AdvancedFilters({
  params,
  save,
  close,
}: {
  params: URLSearchParams
  save: (v: Record<string, string>) => void
  close: () => void
}) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(params)),
    [err, setErr] = useState('')
  const set = (k: string, v: string) => setF({ ...f, [k]: v })
  return (
    <Dialog title="更多筛选" onClose={close}>
      <Form
        className="dialog-body stack"
        onSubmit={() => {
          if (
            (f.minPrice && f.maxPrice && +f.minPrice > +f.maxPrice) ||
            (f.minSold && f.maxSold && +f.minSold > +f.maxSold) ||
            (f.updatedFrom && f.updatedTo && f.updatedFrom > f.updatedTo)
          ) {
            setErr('请让起始值小于或等于结束值。')
            return
          }
          save(
            Object.fromEntries(
              [...advancedFields.map(([k]) => k), 'completeness', 'stage'].map((k) => [k, f[k] || '']),
            ),
          )
        }}
      >
        <div className="fields-2">
          {advancedFields.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type={key.startsWith('updated') ? 'date' : 'number'}
                min={0}
                step={key.includes('Price') ? '0.01' : '1'}
                value={f[key] || ''}
                onChange={(e) => set(key, e.target.value)}
                placeholder="不限"
              />
            </Field>
          ))}
          <Field label="数据完整度">
            <Select
              value={f.completeness || ''}
              onValueChange={(value) => set('completeness', value)}
              options={selectOptions({ '': '全部', complete: '核心字段齐全', partial: '部分字段缺失' })}
            />
          </Field>
          <Field label="跟进阶段">
            <Select
              value={f.stage || ''}
              onValueChange={(value) => set('stage', value)}
              options={selectOptions({ '': '全部', ...stages })}
            />
          </Field>
        </div>
        <ErrorBox error={err} />
        <div className="dialog-actions">
          <button type="button" onClick={() => setF({})}>
            重置条件
          </button>
          <button type="submit" className="primary">
            <Filter size={14} />
            应用筛选
          </button>
        </div>
      </Form>
    </Dialog>
  )
}
export function Candidates() {
  const { params, url, update, clear } = useFilters(),
    { edit } = useAccess(),
    [pick, setPick] = useState<Product | null>(null)
  const page = Number(params.get('page') || 1),
    size = Number(params.get('pageSize') || 20),
    board = params.get('view') !== 'list'
  const query = new URLSearchParams(params)
  query.delete('view')
  query.set('pageSize', String(size))
  const list = useData<PageResult<Product>>('/candidates?' + query)
  return (
    <>
      <Title
        eyebrow="CANDIDATE PIPELINE"
        title="候选与观察池"
        desc="按跟进阶段查看已选商品，记录为什么看好、还要核对什么。"
      >
        <PageLink className="btn primary" href="/">
          <Plus />
          从商品库选择
        </PageLink>
      </Title>
      <Panel>
        <div className="catalog-toolbar">
          <SearchForm
            value={params.get('q') || ''}
            onSearch={(q) => update({ q })}
            placeholder="搜索候选商品或商品 ID"
          />
          <div className="segmented view-toggle">
            <button
              type="button"
              aria-pressed={board}
              aria-label="看板视图"
              className={board ? 'selected' : ''}
              onClick={() => update({ view: null }, false)}
            >
              <Columns3 />
            </button>
            <button
              type="button"
              aria-pressed={!board}
              aria-label="列表视图"
              className={!board ? 'selected' : ''}
              onClick={() => update({ view: 'list' }, false)}
            >
              <Table2 />
            </button>
          </div>
          <div className="catalog-filters">
            <SelectFilter
              label="平台"
              value={params.get('platform') || ''}
              options={platforms}
              change={(platform) => update({ platform })}
            />
            <SelectFilter
              label="阶段"
              value={params.get('stage') || ''}
              options={stages}
              change={(stage) => update({ stage })}
            />
            <SelectFilter
              label="机会"
              value={params.get('line') || ''}
              options={lines}
              change={(line) => update({ line })}
            />
          </div>
        </div>
      </Panel>
      <div className="section-heading">
        <div>
          <h2>跟进工作区</h2>
          <span className="subtle-pill">{amount(list.data?.total)} 件</span>
        </div>
        {params.size > 0 && (
          <button type="button" className="linkbtn" onClick={clear}>
            重置视图
          </button>
        )}
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorBox error={list.error} retry={() => void list.refetch()} />
      ) : (
        <>
          {board ? (
            <div className="board">
              {(Object.entries(stages) as [Stage, string][])
                .filter(([k]) => !params.get('stage') || params.get('stage') === k)
                .map(([k, v]) => {
                  const batch = list.data.items.filter((p) => p.stage === k)
                  return (
                    <section key={k} className={'lane lane-' + k}>
                      <header>
                        <h3>
                          <i />
                          {v}
                        </h3>
                        <span className="count" title="当前页数量">
                          {batch.length}
                        </span>
                      </header>
                      {batch.length ? (
                        batch.map((p) => (
                          <article className="board-card" key={p.id}>
                            <div className="spread">
                              <Platform id={p.platform} />
                              <small>{date(p.feedback_at)}</small>
                            </div>
                            <PageLink href={productUrl(p.id, url)} className="product-cell">
                              <Thumb p={p} />
                              <b>{p.title_cn || p.title}</b>
                            </PageLink>
                            <p>{p.note || '待补充入池理由'}</p>
                            <div className="spread">
                              <small>
                                {p.lines.map((l) => lines[l] || l).join(' · ') || '机会待判定'}
                              </small>
                              <button
                                type="button"
                                className="linkbtn"
                                disabled={!edit}
                                onClick={() => setPick(p)}
                              >
                                更新
                              </button>
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="lane-empty">
                          <GalleryVerticalEnd size={20} />
                          <span>本页暂无{v}商品</span>
                        </div>
                      )}
                    </section>
                  )
                })}
            </div>
          ) : (
            <Panel>
              {!list.data.items.length ? (
                <Empty title="暂无候选记录" detail="在发现商品页选择商品并记录跟进阶段。">
                  <PageLink className="btn" href="/">
                    发现商品
                  </PageLink>
                </Empty>
              ) : (
                <div className="table-scroll">
                  <table className="candidate-list">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>阶段</th>
                        <th>机会类型</th>
                        <th>运营备注</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.items.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <PageLink className="product-cell" href={productUrl(p.id, url)}>
                              <Thumb p={p} />
                              <b>{p.title_cn || p.title}</b>
                            </PageLink>
                          </td>
                          <td>
                            <StageBadge stage={p.stage} />
                          </td>
                          <td>{p.lines.map((l) => lines[l]).join(' / ') || '待补充'}</td>
                          <td>{p.note || '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="linkbtn"
                              disabled={!edit}
                              onClick={() => setPick(p)}
                            >
                              更新记录
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}
          <Pager
            total={list.data.total}
            page={page}
            size={size}
            onPage={(n) => update({ page: String(n) }, false)}
            onSize={(n) => update({ pageSize: String(n) })}
          />
        </>
      )}
      {pick && <CandidateForm p={pick} close={() => setPick(null)} />}
    </>
  )
}
