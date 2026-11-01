import { Boxes, CalendarDays, CircleDollarSign, ClipboardList, Layers3 } from 'lucide-react'
import { useState } from 'react'
import type { SalesDay, SalesSummary, StoreSales } from '../../../packages/store-sales/report'
import { Metric } from './catalog'
import { Select } from './select'
import {
  amount,
  Badge,
  Empty,
  ErrorBox,
  Loading,
  money,
  PageLink,
  Panel,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
} from './ui'

const usd = (cents: number | null | undefined) => money(cents == null ? null : cents / 100)
const percent = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—')

function Totals({ summary }: { summary?: SalesSummary }) {
  return (
    <section className="metrics sales-metrics" aria-label="团队汇总">
      <Metric label="团队销量" value={amount(summary?.units)} sub="按出单件数累计" icon={Boxes} />
      <Metric
        label="已知销售额"
        value={usd(summary?.cents)}
        sub={
          summary?.review.missingAmount
            ? summary.review.missingAmount + ' 行金额待补'
            : '折后含运费 · USD'
        }
        icon={CircleDollarSign}
      />
      <Metric
        label="新增刊登"
        value={amount(summary?.newListings)}
        sub="子体与独立商品"
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

function History({ days }: { days: SalesDay[] }) {
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
                  <th scope="row">{day.date}</th>
                  <td>{amount(day.team.units)}</td>
                  <td>{usd(day.team.cents)}</td>
                  <td>
                    <PageLink href={'/performance?view=preview&date=' + day.date}>查看样张</PageLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="暂无历史销售记录" detail="整日订单完成对账后，这里会按天显示销量和销售额。" />
      )}
    </Panel>
  )
}

function Performance({ day, admin }: { day?: SalesDay; admin: boolean }) {
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
                  <th>销售额</th>
                  <th>销售额占比</th>
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
                  <td>{usd(s.review.cents)}（已知）</td>
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
        {day && admin ? (
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
                    <td>{usd(summary.cents)}</td>
                    <td>
                      {summary.jit.units} / {usd(summary.jit.cents)}
                    </td>
                    <td>
                      {summary.standard.units} / {usd(summary.standard.cents)}
                    </td>
                    <td>{summary.newListings}</td>
                    <td>{summary.review.lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="暂无已归属业绩"
            detail="运营员工码待提供。完成账号与 SKU 映射后，可查看本人业绩。"
          />
        )}
        {s && (
          <p className="sales-footnote">
            另有 {s.unknownListings} 条刊登关系待核对。父体不计入新增刊登。
          </p>
        )}
      </Panel>
      <details className="sales-rules">
        <summary>查看统计口径</summary>
        <p>
          销量按 Haul
          订单出单件数统计，后续取消、退货或退款不回改。销售额取折后成交金额加运费，排除税费，暂不扣减退款。
        </p>
        <p>SKU 含 JIT（忽略大小写）的行计入 JIT，其余有效 SKU 计入标准备货。混合订单分行统计。</p>
      </details>
    </>
  )
}

function SalesPage({ home }: { home: boolean }) {
  const { admin, session } = useAccess()
  const { path, params } = useLocation()
  const go = useGo()
  const preview = admin && params.get('view') === 'preview'
  const result = useData<StoreSales>('/store-sales' + (preview ? '?view=preview' : ''), !!session)
  const report = result.data
  const simulation = preview && report?.source === 'simulation'
  const days = simulation ? report.days : []
  const day = (!home && days.find((d) => d.date === params.get('date'))) || days[0]
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
              <strong>{simulation ? '管理员模拟样张' : '自家店铺 · 等待完整数据'}</strong>
              <p>
                {simulation
                  ? '以下数字来自虚构订单和刊登，仅供核对计算口径与排版。'
                  : '当前仅完成店铺接口字段抽样，整日订单与刊登尚未入库。'}
              </p>
            </div>
            <Badge tone={simulation ? 'amber' : 'neutral'}>
              {day?.date ?? report?.yesterday} · 美西
            </Badge>
          </div>
          {!home && simulation && (
            <div className="sales-day-picker">
              <Select
                variant="filter"
                prefix="经营日"
                aria-label="业绩经营日"
                value={day?.date}
                options={days.map((d) => ({ value: d.date, label: d.date }))}
                onValueChange={(date) => go('/performance?view=preview&date=' + date)}
              />
            </div>
          )}
          <Totals summary={day?.team} />
          {home ? (
            <>
              <HotProducts key={preview ? 'preview' : 'store'} day={day} />
              <History days={days} />
            </>
          ) : (
            <Performance day={day} admin={admin} />
          )}
        </>
      )}
    </div>
  )
}

export const StoreHome = () => <SalesPage home />
export const StorePerformance = () => <SalesPage home={false} />
