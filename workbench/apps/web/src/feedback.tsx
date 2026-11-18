import { useQuery } from '@tanstack/react-query'
import { Clipboard, FileText, MessageSquareWarning, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { stateNames, states } from '../../../packages/weekly-feedback/model'
import type { FeedbackRow, FeedbackRun } from '../../../packages/weekly-feedback/report'
import { ConnectionCredentials } from './connection-credentials'
import {
  Badge,
  date,
  Empty,
  ErrorBox,
  PageLink,
  request,
  SearchForm,
  Thumb,
  useAccess,
  useData,
  useLocation,
  useWrite,
} from './ui'
import './feedback.css'

type Report = {
  store: { seller: string } | null
  enabled: boolean
  notifyEnabled: boolean
  schedule: string
  run: FeedbackRun | null
  runs: FeedbackRun[]
  rows: FeedbackRow[]
  total: number
  page: number
  stats: {
    skus: number
    asins: number
    issues: number
    parents: number
    unresolved: number
    noData: number
    failed: number
  } | null
  exclusions: { sku: string; asin: string | null; title: string; role: string }[]
  members: { id: string; name: string }[]
  deliveries: {
    account_id: string
    name: string
    status: string
    error: string | null
    updated_at: string
  }[]
}
type Draft = { ready: boolean; sent: boolean; unassigned: number; text: string; reason: string }
const runNames: Record<string, string> = {
  running: '正在汇总',
  done: '汇总完成',
  partial: '部分完成',
  failed: '生成失败',
}
const deliveryNames: Record<string, string> = {
  preparing: '准备中',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  unknown: '结果待核实',
}

function AssignSku({
  assignment,
  members,
  run,
}: {
  assignment: FeedbackRow['assignments'][number]
  members: Report['members']
  run: string
}) {
  const [accountId, setAccountId] = useState(assignment.accountId ?? ''),
    write = useWrite()
  return (
    <div className="feedback-assignment">
      <label>
        {assignment.sku}
        <select
          aria-label={'负责运营 · ' + assignment.sku}
          value={accountId}
          disabled={write.isPending}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">待分配</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={write.isPending || accountId === (assignment.accountId ?? '')}
        onClick={() =>
          write.mutate({
            path: '/weekly-feedback/assign',
            body: { run, sku: assignment.sku, accountId: accountId || null },
          })
        }
      >
        保存归属
      </button>
      {write.error && <ErrorBox error={write.error} />}
    </div>
  )
}
function WecomMember({ member }: { member: { id: string; name: string; userid: string | null } }) {
  const [userid, setUserid] = useState(member.userid ?? ''),
    [saved, setSaved] = useState(false),
    write = useWrite()
  return (
    <div className="feedback-member">
      <label>
        {member.name}
        <input
          aria-label={'企业微信 UserID · ' + member.name}
          value={userid}
          maxLength={64}
          placeholder="企业微信通讯录中的成员 UserID"
          onChange={(e) => {
            setUserid(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <button
        type="button"
        disabled={write.isPending}
        onClick={() =>
          write.mutate(
            { path: '/weekly-feedback/wecom-member', body: { accountId: member.id, userid } },
            { onSuccess: () => setSaved(true) },
          )
        }
      >
        保存成员绑定
      </button>
      {saved && <span role="status">成员绑定已保存</span>}
      {write.error && <ErrorBox error={write.error} />}
    </div>
  )
}
function WecomSettings({ notifyEnabled }: { notifyEnabled: boolean }) {
  const settings = useData<{
    configured: boolean
    credentialEditing: boolean
    members: { id: string; name: string; userid: string | null }[]
  }>('/weekly-feedback/wecom')
  const write = useWrite<{ message?: string }>(),
    [message, setMessage] = useState('')
  return (
    <section className="panel feedback-draft">
      <h2>运营与企业微信设置</h2>
      <p>负责运营使用 ERP 成员账号；通知使用企业微信自建应用，按成员 UserID 定向发送。</p>
      {settings.data && (
        <>
          <div className="actions">
            <Badge tone={settings.data.configured ? 'teal' : 'amber'}>
              {settings.data.configured ? '应用凭据已配置' : '应用凭据待配置'}
            </Badge>
            <ConnectionCredentials
              provider="wecom"
              configured={settings.data.configured}
              available={settings.data.credentialEditing}
              onSaved={() => void settings.refetch()}
            />
            <button
              type="button"
              disabled={!settings.data.configured || write.isPending}
              onClick={() =>
                write.mutate(
                  { path: '/weekly-feedback/wecom-test', body: {} },
                  { onSuccess: (result) => setMessage(result.message ?? '连接已验证') },
                )
              }
            >
              验证企业微信连接
            </button>
          </div>
          <label className="feedback-toggle">
            <input
              type="checkbox"
              checked={notifyEnabled}
              disabled={!settings.data.configured || write.isPending}
              onChange={(e) =>
                write.mutate({
                  path: '/weekly-feedback/notify-settings',
                  body: { enabled: e.target.checked },
                })
              }
            />
            周报完成后自动通知负责运营
          </label>
          {settings.data.members.map((member) => (
            <WecomMember key={member.id} member={member} />
          ))}
          {!settings.data.members.length && <p>请先在成员管理中创建运营账号。</p>}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {settings.error && <ErrorBox error={settings.error} />}
      {write.error && <ErrorBox error={write.error} />}
    </section>
  )
}

function TopicHandling({
  row,
  topic,
  run,
}: {
  row: FeedbackRow
  topic: FeedbackRow['topics'][number]
  run: string
}) {
  const { edit } = useAccess(),
    write = useWrite()
  const [state, setState] = useState(topic.handling.state),
    [note, setNote] = useState(topic.handling.note),
    [saved, setSaved] = useState(false)
  return (
    <section className="feedback-topic">
      <div className="feedback-topic-heading">
        <h3>
          {topic.label} <span>{topic.name}</span>
        </h3>
        <Badge tone="amber">
          {topic.mentions === null ? '提及次数未提供' : '提及 ' + topic.mentions + ' 次'}
        </Badge>
      </div>
      <p className="feedback-metrics">
        {topic.occurrence != null && <span>主题占比 {topic.occurrence}%</span>}
        {topic.impact != null && <span>评分影响 {topic.impact}</span>}
        <span>统计区间内数据</span>
      </p>
      {topic.snippets.length ? (
        <div className="feedback-evidence">
          <b>代表性评论摘录</b>
          {topic.snippets.map((snippet) => (
            <blockquote key={snippet}>{snippet}</blockquote>
          ))}
        </div>
      ) : (
        <p className="muted">Amazon 未提供该主题的代表性摘录。</p>
      )}
      <p className="feedback-suggestion">
        <b>建议核查：</b>
        {topic.action}
      </p>
      <div className="feedback-handling">
        <label>
          处理状态
          <select
            aria-label={'处理状态 · ' + topic.name}
            value={state}
            disabled={!edit || write.isPending}
            onChange={(e) => {
              setState(e.target.value)
              setSaved(false)
            }}
          >
            {states.map((value) => (
              <option value={value} key={value}>
                {stateNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="feedback-note">
          处理备注
          <textarea
            aria-label={'处理备注 · ' + topic.name}
            value={note}
            maxLength={2000}
            disabled={!edit || write.isPending}
            placeholder="记录核查结果、改进动作和验证情况"
            onChange={(e) => {
              setNote(e.target.value)
              setSaved(false)
            }}
          />
        </label>
        {edit && (
          <button
            type="button"
            className="btn"
            disabled={write.isPending}
            onClick={() =>
              write.mutate(
                {
                  path: '/weekly-feedback/action',
                  body: { run, asin: row.asin, topic: topic.name, state, note },
                },
                { onSuccess: () => setSaved(true) },
              )
            }
          >
            {write.isPending ? '保存中…' : '保存处理记录'}
          </button>
        )}
      </div>
      {saved && <p role="status">处理记录已保存</p>}
      {topic.handling.updated_at && (
        <p className="muted">最近处理：{date(topic.handling.updated_at, true)}</p>
      )}
      {write.error && <ErrorBox error={write.error} />}
    </section>
  )
}

export function FeedbackCenter() {
  const { params } = useLocation(),
    { admin, edit } = useAccess()
  const [runId, setRunId] = useState(params.get('run') ?? ''),
    [q, setQ] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(0),
    [owner, setOwner] = useState(params.get('owner') ?? ''),
    [configure, setConfigure] = useState(false),
    [notifyMessage, setNotifyMessage] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null),
    [draftLoading, setDraftLoading] = useState(false),
    [draftError, setDraftError] = useState(''),
    [copied, setCopied] = useState(false)
  const query = new URLSearchParams({ run: runId, q, status, owner, page: String(page) })
  const reportPath = '/weekly-feedback?' + query
  const list = useQuery<Report>({
      queryKey: [reportPath],
      queryFn: () => request<Report>(reportPath),
      retry: false,
      refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? 15000 : false),
    }),
    write = useWrite<{ id?: string; message?: string }>()
  const data = list.data,
    run = data?.run
  const scanning = run?.status === 'running' && run.reported === 0
  async function preview() {
    if (!run) return
    setDraftLoading(true)
    setDraftError('')
    setCopied(false)
    try {
      setDraft(await request<Draft>('/weekly-feedback/notification?run=' + encodeURIComponent(run.id)))
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : '读取通知草稿失败，请重试。')
    } finally {
      setDraftLoading(false)
    }
  }
  return (
    <div className="feedback-center">
      <header className="page-title">
        <div>
          <h1>差评专区</h1>
          <p>每周整理商品差评原因，核对证据并跟进改进。</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!run || run.status === 'running' || draftLoading}
            onClick={() => void preview()}
          >
            <FileText size={16} />
            {draftLoading ? '读取中…' : '企业微信草稿'}
          </button>
          {edit && (
            <button
              type="button"
              className="btn primary"
              disabled={!data?.store || run?.status === 'running' || write.isPending}
              onClick={() =>
                write.mutate(
                  { path: '/weekly-feedback/run', body: {} },
                  {
                    onSuccess: (result) => {
                      if (result.id) {
                        setRunId(result.id)
                        setPage(0)
                        setDraft(null)
                      }
                    },
                  },
                )
              }
            >
              <RefreshCw size={16} />
              {run?.status === 'running' ? '正在汇总…' : '生成本周汇总'}
            </button>
          )}
        </div>
      </header>
      <section className="feedback-schedule" aria-label="周报调度与分配">
        <div>
          <b>商品差评原因周报</b>
          <span>{data?.schedule ?? '每周三 09:00（北京时间）'}</span>
        </div>
        <div>
          {admin ? (
            <label className="feedback-toggle">
              <input
                type="checkbox"
                checked={data?.enabled ?? false}
                disabled={!data?.store || write.isPending}
                onChange={(event) =>
                  write.mutate({
                    path: '/weekly-feedback/schedule',
                    body: { enabled: event.target.checked },
                  })
                }
              />
              启用每周自动汇总
            </label>
          ) : (
            <span>自动汇总：{data?.enabled ? '已开启' : '未开启'}</span>
          )}
          <Badge>{data?.notifyEnabled ? '自动通知已开启' : '自动通知未开启'}</Badge>
          {admin && (
            <button type="button" onClick={() => setConfigure(!configure)}>
              {configure ? '收起接入设置' : '运营与企业微信设置'}
            </button>
          )}
        </div>
      </section>
      <p className="feedback-explanation">
        每份周报保留 Amazon 返回的原始统计区间。主题提及次数并非本周新增差评数；建议动作供运营核查。
      </p>
      {write.error && <ErrorBox error={write.error} />}
      {list.error && <ErrorBox error={list.error} />}
      {admin && configure && <WecomSettings notifyEnabled={!!data?.notifyEnabled} />}
      {list.isPending && <p role="status">正在读取差评周报…</p>}
      {draftError && <p role="alert">{draftError}</p>}
      {draft && (
        <section className="panel feedback-draft">
          <header>
            <h2>企业微信通知草稿</h2>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              收起草稿
            </button>
          </header>
          <p>{draft.reason} 预览不会发送通知。</p>
          <section aria-label="通知草稿内容">
            <pre>{draft.text}</pre>
          </section>
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft.text)
                  setCopied(true)
                } catch {
                  setDraftError('复制失败，请选中草稿内容手动复制。')
                }
              }}
            >
              <Clipboard size={16} />
              复制草稿
            </button>
            {admin && run && (
              <button
                type="button"
                className="btn primary"
                disabled={write.isPending || !draft.ready}
                onClick={() =>
                  write.mutate(
                    { path: '/weekly-feedback/notify', body: { run: run.id } },
                    { onSuccess: (result) => setNotifyMessage(result.message ?? '请查看发送记录') },
                  )
                }
              >
                发送给已绑定运营
              </button>
            )}
            {copied && <span role="status">已复制</span>}
          </div>
          {notifyMessage && <p role="status">{notifyMessage}</p>}
        </section>
      )}
      {data && !run ? (
        <Empty title="还没有商品差评周报">
          <p>
            {data.store
              ? '点击“生成本周汇总”，读取本店商品和负面主题。'
              : '先保存美国站店铺 Seller ID，并确认已授权差评洞察权限。'}
          </p>
          {admin && !data.store && (
            <PageLink href="/settings?tab=connections" className="btn">
              配置 Amazon 数据连接
            </PageLink>
          )}
        </Empty>
      ) : null}
      {data && run && (
        <>
          <div className="feedback-toolbar">
            <label>
              历史周报
              <select
                aria-label="历史周报"
                value={runId || run.id}
                onChange={(e) => {
                  setRunId(e.target.value)
                  setPage(0)
                  setDraft(null)
                }}
              >
                <option value="">最新周报</option>
                {data.runs.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.week} · {runNames[item.status]} · {date(item.started, true)}
                  </option>
                ))}
              </select>
            </label>
            <SearchForm
              value={q}
              onSearch={(value) => {
                setQ(value)
                setPage(0)
              }}
              placeholder="搜索 SKU、ASIN、商品或英文主题"
            />
            <label>
              反馈情况
              <select
                aria-label="反馈情况"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  setPage(0)
                }}
              >
                <option value="">全部商品</option>
                <option value="available">有负面主题</option>
                <option value="no_data">无可用反馈</option>
                <option value="failed">读取失败</option>
              </select>
            </label>
            <label>
              负责运营
              <select
                aria-label="筛选负责运营"
                value={owner}
                onChange={(e) => {
                  setOwner(e.target.value)
                  setPage(0)
                }}
              >
                <option value="">全部运营</option>
                <option value="mine">我负责的</option>
                <option value="unassigned">待分配</option>
                {(data.members ?? []).map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="feedback-run-summary">
            <Badge tone={run.status === 'done' ? 'teal' : run.status === 'running' ? 'blue' : 'amber'}>
              {runNames[run.status]}
            </Badge>
            <span>汇总周：{run.week}</span>
            <span>店铺：{run.seller} · 美国站</span>
            <span>生成时间：{date(run.started, true)}</span>
          </div>
          {run.status === 'running' && (
            <p className="feedback-explanation" role="status">
              {scanning
                ? '当前阶段：正在扫描店铺商品。扫描完成后开始读取差评主题，页面会自动更新。'
                : '当前阶段：正在读取差评主题。已取得的结果会逐步显示，页面会自动更新。'}
            </p>
          )}
          {run.error && (
            <p className="feedback-warning" role="status">
              {run.error}
            </p>
          )}
          {(data.deliveries ?? []).length > 0 && (
            <details className="feedback-exclusions">
              <summary>企业微信发送记录</summary>
              {data.deliveries.map((delivery) => (
                <p key={delivery.account_id}>
                  {delivery.name} · {deliveryNames[delivery.status]} · {date(delivery.updated_at, true)}
                  {delivery.error && ' · ' + delivery.error}
                </p>
              ))}
              {admin &&
                data.deliveries.some((delivery) =>
                  ['failed', 'preparing', 'sending'].includes(delivery.status),
                ) && (
                  <button
                    type="button"
                    disabled={write.isPending}
                    onClick={() =>
                      write.mutate(
                        { path: '/weekly-feedback/notify', body: { run: run.id, retryFailed: true } },
                        { onSuccess: (result) => setNotifyMessage(result.message ?? '请查看发送记录') },
                      )
                    }
                  >
                    重试失败或中断的通知
                  </button>
                )}
            </details>
          )}
          {data.stats && (
            <dl className="feedback-counts">
              {[
                ['已读取 SKU', data.stats.skus],
                ['已查询 ASIN', data.stats.asins],
                ['有负面主题', data.stats.issues],
                ['无可用反馈', data.stats.noData],
                ['读取失败', data.stats.failed],
                ['已排除父体', data.stats.parents],
                ['关联信息待确认', data.stats.unresolved],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.exclusions.length > 0 && (
            <details className="feedback-exclusions">
              <summary>查看关联信息待确认的商品（展示前 30 个）</summary>
              <p>
                这里只列出缺少 ASIN
                或明确父子关系的商品，不代表未上架，也不是差评商品清单；这些商品暂未查询差评主题。
              </p>
              {data.exclusions.map((item) => (
                <p key={item.sku}>
                  {item.sku} · {item.asin ?? 'ASIN 未取得'} · {item.title}
                </p>
              ))}
            </details>
          )}
          {!data.rows.length && (
            <Empty
              title={
                run.status === 'running'
                  ? scanning
                    ? '正在扫描店铺商品'
                    : '正在读取差评主题'
                  : '当前条件下没有商品记录'
              }
            >
              <p>
                {run.status === 'running'
                  ? scanning
                    ? '商品扫描完成后，这里会显示差评分析结果。关联信息待确认的商品另列在上方。'
                    : '差评结果会逐步显示，可以稍后回来查看。'
                  : '可调整筛选条件，或查看关联信息待确认的商品。'}
              </p>
            </Empty>
          )}
          <div className="feedback-products">
            {data.rows.map((row) => (
              <article className="panel feedback-product" key={run.id + row.asin}>
                <header className="feedback-product-header">
                  <Thumb p={{ title: row.title, thumbnail: row.image }} big />
                  <div>
                    <h2>{row.title}</h2>
                    <p>
                      <b>SKU：</b>
                      <span>{row.skus.join(' / ')}</span>
                    </p>
                    <p>
                      <b>ASIN：</b>
                      <a href={'https://www.amazon.com/dp/' + row.asin} target="_blank" rel="noreferrer">
                        {row.asin}
                      </a>
                    </p>
                    <p>负责运营：{row.operatorName ?? '待分配'}</p>
                    {row.lowRatingCount != null && <p>上周新增低星评价：{row.lowRatingCount} 条</p>}
                    {row.skus.length > 1 && (
                      <small>多个 SKU 共用此 ASIN 的差评主题，未按 SKU 拆分次数。</small>
                    )}
                  </div>
                  <MessageSquareWarning size={20} className="feedback-product-icon" />
                </header>
                <p className="feedback-period">
                  Amazon 统计区间：
                  {row.period ? date(row.period.startDate) + ' — ' + date(row.period.endDate) : '未提供'}
                  {!row.image && ' · 产品图片未取得'}
                </p>
                {admin && (
                  <details className="feedback-owner-editor">
                    <summary>分配负责运营</summary>
                    {(row.assignments ?? []).map((assignment) => (
                      <AssignSku
                        key={assignment.sku + assignment.accountId}
                        assignment={assignment}
                        members={data.members ?? []}
                        run={run.id}
                      />
                    ))}
                  </details>
                )}
                {row.status === 'failed' ? (
                  <p role="status" className="feedback-warning">
                    {row.error}
                  </p>
                ) : row.status === 'no_data' ? (
                  <p className="feedback-no-data">
                    Amazon 暂无可用负面主题，可能是评论不足；不能据此判断没有差评。
                  </p>
                ) : (
                  row.topics.map((topic) => (
                    <TopicHandling key={topic.name} row={row} topic={topic} run={run.id} />
                  ))
                )}
              </article>
            ))}
          </div>
          <nav className="feedback-pager" aria-label="差评商品翻页">
            <span>共 {data.total} 个 ASIN · 每页 30 个</span>
            <div>
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>第 {page + 1} 页</span>
              <button
                type="button"
                disabled={(page + 1) * 30 >= data.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  )
}
