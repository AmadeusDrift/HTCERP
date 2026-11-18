import {
  Boxes,
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  Layers3,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useState } from 'react'
import type {
  PerformanceSkuList,
  SalesDay,
  SalesSummary,
  StoreSales,
} from '../../../packages/store-sales/report'
import { Metric } from './catalog'
import { Select } from './select'
import {
  amount,
  Badge,
  Empty,
  ErrorBox,
  Loading,
  money,
  Notice,
  PageLink,
  Panel,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
  useWrite,
} from './ui'

const usd = (cents: number | null | undefined) => money(cents == null ? null : cents / 100)
const percent = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—')
const knownAmount = (summary?: SalesSummary) =>
  usd(summary?.review.missingAmount && summary.cents === 0 ? null : summary?.cents)
const performanceUrl = (date: string, simulation: boolean) =>
  '/performance?' + (simulation ? 'view=preview&' : '') + 'date=' + date

function Totals({
  summary,
  listingsPending,
  simulation,
}: {
  summary?: SalesSummary
  listingsPending: boolean
  simulation: boolean
}) {
  return (
    <section className="metrics sales-metrics" aria-label="团队汇总">
      <Metric
        label="团队销量"
        value={amount(summary?.units)}
        sub={simulation ? '按出单件数累计' : '订单原始数量 · 试算'}
        icon={Boxes}
      />
      <Metric
        label={summary?.review.missingAmount ? '已知销售额（部分）' : '已知销售额'}
        value={knownAmount(summary)}
        sub={
          summary?.review.missingAmount
            ? summary.review.missingAmount + ' 行金额待补'
            : simulation
              ? '模拟金额 · USD'
              : '接口金额分项试算 · USD'
        }
        icon={CircleDollarSign}
      />
      <Metric
        label="新增刊登"
        value={listingsPending ? '—' : amount(summary?.newListings)}
        sub={listingsPending ? '刊登数据尚未接入' : '子体与独立商品'}
        icon={Layers3}
      />
      <Metric
        label="待核对销售行"
        value={amount(summary?.review.lines)}
        sub="缺 SKU 或成交金额"
        icon={ClipboardList}
      />
    </section>
  )
}

function HotProducts({ day }: { day?: SalesDay }) {
  const [operator, setOperator] = useState('*')
  const [order, setOrder] = useState('units')
  const rows = (day?.products ?? [])
    .filter((p) => operator === '*' || (p.operator ?? '') === operator)
    .sort(
      (a, b) =>
        (order === 'units' ? b.units - a.units : (b.cents ?? -1) - (a.cents ?? -1)) ||
        a.title.localeCompare(b.title, 'zh-CN'),
    )
  return (
    <Panel title="昨日热销商品" extra={<span className="sales-tag">按 SKU 排名</span>}>
      <div className="sales-filters">
        <Select
          aria-label="筛选运营"
          variant="filter"
          prefix="运营"
          disabled={!day}
          value={operator}
          onValueChange={setOperator}
          options={[
            { value: '*', label: '全部' },
            ...(day?.operators ?? []).map(({ name }) => ({
              value: name ?? '',
              label: name ?? '待归属',
            })),
          ]}
        />
        <Select
          aria-label="热销排序"
          variant="filter"
          prefix="排序"
          disabled={!day}
          value={order}
          onValueChange={setOrder}
          options={[
            { value: 'units', label: '销量从高到低' },
            { value: 'amount', label: '销售额从高到低' },
          ]}
        />
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="sales-table">
            <thead>
              <tr>
                {['排名', '商品 / SKU', '运营', '销量', '销售额'].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.sku}>
                  <td>
                    <span className="sales-rank">{index + 1}</span>
                  </td>
                  <td>
                    <b className="product-title-preview" title={row.title}>
                      {row.title}
                    </b>
                    <small>{row.sku}</small>
                  </td>
                  <td>{row.operator ?? '待归属'}</td>
                  <td>{amount(row.units)}</td>
                  <td>{usd(row.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="暂无热销排名"
          detail={
            day
              ? '所选运营当天没有可排名的商品。'
              : '店铺订单按美西经营日入库后，即可按运营查看昨日排行。'
          }
        />
      )}
      {day && (
        <p className="sales-footnote">
          缺 SKU 的销售行计入团队汇总，并在业绩表单列。金额待补的商品显示为「—」。
        </p>
      )}
    </Panel>
  )
}

function History({ days, simulation }: { days: SalesDay[]; simulation: boolean }) {
  return (
    <Panel title="历史销售" extra={<span className="sales-tag">近 7 个美西经营日</span>}>
      {days.length ? (
        <div className="table-scroll">
          <table className="sales-table">
            <thead>
              <tr>
                <th>经营日</th>
                <th>销量</th>
                <th>已知销售额</th>
                <th>业绩表</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date}>
                  <th scope="row">
                    {day.date}
                    {day.coverage === 'partial' && <small>同步未完整</small>}
                  </th>
                  <td>{amount(day.team.units)}</td>
                  <td>
                    {knownAmount(day.team)}
                    {day.team.review.missingAmount > 0 && <small>部分金额待补</small>}
                  </td>
                  <td>
                    <PageLink href={performanceUrl(day.date, simulation)}>
                      {simulation ? '查看样张' : '查看业绩'}
                    </PageLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="暂无历史销售记录" detail="同步当前店铺订单后，这里会按天显示销量和已知销售额。" />
      )}
    </Panel>
  )
}

function Performance({
  day,
  admin,
  listingsPending,
}: {
  day?: SalesDay
  admin: boolean
  listingsPending: boolean
}) {
  const s = day?.team
  return (
    <>
      <Panel title="团队备货占比" extra={<span className="sales-tag">Haul 订单 · 按商品行统计</span>}>
        {s ? (
          <div className="table-scroll">
            <table className="sales-table">
              <thead>
                <tr>
                  <th>备货类型</th>
                  <th>销量</th>
                  <th>销量占比</th>
                  <th>已知销售额</th>
                  <th>已知销售额占比</th>
                </tr>
              </thead>
              <tbody>
                {(['jit', 'standard'] as const).map((group) => (
                  <tr key={group}>
                    <th scope="row">{group === 'jit' ? 'JIT' : '标准备货'}</th>
                    <td>{amount(s[group].units)}</td>
                    <td>{percent(s[group].units, s.jit.units + s.standard.units)}</td>
                    <td>{usd(s[group].cents)}</td>
                    <td>{percent(s[group].cents, s.jit.cents + s.standard.cents)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">待核对</th>
                  <td>{amount(s.review.units)}</td>
                  <td>—</td>
                  <td>
                    {usd(s.review.missingAmount && s.review.cents === 0 ? null : s.review.cents)}
                    （已知部分）
                  </td>
                  <td>—</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="暂无团队业绩" detail="该经营日还没有可汇总的店铺订单。" />
        )}
        <p className="sales-footnote">
          {s && (
            <>
              占比分母为 {s.jit.units + s.standard.units} 件、{usd(s.jit.cents + s.standard.cents)}。
            </>
          )}
          缺 SKU 或缺金额的销售行排除在两项占比之外。
        </p>
      </Panel>
      <Panel
        title={admin ? '运营业绩' : '我的业绩'}
        extra={<span className="sales-tag">{admin ? '管理员可查看全部' : '仅本人明细'}</span>}
      >
        {day && day.operators.length > 0 ? (
          <div className="table-scroll">
            <table className="sales-table">
              <thead>
                <tr>
                  {[
                    '运营',
                    '销量',
                    '已知销售额',
                    'JIT 件数 / 金额',
                    '标准件数 / 金额',
                    '新增刊登',
                    '待核对销售行',
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {day.operators.map(({ name, summary }) => (
                  <tr key={name ?? 'unassigned'}>
                    <th scope="row">{name ?? '待归属'}</th>
                    <td>{summary.units}</td>
                    <td>
                      {knownAmount(summary)}
                      {summary.review.missingAmount > 0 && (
                        <small>{summary.review.missingAmount} 行金额待补</small>
                      )}
                    </td>
                    <td>
                      {summary.jit.units} / {usd(summary.jit.cents)}
                    </td>
                    <td>
                      {summary.standard.units} / {usd(summary.standard.cents)}
                    </td>
                    <td>{listingsPending ? '—' : summary.newListings}</td>
                    <td>{summary.review.lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="暂无已归属业绩"
            detail={
              admin
                ? '该经营日还没有可展示的运营业绩。'
                : '该经营日暂无归属到你账号的订单；由管理员核对 SKU 负责人后会自动更新。'
            }
          />
        )}
        {s && (
          <p className="sales-footnote">
            {listingsPending ? (
              '刊登数据尚未接入，新增刊登显示为「—」。'
            ) : (
              <>另有 {s.unknownListings} 条刊登关系待核对。父体不计入新增刊登。</>
            )}
          </p>
        )}
      </Panel>
    </>
  )
}

function Quality({ day }: { day?: SalesDay }) {
  if (!day?.quality) return null
  return (
    <Panel title="数据待核对" extra={<span className="sales-tag">{day.date} · 团队订单</span>}>
      <dl className="sales-quality">
        <div>
          <dt>待归属件数</dt>
          <dd>{amount(day.quality.unassignedUnits)}</dd>
        </div>
        <div>
          <dt>已取消件数</dt>
          <dd>{amount(day.quality.cancelledUnits)}</dd>
        </div>
        <div>
          <dt>缺 SKU 件数</dt>
          <dd>{amount(day.quality.missingSkuUnits)}</dd>
        </div>
      </dl>
      <p className="sales-footnote">
        取消订单暂保留原始数量；缺 SKU 的数量计入团队汇总。各项可能重叠，不能相加。
      </p>
    </Panel>
  )
}

function Rules({ simulation }: { simulation: boolean }) {
  return (
    <details className="sales-rules">
      <summary>{simulation ? '查看样张统计口径' : '查看试算口径（待确认）'}</summary>
      {simulation ? (
        <p>样张使用虚构订单与刊登，销量保留原始出单数量，金额按样张中的商品成交金额加运费计算。</p>
      ) : (
        <>
          <p>
            Amazon
            对照导出及最终日期口径尚未确认。当前以订单下单时间按美西日历日归集，以下数字为试算结果。
          </p>
          <p>销量保留订单原始数量，包含后来取消的订单；退款暂未扣减，取消与退款的最终处理方式待确认。</p>
          <p>
            金额暂按接口中的商品金额加运费、减折扣试算；含税或税费排除方式仍待核对。缺金额的订单不视为零金额，汇总仅计入已知部分。
          </p>
          <p>
            当前负责人应用于历史订单；修改 SKU 负责人会重新归集已展示的历史业绩，历史归属口径待确认。
          </p>
        </>
      )}
      <p>
        SKU 含 {simulation ? 'JIT' : 'JIT 或 J1T'}（忽略大小写）的行计入 JIT，其余有效 SKU
        计入标准备货。混合订单分行统计。
      </p>
    </details>
  )
}

const syncLabels = {
  not_configured: '店铺连接待完成',
  idle: '等待首次同步',
  queued: '等待同步',
  running: '正在同步订单',
  complete: '订单同步完成',
  failed: '订单同步中断',
}
const westTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))

function SyncStatus({ sync, admin }: { sync?: StoreSales['sync']; admin: boolean }) {
  const mutation = useWrite<{ id: string; status: string }>()
  const status = sync?.status ?? 'idle'
  const busy = mutation.isPending || status === 'queued' || status === 'running'
  return (
    <div className="sales-sync">
      <div className="sales-sync-main">
        <div>
          <Badge
            tone={
              status === 'failed' ? 'red' : busy ? 'blue' : status === 'complete' ? 'teal' : 'neutral'
            }
          >
            {syncLabels[status]}
          </Badge>
          {sync && (
            <span>
              已读取 {amount(sync.pages)} 页 · {amount(sync.lines)} 行订单
            </span>
          )}
        </div>
        {admin && (
          <button
            type="button"
            disabled={busy || status === 'not_configured'}
            onClick={() => mutation.mutate({ path: '/store-sales/sync', body: {} })}
          >
            <RefreshCw size={15} className={busy ? 'spin' : undefined} />
            {mutation.isPending
              ? '正在提交同步…'
              : status === 'queued' || status === 'running'
                ? syncLabels[status]
                : '同步当前店铺订单'}
          </button>
        )}
      </div>
      {status === 'not_configured' ? (
        <p>请由管理员在设置中完成当前店铺的 Amazon 连接。</p>
      ) : (
        <p>
          受 Amazon 接口额度影响，首次补齐近 7 天订单可能需要数小时。同步期间每 15
          秒刷新进度，未完成的经营日仅展示已读取部分。
        </p>
      )}
      {(sync?.coverageFrom || sync?.through || sync?.updatedAt) && (
        <p className="sales-sync-times">
          {sync.coverageFrom && sync.through && (
            <span>
              已覆盖 {westTime(sync.coverageFrom)} 至 {westTime(sync.through)}（美西）
            </span>
          )}
          {sync.updatedAt && <span>最近更新 {westTime(sync.updatedAt)}（美西）</span>}
        </p>
      )}
      {status === 'failed' && <ErrorBox error={sync?.error || '同步暂时中断，请稍后重新同步。'} />}
      <ErrorBox error={mutation.error} />
    </div>
  )
}

function OwnerRow({
  item,
  accounts,
}: {
  item: PerformanceSkuList['items'][number]
  accounts: PerformanceSkuList['accounts']
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const mutation = useWrite(() => {
    setDraft(null)
    setNotice('已保存')
  })
  const selected = draft ?? item.accountId ?? ''
  function save(accountId: string | null) {
    setNotice('')
    mutation.mutate({ path: '/store-sales/owner', body: { sku: item.sku, accountId } })
  }
  return (
    <tr>
      <td>
        <b className="product-title-preview" title={item.title}>
          {item.title}
        </b>
        <small>{item.sku}</small>
      </td>
      <td>{amount(item.units)}</td>
      <td>
        {item.operator ?? '待归属'}
        <small>
          {item.source === 'manual'
            ? '手工指定'
            : item.source === 'rule'
              ? '规则匹配'
              : item.accountId
                ? '已有归属'
                : '尚未匹配负责人'}
        </small>
      </td>
      <td>
        <Select
          variant="compact"
          aria-label={item.sku + ' 的负责人'}
          value={selected}
          disabled={mutation.isPending || !accounts.length}
          onValueChange={(value) => {
            setDraft(value)
            setNotice('')
            mutation.reset()
          }}
          options={[
            { value: '', label: accounts.length ? '请选择负责人' : '暂无可用账号', disabled: true },
            ...accounts.map((account) => ({ value: account.id, label: account.name })),
          ]}
        />
      </td>
      <td className="sales-owner-actions">
        <div>
          <button
            type="button"
            disabled={
              mutation.isPending ||
              !selected ||
              (selected === item.accountId && item.source === 'manual')
            }
            onClick={() => save(selected)}
          >
            {mutation.isPending ? '正在保存…' : '保存负责人'}
          </button>
          {item.source === 'manual' && (
            <button
              type="button"
              className="linkbtn"
              disabled={mutation.isPending}
              onClick={() => save(null)}
            >
              恢复规则匹配
            </button>
          )}
        </div>
        {notice && (
          <small role="status" className="sales-saved">
            {notice}
          </small>
        )}
        <ErrorBox error={mutation.error} />
      </td>
    </tr>
  )
}

function OwnerManager() {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const result = useData<PerformanceSkuList>('/store-sales/skus?q=' + encodeURIComponent(query))
  return (
    <Panel title="SKU 负责人" extra={<span className="sales-tag">当前店铺</span>}>
      <p className="sales-owner-note">
        仅显示当前店铺已同步订单中的
        SKU，并非完整刊登清单。手工指定优先于规则；恢复规则匹配后，有命中规则的 SKU
        会重新归属，未命中则待归属。
      </p>
      <form
        className="sales-owner-search"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <input
          aria-label="搜索订单 SKU"
          placeholder="输入订单 SKU"
          maxLength={128}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">
          <Search size={15} />
          搜索
        </button>
        {result.data && (
          <span>
            显示 {amount(result.data.items.length)} / {amount(result.data.total)} 个 SKU
            {result.data.total > result.data.items.length ? ' · 最多显示 100 个，请搜索缩小范围' : ''}
          </span>
        )}
      </form>
      {result.isPending ? (
        <Loading />
      ) : result.isError ? (
        <div className="panel-body">
          <ErrorBox error={result.error} retry={() => void result.refetch()} />
        </div>
      ) : result.data.items.length ? (
        <div className="table-scroll">
          <table className="sales-table sales-owner-table">
            <thead>
              <tr>
                {['商品 / SKU', '已同步件数', '当前负责人', '指定负责人', '操作'].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((item) => (
                <OwnerRow key={item.sku} item={item} accounts={result.data.accounts} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="没有匹配的订单 SKU"
          detail={query ? '请尝试其他 SKU 关键词。' : '请先同步当前店铺订单，再设置 SKU 负责人。'}
        />
      )}
      <p className="sales-footnote">负责人调整会应用于已展示的历史订单。新增刊登数据尚未接入。</p>
    </Panel>
  )
}

function SalesPage({ home }: { home: boolean }) {
  const { admin, session } = useAccess()
  const { path, params } = useLocation()
  const go = useGo()
  const [ownersOpen, setOwnersOpen] = useState(false)
  const preview = admin && params.get('view') === 'preview'
  const result = useData<StoreSales>(
    '/store-sales' + (preview ? '?view=preview' : ''),
    !!session,
    preview ? false : 15_000,
  )
  const report = result.data
  const simulation = preview && report?.source === 'simulation'
  const days = report?.days ?? []
  const day = home
    ? days.find((d) => d.date === report?.yesterday)
    : (days.find((d) => d.date === params.get('date')) ?? days[0])
  const listingsPending = !simulation && report?.listingsStatus === 'pending'
  return (
    <div className="store-sales">
      <Title
        eyebrow={home ? 'STORE OVERVIEW' : 'TEAM PERFORMANCE'}
        title={home ? '首页' : '业绩表'}
        desc={
          home ? '查看自家 Haul 店铺的昨日热销商品和历史销售。' : '按美西经营日查看团队汇总和运营业绩。'
        }
      >
        {admin && (
          <PageLink className="btn" href={preview ? path : path + '?view=preview'}>
            {preview ? '返回店铺数据' : '查看模拟样张'}
          </PageLink>
        )}
        {home && admin && (
          <PageLink className="btn" href="/daily?view=preview">
            管理员日报档案
          </PageLink>
        )}
      </Title>
      {result.isPending ? (
        <Loading />
      ) : result.isError ? (
        <ErrorBox error={result.error} retry={() => void result.refetch()} />
      ) : (
        <>
          <div className={'sales-status' + (simulation ? ' simulated' : '')}>
            <CalendarDays size={19} />
            <div>
              <strong>{simulation ? '管理员模拟样张' : '当前店铺 · 美国站 Haul'}</strong>
              <p>
                {simulation
                  ? '以下数字来自虚构订单和刊登，仅供核对计算口径与排版。'
                  : '统计口径待确认 · 当前为订单试算数据，金额、取消退款与历史归属仍需对照 Amazon 导出核对。'}
              </p>
            </div>
            <Badge tone={simulation ? 'amber' : 'neutral'}>
              {day?.date ?? report?.yesterday} · 美西
            </Badge>
          </div>
          {!simulation && <SyncStatus sync={report?.sync} admin={admin} />}
          {!home && days.length > 0 && (
            <div className="sales-day-picker">
              <Select
                variant="filter"
                prefix="经营日"
                aria-label="业绩经营日"
                value={day?.date}
                options={days.map((d) => ({ value: d.date, label: d.date }))}
                onValueChange={(date) => go(performanceUrl(date, !!simulation))}
              />
            </div>
          )}
          {day?.coverage === 'partial' && (
            <Notice>该经营日尚未同步完整，以下为已读取订单的试算结果。</Notice>
          )}
          <Totals summary={day?.team} listingsPending={listingsPending} simulation={!!simulation} />
          {home ? (
            <>
              <HotProducts key={preview ? 'preview' : 'store'} day={day} />
              <History days={days} simulation={!!simulation} />
            </>
          ) : (
            <Performance day={day} admin={admin} listingsPending={listingsPending} />
          )}
          {!simulation && <Quality day={day} />}
          {!simulation && admin && (
            <div className="sales-owner-manager">
              <button
                type="button"
                aria-expanded={ownersOpen}
                aria-controls="sales-owners"
                onClick={() => setOwnersOpen(!ownersOpen)}
              >
                管理 SKU 负责人
              </button>
              {ownersOpen && (
                <div id="sales-owners">
                  <OwnerManager />
                </div>
              )}
            </div>
          )}
          <Rules simulation={!!simulation} />
        </>
      )}
    </div>
  )
}

export const StoreHome = () => <SalesPage home />
export const StorePerformance = () => <SalesPage home={false} />
