import {
  CalendarClock,
  ChevronRight,
  Coins,
  FileText,
  ListChecks,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Wallet,
} from 'lucide-react'
import { useState } from 'react'
import type { AmazonComparison } from '../../../packages/amazon/auto-compare'
import { memberDiagnostic, memberStepResult } from '../../../packages/contracts/presentation'
import { CompareAgain, ComparisonEvidence, needsAmazonLookup } from './amazon-comparison'
import { Metric } from './catalog'
import { type Job, type PageResult, type Strategy, runModeLabels, selectionLabels, statusLabels } from './models'
import { Select } from './select'
import {
  amount,
  Dialog,
  date,
  dollars,
  Empty,
  ErrorBox,
  Loading,
  Notice,
  PageLink,
  Pager,
  Panel,
  productUrl,
  Status,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
  useWrite,
} from './ui'

const actions = [
  { key: 'pause', name: '暂停', icon: Pause, states: ['queued', 'running'] },
  { key: 'resume', name: '恢复运行', icon: Play, states: ['paused'] },
  { key: 'cancel', name: '取消任务', icon: Square, states: ['queued', 'running', 'paused', 'pausing'] },
  { key: 'retry', name: '补跑未完成步骤', icon: RefreshCw, states: ['failed', 'partial'] },
]
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function comparisonItems(value: unknown): AmazonComparison[] {
  if (!isRecord(value) || !Array.isArray(value.comparisons)) return []
  return value.comparisons.filter(
    (c) => isRecord(c) && typeof c.productId === 'string' && Array.isArray(c.candidates),
  )
}
function StepData({ value }: { value: unknown }) {
  if (!isRecord(value) || !Object.keys(value).length) return null
  const tiers = Array.isArray(value.tiers) ? value.tiers.filter(isRecord) : [],
    examples = Array.isArray(value.examples) ? value.examples.filter(isRecord) : []
  const selection = isRecord(value.selection) ? value.selection : null
  const verdict = selection?.verdict
  return (
    <div className="step-result">
      {Array.isArray(value.quotes) && value.quotes.length > 0 && <details>
        <summary>查看 Amazon 官方核价 · {value.quotes.length} 款</summary>
        {value.quotes.filter(isRecord).map(q => <p key={String(q.asin)}>
          <PageLink href={productUrl('amazon:US:' + q.asin)}>{String(q.asin)}</PageLink>
          {' · '}{typeof q.price === 'number' ? '$' + q.price.toFixed(2) : '待查价'}
          {' · '}{String(q.tier)}
        </p>)}
      </details>}
      {isRecord(value.target) && (
        <div className="plan-summary">
          <small>指定研究商品 · 来源快照</small>
          <PageLink className="product-title-preview" href={productUrl(String(value.target.id))}>{String(value.target.title)}</PageLink>
          <span>
            累计销量 {amount(value.target.total_sold as number | null)} · 更新时间{' '}
            {date(value.target.updated_at as string | null)}
          </span>
        </div>
      )}
      {typeof value.sampled === 'number' && (
        <div className="inline">
          <span className="subtle-pill">范围内 {amount(value.sampled)} 件</span>
          <span className="subtle-pill">达标 {amount(Number(value.matched))} 件</span>
          <span className="subtle-pill">累计销量缺失 {amount(Number(value.missingTotalSold))} 件</span>
        </div>
      )}
      {tiers.length > 0 && (
        <div className="tier-grid">
          {tiers.map((t) => (
            <div key={String(t.lower)}>
              <small>
                累计销量至少 {amount(Number(t.lower))}
                {t.upper != null && '，不足 ' + amount(Number(t.upper))}
              </small>
              <b>{amount(Number(t.count))} 件</b>
            </div>
          ))}
        </div>
      )}
      {examples.length > 0 && (
        <details>
          <summary>查看商品样本 · {examples.length} 件</summary>
          <ul className="log-list">
            {examples.map((x) => (
              <li key={String(x.id ?? x.productId)}>
                <PageLink className="product-title-preview" href={productUrl(String(x.id ?? x.productId))}>{String(x.title)}</PageLink>
                <small>
                  累计销量 {amount((x.total_sold ?? x.totalSold) as number | null)} ·{' '}
                  {x.page ? '来源页 ' + x.page : date(String(x.updated_at || ''))}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {['standardProduct', 'differentiation'].map(
        (k) =>
          typeof value[k] === 'string' && (
            <div key={k}>
              <b>{k === 'standardProduct' ? '标品机会推断' : '差异化 / POD 推断'}</b>
              <p>{String(value[k])}</p>
            </div>
          ),
      )}
      {typeof verdict === 'string' &&
        Object.hasOwn(selectionLabels, verdict) &&
        typeof selection?.reason === 'string' && (
          <div>
            <b>AI 选品结论 · {selectionLabels[verdict as keyof typeof selectionLabels]}</b>
            <p>{selection.reason}</p>
          </div>
        )}
      {Object.entries({
        facts: '已知事实',
        inferences: '研究推断',
        missing: '待确认项',
        actions: '后续行动',
        nextActions: '建议行动',
        limitations: '证据边界',
        reasons: '待处理事项',
      }).map(([k, label]) =>
        Array.isArray(value[k]) && value[k].length > 0 ? (
          <div key={k}>
            <b>{label}</b>
            <ul>
              {Array.from(
                new Set<string>(
                  value[k].map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))),
                ),
              ).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      <details>
        <summary>结构化执行记录</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  )
}
type QueueEntry = {
  productId: string
  title: string
  tier: number
  totalSold: number
  page: number
  evidenceRef: string
  childId: string | null
}
function ResearchQueue({ id }: { id: string }) {
  const [page, setPage] = useState(1),
    [size, setSize] = useState(20)
  const data = useData<PageResult<QueueEntry>>(
    '/jobs/' + encodeURIComponent(id) + '/queue?page=' + page + '&pageSize=' + size,
    true,
    10000,
  )
  return (
    <div className="queue">
      <h3>分层研究队列</h3>
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <ErrorBox error={data.error} retry={() => void data.refetch()} />
      ) : !data.data.total ? (
        <div className="plain-empty">本轮尚无符合分层条件的商品。</div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>达标商品</th>
                  <th>销量分层</th>
                  <th>累计销量</th>
                  <th>来源页</th>
                  <th>关联研究</th>
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((v) => (
                  <tr key={v.productId}>
                    <td>
                      <PageLink className="product-title-preview" href={productUrl(v.productId)}>{v.title}</PageLink>
                    </td>
                    <td>累计销量至少 {amount(v.tier)}</td>
                    <td>{amount(v.totalSold)}</td>
                    <td>{v.page}</td>
                    <td>
                      {v.childId ? (
                        <PageLink href={'/tasks?id=' + encodeURIComponent(v.childId)}>查看研究</PageLink>
                      ) : (
                        '待研究'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            total={data.data.total}
            page={page}
            size={size}
            onPage={setPage}
            onSize={(n) => {
              setPage(1)
              setSize(n)
            }}
          />
        </>
      )}
    </div>
  )
}
function JobDetail({ id }: { id: string }) {
  const result = useData<Job>('/jobs/' + encodeURIComponent(id), true, 7000),
    { edit, admin } = useAccess(),
    mut = useWrite(),
    [confirm, setConfirm] = useState(false)
  if (result.isPending) return <Loading />
  if (result.isError) return <ErrorBox error={result.error} retry={() => void result.refetch()} />
  const j = result.data,
    perform = (action: string) => {
      setConfirm(false)
      mut.mutate({ path: '/jobs/' + encodeURIComponent(id) + '/' + action, body: {} })
    }
  const amazonStep = j.steps?.find((s) => s.key === 'amazon-compare')
  const comparisons = comparisonItems(amazonStep?.result)
  const plan = j.steps?.find((s) => s.key === 'plan')?.result
  const hasProducts =
    !!j.inputs.productId || (isRecord(plan) && Array.isArray(plan.examples) && plan.examples.length > 0)
  const canBackfill =
    hasProducts &&
    j.kind === 'research' &&
    j.inputs.mode === 'live' &&
    ['succeeded', 'partial'].includes(j.status) &&
    j.steps?.some((s) => s.key === 'decision' && s.status === 'succeeded') &&
    amazonStep?.status !== 'running' &&
    (amazonStep?.status === 'failed' || !comparisons.length || comparisons.some(needsAmazonLookup))
  return (
    <Panel title="任务详情" extra={<Status status={j.status} />}>
      <div className="panel-body stack">
        <div className="spread wrap">
          <div>
            <div className="eyebrow">
              {j.kind === 'research' ? 'RESEARCH RUN' : 'DISCOVERY RUN'} · 策略 v{j.strategyVersion}
            </div>
            <h2>{j.title}</h2>
            <small className="muted">
              {j.actor} · {date(j.createdAt, true)} ·{' '}
              {runModeLabels[j.inputs.mode ?? 'cache']}
            </small>
          </div>
          <div className="inline">
            {actions
              .filter((a) => a.states.includes(j.status))
              .map((a) => (
                <button
                  type="button"
                  key={a.key}
                  disabled={!edit || (j.scheduled && !admin) || mut.isPending}
                  onClick={() => (a.key === 'cancel' ? setConfirm(true) : perform(a.key))}
                >
                  <a.icon />
                  {a.name}
                </button>
              ))}
          </div>
        </div>
        {j.summary && <Notice>{memberDiagnostic(j.summary)}</Notice>}
        <div className="inline">
          <span className="subtle-pill">数据用量 {amount(j.usage?.dataPoints)} 积分</span>
          <span className="subtle-pill">AI 用量 {dollars(j.usage?.aiMicros)}</span>
        </div>
        {(!!j.usage?.unconfirmedDataPoints || !!j.usage?.unconfirmedAiMicros) && (
          <Notice>
            以上用量含待确认的预留额度，其中 {amount(j.usage.unconfirmedDataPoints)} 积分、
            {dollars(j.usage.unconfirmedAiMicros)} 待核账。
          </Notice>
        )}
        <ErrorBox error={mut.error} />
        {j.inputs.imageId && (
          <div className="reference-preview">
            <img
              alt="任务关联的商品参考图"
              src={'/api/research-images/' + encodeURIComponent(j.inputs.imageId)}
            />
            <span>人工选择的参考图</span>
          </div>
        )}
        <h3>执行步骤与证据</h3>
        {j.steps?.length ? (
          <div className="job-steps">
            {j.steps.map((s) => (
              <article key={s.key}>
                <div className="spread wrap">
                  <h3>
                    <FileText size={15} /> {memberDiagnostic(s.title)}
                  </h3>
                  <Status status={s.status} />
                </div>
                <p>{memberDiagnostic(s.summary)}</p>
                {s.key === 'amazon-compare' ? (
                  comparisons.map((c) => <ComparisonEvidence key={c.productId} comparison={c} />)
                ) : (
                  <StepData value={memberStepResult(s.result)} />
                )}
                <small>{date(s.updatedAt, true)}</small>
              </article>
            ))}
          </div>
        ) : (
          <div className="plain-empty">等待后台写入步骤记录。</div>
        )}
        {canBackfill && <CompareAgain runId={j.id} />}
        {j.kind === 'discovery' && j.inputs.mode === 'live' && <ResearchQueue id={j.id} />}
        <details>
          <summary>任务输入与标识</summary>
          <code>{j.id}</code>
          <pre>{JSON.stringify(j.inputs, null, 2)}</pre>
        </details>
      </div>
      {confirm && (
        <Dialog title="取消此任务？" onClose={() => setConfirm(false)}>
          <div className="dialog-body stack">
            <p>将停止新的执行步骤，已发出的请求会完成记录。</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirm(false)}>
                保留任务
              </button>
              <button type="button" className="danger" onClick={() => perform('cancel')}>
                确认取消
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </Panel>
  )
}
export function Tasks() {
  const {admin}=useAccess(),priority=useWrite()
  const dispatch=useData<{items:{token:string;lane:string;active:number;priority:number;owner:string;runId:string|null;title:string|null;examined:number;peers:number;fast:number|null;slow:number|null}[]}>('/dispatch',true,5000)
  const serviceNames:Record<string,string>={geekbi:'商品采集',ai:'AI 分析',catalog:'Amazon 搜索',pricing:'Amazon 核价'}
  const { params } = useLocation(),
    go = useGo(),
    kind = params.get('kind') || '',
    status = params.get('status') || '',
    id = params.get('id') || '',
    page = Number(params.get('page') || 1),
    size = Number(params.get('pageSize') || 20)
  const query = new URLSearchParams({ page: String(page), pageSize: String(size) })
  if (kind) query.set('kind', kind)
  if (status) query.set('status', status)
  const list = useData<PageResult<Job>>('/jobs?' + query, true, 10000),
    all = useData<PageResult<Job>>('/jobs?pageSize=1', true, 10000),
    strategy = useData<Strategy>('/strategy')
  function update(values: Record<string, string>, reset = true) {
    const p = new URLSearchParams(params)
    if (reset) p.delete('page')
    for (const [k, v] of Object.entries(values)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    go('/tasks' + (p.size ? '?' + p : ''))
  }
  return (
    <>
      <Title
        eyebrow="TASK OPERATIONS"
        title="任务中心"
        desc="打开一条任务，查看找到了哪些商品、用了多少预算，以及在哪一步停下。"
      >
        <PageLink className="btn" href="/settings?tab=schedule">
          <CalendarClock />
          调度设置
        </PageLink>
        <PageLink className="btn primary" href="/research">
          <Plus />
          新建任务
        </PageLink>
      </Title>
      {!!dispatch.data?.items?.length && <Panel title={admin?'团队调度队列':'我的调度队列'}><div className="panel-body stack">
        {dispatch.data.items.map(t=><div className="spread wrap" key={t.token}><div><b>{t.title??serviceNames[t.lane]}</b>
        <small className="block">{admin?t.owner+' · ':''}{t.active?'正在处理':'排队中'} · {serviceNames[t.lane]}{t.examined?' · 已检查 '+t.examined+' 款':''}
        {!t.active && t.peers>0 && t.slow!==null && ' · 预计等待约 0–'+Math.max(1,Math.ceil(t.slow*t.peers/60))+' 分钟（按近期批次估算）'}</small></div>
        {admin && !t.active && <button disabled={!!t.priority||priority.isPending} onClick={()=>priority.mutate({path:'/dispatch/'+t.token+'/priority',body:{}})}>{t.priority?'已优先':'优先处理这一批'}</button>}</div>)}
        <ErrorBox error={priority.error}/></div></Panel>}
      <div className="metrics">
        <Metric
          label="全部任务"
          icon={ListChecks}
          value={amount(all.data?.total)}
          sub="已创建的运行记录"
        />
        <Metric
          label="每日发现"
          icon={CalendarClock}
          value={!strategy.data ? '—' : strategy.data.settings.scheduleEnabled ? '已启用' : '未启用'}
          sub={
            strategy.data?.settings.scheduleTime
              ? '北京时间 ' + strategy.data.settings.scheduleTime
              : '执行时间待设置'
          }
        />
        <Metric
          label="今日数据用量"
          icon={Coins}
          value={amount(strategy.data?.usage.dataPoints)}
          sub={'日上限 ' + amount(strategy.data?.settings.dataDailyPoints) + ' 积分'}
        />
        <Metric
          label="今日 AI 用量"
          icon={Wallet}
          value={dollars(strategy.data?.usage.aiMicros)}
          sub={'日上限 ' + dollars(strategy.data?.settings.aiDailyMicros)}
        />
      </div>
      <Panel>
        <div className="tasks-toolbar">
          <div className="tabs">
            {[
              ['', '全部任务'],
              ['discovery', '数据发现'],
              ['research', 'AI 研究'],
            ].map(([k, v]) => (
              <button
                type="button"
                className={kind === k ? 'active' : ''}
                key={k}
                onClick={() => update({ kind: k })}
              >
                {v}
              </button>
            ))}
          </div>
          <Select
            variant="compact"
            aria-label="任务状态"
            value={status}
            onValueChange={(value) => update({ status: value })}
            options={[
              { value: '', label: '全部状态' },
              ...[
                'queued',
                'running',
                'paused',
                'partial',
                'failed',
                'succeeded',
                'cancelled',
                'pausing',
                'cancelling',
              ].map((value) => ({ value, label: statusLabels[value] })),
            ]}
          />
        </div>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorBox error={list.error} retry={() => void list.refetch()} />
        ) : list.data.items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务名称</th>
                  <th>类型 / 执行方式</th>
                  <th>创建时间</th>
                  <th>数据积分</th>
                  <th>AI 用量</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((j) => (
                  <tr className={id === j.id ? 'highlight-row' : ''} key={j.id}>
                    <td>
                      <button
                        type="button"
                        className="linkbtn job-title"
                        onClick={() => update({ id: j.id }, false)}
                      >
                        {j.title}
                      </button>
                    </td>
                    <td>
                      {j.kind === 'research' ? 'AI 研究' : '数据发现'}
                      <small className="block">
                        {runModeLabels[j.inputs.mode ?? 'cache']}
                      </small>
                    </td>
                    <td>{date(j.createdAt, true)}</td>
                    <td>{amount(j.usage?.dataPoints)}</td>
                    <td>{dollars(j.usage?.aiMicros)}</td>
                    <td>
                      <Status status={j.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon"
                        aria-label={'查看 ' + j.title}
                        onClick={() => update({ id: j.id }, false)}
                      >
                        <ChevronRight />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={status || kind ? '该筛选下暂无任务' : '暂无执行记录'}
            detail="选择「使用已有资料」创建任务，即可免费核对范围和分层结果。"
          >
            <PageLink className="btn" href="/research">
              新建研究任务
            </PageLink>
          </Empty>
        )}
        {list.data && (
          <Pager
            total={list.data.total}
            page={page}
            size={size}
            onPage={(n) => update({ page: String(n) }, false)}
            onSize={(n) => update({ pageSize: String(n) })}
          />
        )}
      </Panel>
      {id && (
        <div className="below">
          <JobDetail key={id} id={id} />
        </div>
      )}
    </>
  )
}
