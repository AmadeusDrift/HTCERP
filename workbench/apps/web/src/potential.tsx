import { useState } from 'react'
import {
  gradeLabels,
  type PotentialGrade,
  type PotentialResult,
} from '../../../packages/operations/potential'
import { Select } from './select'
import {
  amount,
  Badge,
  date,
  Empty,
  ErrorBox,
  Loading,
  money,
  PageLink,
  Pager,
  Panel,
  productUrl,
  Title,
  Thumb,
  useAccess,
  useData,
  useGo,
  useLocation,
  useWrite,
} from './ui'

const reasons: Record<PotentialGrade, string> = {
  priority: '最近一天销量高于前六天日均，值得优先复核。',
  watch: '近七天有销量，最近一天尚未高于前六天日均。',
  hold: '最近一期完整七天的销量为零。',
  unknown: '暂缺可比的完整七天销量，或最近数据已超过七天。',
  undated: '最近 30 天首次收录，上架日期待核。',
}

export function Potential() {
  const { params, url } = useLocation()
  const go = useGo()
  const { edit } = useAccess()
  const grade = params.get('grade') || ''
  const result = useData<PotentialResult>('/potential?' + params)
  const [requestId] = useState(() => crypto.randomUUID())
  const run = useWrite<{ id: string }>((job) => go('/tasks?id=' + encodeURIComponent(job.id)))
  function change(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (key !== 'page') next.delete('page')
    if (value) next.set(key, value)
    else next.delete(key)
    go('/potential?' + next)
  }
  return (
    <>
      <Title
        eyebrow="PRODUCT DISCOVERY"
        title="潜力新品"
        desc="团队默认预设 · Temu 美国站家居 · 最低展示价不超过 4 美元 · 近 30 天上架"
      >
        <PageLink className="btn" href="/settings?tab=schedule">
          调度与预算
        </PageLink>
        {edit && (
          <button
            type="button"
            className="primary"
            disabled={run.isPending}
            onClick={() =>
              run.mutate({
                path: '/jobs',
                body: {
                  kind: 'discovery',
                  requestId,
                  inputs: { mode: 'live', preset: 'potential', goal: '团队默认 · 潜力新品' },
                },
              })
            }
          >
            {run.isPending ? '正在创建任务…' : '在线寻找新品'}
          </button>
        )}
      </Title>
      <ErrorBox error={run.error} />
      <Panel>
        <div className="potential-filters">
          <Select
            aria-label="评级范围"
            value={grade}
            onValueChange={(v) => change('grade', v)}
            options={[
              { value: '', label: '全部评级' },
              ...Object.entries(gradeLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
            <Select
              aria-label="商品类目"
              value={params.get('category') || ''}
              onValueChange={(v) => change('category', v)}
              options={[
                { value: '', label: '全部商品类目' },
                ...(result.data?.categories ?? []).map((value) => ({ value, label: value })),
              ]}
            />
        </div>
        <p className="potential-hint">按近七天销量表现自动评级。</p>
        {result.isPending ? (
          <Loading />
        ) : result.isError ? (
          <ErrorBox error={result.error} retry={() => void result.refetch()} />
        ) : !result.data.total ? (
          <Empty
            title="当前范围暂无商品"
            detail="新商品入库后会自动评估，也可以切换评级查看其他结果。"
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="daily-table potential-table">
                <thead>
                  <tr>
                    <th>商品与类目</th>
                    <th>价格 / 上架日期</th>
                    <th>日销量 / 近七天销量</th>
                    <th>评级与理由</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <PageLink className="potential-item" href={productUrl(p.id, url)} title={p.title}>
                          <Thumb p={p}/>
                          <span className="potential-copy"><b>{p.title}</b><small>{p.category.split(' / ').at(-1)}</small></span>
                        </PageLink>
                      </td>
                      <td>
                        <span className="potential-label">最低展示价</span>{money(p.price)}
                        <small>{date(p.listed)}</small>
                      </td>
                      <td>
                        <span className="potential-label">日销量 / 近七天销量</span>{amount(p.daySold)} / {amount(p.weekSold)}
                        <small>数据日期 {date(p.observed)}</small>
                      </td>
                      <td>
                        <Badge tone={p.grade === 'priority' ? 'teal' : 'neutral'}>
                          {gradeLabels[p.grade]}
                        </Badge>
                        <small>{reasons[p.grade]}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              total={result.data.total}
              page={result.data.page}
              size={result.data.pageSize}
              onPage={(v) => change('page', String(v))}
              onSize={(v) => change('pageSize', String(v))}
            />
          </>
        )}
      </Panel>
    </>
  )
}
