import { CalendarDays, ClipboardCheck, FileText, ListFilter, RefreshCw } from 'lucide-react'
import type { DailyReport } from '../../../packages/operations/daily'
import { AdminReports } from './admin-reports'
import { Metric } from './catalog'
import { platforms, selectionLabels, statusLabels } from './models'
import {
  amount,
  Badge,
  Empty,
  ErrorBox,
  Loading,
  PageLink,
  Pager,
  Panel,
  productUrl,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
} from './ui'
import './daily.css'

const outcomeLabels = {
  ...selectionLabels,
  unrated: '报告未记录明确结论',
  triage: '仅有分流结果',
  pending: '研究尚无报告',
  unlinked: '未关联研究',
}
function reportStatus(s: DailyReport['summary']) {
  if (!s.liveRuns) return '当天没有在线发现任务。'
  if (!s.searchedRuns) return '已创建发现任务，尚未取得筛选记录。'
  if (!s.selected) return '已取得的筛选结果中没有达标商品。'
  if (!s.linked) return '入选商品尚未关联 AI 研究。'
  if (!s.reports) return '已关联研究，尚无完成的单品报告。'
  if (!s.recommended) return '已有单品研究报告，尚无明确推荐跟进的商品。'
  return '共有 ' + amount(s.recommended) + ' 件商品获得 AI 推荐，可在下方查看逐件理由。'
}
const taskUrl = (id: string) => '/tasks?id=' + encodeURIComponent(id)

export function Daily() {
  const { admin, session } = useAccess()
  const { params } = useLocation()
  if (!session) return <Loading />
  if (admin && params.get('view') === 'preview') return <AdminReports />
  return <DailySummary admin={admin} />
}
function DailySummary({ admin }: { admin: boolean }) {
  const { params } = useLocation()
  const go = useGo()
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const day = params.get('date') || today
  const view = params.get('view') === 'recommended' ? 'recommended' : 'all'
  const query = new URLSearchParams({ date: day, view })
  for (const k of ['page', 'pageSize']) if (params.has(k)) query.set(k, params.get(k)!)
  const result = useData<DailyReport>('/daily?' + query)
  const report = result.data
  const returnUrl = '/daily?' + query
  function update(next: Record<string, string>) {
    const q = new URLSearchParams(query)
    q.delete('page')
    for (const [k, v] of Object.entries(next)) q.set(k, v)
    go('/daily?' + q)
  }
  return (
    <>
      <Title
        eyebrow="DAILY SELECTION"
        title="选品日报"
        desc="查看当天筛出的商品、AI 的跟进建议和每件商品的理由。"
      >
        {admin && <PageLink className="btn" href="/daily?view=preview">管理员日报档案</PageLink>}
        <label className="daily-date">
          报告日期
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && update({ date: e.target.value })}
          />
        </label>
        <button type="button" onClick={() => update({ date: today })} disabled={day === today}>
          今天
        </button>
        <button
          type="button"
          className="icon"
          aria-label="刷新日报"
          disabled={result.isFetching}
          onClick={() => void result.refetch()}
        >
          <RefreshCw />
        </button>
      </Title>
      {result.isPending ? (
        <Loading />
      ) : result.isError ? (
        <ErrorBox error={result.error} retry={() => void result.refetch()} />
      ) : (
        report && (
          <>
            <div className="metrics">
              <Metric
                icon={CalendarDays}
                label="在线发现任务"
                value={amount(report.summary.liveRuns)}
                sub={amount(report.summary.searchedRuns) + ' 个已取得筛选记录'}
              />
              <Metric
                icon={ListFilter}
                label="入选商品"
                value={amount(report.summary.selected)}
                sub="按商品去重"
              />
              <Metric
                icon={FileText}
                label="已有单品报告"
                value={amount(report.summary.reports)}
                sub={amount(report.summary.linked) + ' 件已关联研究'}
              />
              <Metric
                icon={ClipboardCheck}
                label="AI 推荐跟进"
                value={amount(report.summary.recommended)}
                sub="有明确结论与理由"
              />
            </div>
            <Panel
              title="当日选品结果"
              extra={
                report.summary.latestRun && (
                  <PageLink href={taskUrl(report.summary.latestRun)}>查看最近的发现任务</PageLink>
                )
              }
            >
              <div className="daily-summary">
                <strong>{reportStatus(report.summary)}</strong>
                <p>
                  按发现任务创建时的北京时间归日，包含成员自定义的在线发现任务。同一商品每天列一次，商品信息取最近一次入选。
                  每份明确推荐的单品报告计一次，多个任务复用同一报告只计一次。独立推荐越多越靠前，达到 3 次标记为「优先考虑」。
                </p>
              </div>
              {!!report.summary.selected && (
                <fieldset className="tabs daily-tabs" aria-label="商品范围">
                  {(
                    [
                      ['all', '全部入选', report.summary.selected],
                      ['recommended', '只看 AI 推荐', report.summary.recommended],
                    ] as const
                  ).map(([id, label, count]) => (
                    <button
                      type="button"
                      key={id}
                      className={view === id ? 'active' : ''}
                      aria-pressed={view === id}
                      onClick={() => update({ view: id })}
                    >
                      {label} · {amount(count)}
                    </button>
                  ))}
                </fieldset>
              )}
              {report.items.length ? (
                <div className="table-scroll">
                  <table className="daily-table">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>入选时累计销量</th>
                        <th>AI 结论与理由</th>
                        <th>对应任务</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.items.map((item) => {
                        const [platform, market, id] = item.productId.split(':')
                        return (
                          <tr key={item.productId}>
                            <td>
                              <PageLink
                                className="daily-product"
                                href={productUrl(item.productId, returnUrl)}
                              >
                                {item.title || item.productId}
                              </PageLink>
                              <small>
                                {platforms[platform] || platform} · {market} · {id}
                              </small>
                            </td>
                            <td>
                              {amount(item.totalSold)}
                              {item.tier > 0 && <small>累计销量至少 {amount(item.tier)} 件</small>}
                            </td>
                            <td>
                              <Badge tone={item.outcome === 'recommend' ? 'teal' : 'neutral'}>
                                {outcomeLabels[item.outcome]}
                              </Badge>
                              <small>独立推荐 {amount(item.independentRecommendations)} 次</small>
                              {item.independentRecommendations >= 3 && <Badge tone="amber">优先考虑</Badge>}
                              {item.reason && <p className="daily-reason">{item.reason}</p>}
                              {item.researchStatus && ['pending', 'triage'].includes(item.outcome) && (
                                <small>
                                  研究任务{statusLabels[item.researchStatus] || item.researchStatus}
                                </small>
                              )}
                            </td>
                            <td>
                              <PageLink href={taskUrl(item.discoveryId)}>发现任务</PageLink>
                              <small>当日入选 {amount(item.occurrences)} 次</small>
                              {item.researchId && (
                                <PageLink href={taskUrl(item.researchId)}>
                                  {item.researchDiscoveryId && item.researchDiscoveryId !== item.discoveryId
                                    ? '较早入选的研究'
                                    : item.reused ? '复用的研究' : '单品研究'}
                                </PageLink>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    view === 'recommended' && report.summary.selected
                      ? '推荐名单暂无商品'
                      : '暂无入选商品记录'
                  }
                />
              )}
              {report.total > 0 && (
                <Pager
                  total={report.total}
                  page={report.page}
                  size={report.pageSize}
                  onPage={(n) => update({ page: String(n) })}
                  onSize={(n) => update({ pageSize: String(n) })}
                />
              )}
            </Panel>
          </>
        )
      )}
    </>
  )
}
