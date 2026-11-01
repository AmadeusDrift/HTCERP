import {
  ChevronRight,
  ClipboardCheck,
  Database,
  FileSearch,
  Layers3,
  Play,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react'
import { useState } from 'react'
import {
  type Detail,
  type JobInputs,
  type JobKind,
  type Meta,
  modelLabel,
  runModeLabels,
  type PageResult,
  type Product,
  platforms,
  type Strategy,
} from './models'
import { ReferenceImage } from './reference-image'
import { Select, selectOptions } from './select'
import {
  amount,
  Badge,
  dollars,
  ErrorBox,
  Field,
  Loading,
  Notice,
  Panel,
  SearchForm,
  Thumb,
  Title,
  useAccess,
  useData,
  useGo,
  useLocation,
  useWrite,
} from './ui'

function Selector({ choose }: { choose: (p: Product) => void }) {
  const [q, setQ] = useState('')
  const result = useData<PageResult<Product>>(
    '/products?q=' + encodeURIComponent(q) + '&pageSize=10',
    !!q,
  )
  function search(value: string) {
    if (/^https:\/\//i.test(value)) {
      try {
        const u = new URL(value),
          id = u.searchParams.get('goodsId') || u.pathname.match(/\d{5,}/)?.[0]
        setQ(id || value)
        return
      } catch {
        /* use literal as a catalog query */
      }
    }
    setQ(value)
  }
  return (
    <div className="stack">
      <SearchForm value={q} onSearch={search} placeholder="按商品名称、ID 或含商品 ID 的链接查询" />
      {q &&
        (result.isPending ? (
          <Loading />
        ) : result.isError ? (
          <ErrorBox error={result.error} />
        ) : !result.data.items.length ? (
          <div className="plain-empty">本地商品库未匹配到该商品。</div>
        ) : (
          <div className="picker-list">
            {result.data.items.filter(p => ['amazon','temu'].includes(p.platform)).map((p) => (
              <button key={p.id} type="button" className="picker-row" onClick={() => choose(p)}>
                <Thumb p={p} />
                <div>
                  <b>{p.title_cn || p.title}</b>
                  <small>
                    {platforms[p.platform]} · {p.external_id}
                  </small>
                </div>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        ))}
    </div>
  )
}
export function Research() {
  const { params } = useLocation(),
    go = useGo()
  const s = useData<Strategy>('/strategy'),
    meta = useData<Meta>('/catalog/meta')
  const [kind, setKind] = useState<JobKind>(
      params.get('kind') === 'discovery' ? 'discovery' : 'research',
    ),
    [scope, setScope] = useState(params.get('product') ? 'product' : 'batch'),
    [pId, setPId] = useState(params.get('product') || '')
  const selected = useData<Detail>('/products/' + encodeURIComponent(pId), !!pId)
  const [imageId, setImageId] = useState('')
  const [goal, setGoal] = useState(''),
    [platform, setPlatform] = useState(''),
    [category, setCategory] = useState(''),
    [keyword, setKeyword] = useState<string | null>(null),
    [maxPrice, setPrice] = useState<string | null>(null),
    [pages, setPages] = useState(''),
    [mode, setMode] = useState<'cache' | 'live'>('cache'),
    [points, setPoints] = useState(''),
    [usd, setUsd] = useState(''),
    [tiers, setTiers] = useState(''),
    [preview, setPreview] = useState(''),
    [error, setError] = useState('')
  const { edit, admin } = useAccess(),
    create = useWrite<{ id: string }>((v) => go('/tasks?id=' + encodeURIComponent(v.id)))
  const strategy = s.data,
    f = strategy?.settings,
    plat = platform || f?.platform || 'temu',
    effectiveCategory = category === '__all' ? '' : category || f?.categoryId || ''
  const cats = (meta.data?.categories || []).filter((c) => !c.platform || c.platform === plat)
  const allowAiBudget = mode === 'live' && (kind === 'research' || (f?.researchLimit ?? 0) > 0)
  const target = kind === 'research' && scope === 'product' ? selected.data?.product : undefined
  const boundaries = tiers
    ? tiers
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number)
    : f?.tiers || [50000, 30000, 10000]
  const inputs: JobInputs = {
    mode,
    platform: target?.platform ?? plat,
    categoryId: target ? target.category_id || '' : effectiveCategory,
    keyword: target ? '' : (keyword ?? f?.keyword ?? '').trim(),
    maxPrice:
      target || maxPrice === '' ? null : maxPrice === null ? (f?.maxPrice ?? null) : Number(maxPrice),
    tiers: boundaries,
    pageLimit: Number(pages || f?.pageLimit || 1),
    maxDataPoints: mode === 'cache' ? 0 : Number(points || 0),
    maxAiMicros: allowAiBudget ? Math.round(Number(usd || 0) * 1e6) : 0,
    ...(kind === 'research'
      ? {
          goal: goal.trim(),
          ...(scope === 'product' && pId ? { productId: pId, ...(imageId ? { imageId } : {}) } : {}),
        }
      : {}),
  }
  const signature = JSON.stringify([kind, inputs, strategy?.version])
  const planned = preview === signature,
    reqId = useState(() => crypto.randomUUID())[0]
  const steps =
    kind === 'discovery'
      ? ['按平台与类目检索', '核对累计销量分层', '去重并保存来源证据']
      : [
          '确定研究范围',
          '整理事实与缺失项',
          ...(mode === 'live' ? ['检索 Amazon 美国站候选', '保存研究结论和后续行动'] : ['保存已有资料的核验结果']),
        ]
  const pending = !strategy || create.isPending
  function validate() {
    if (kind === 'research' && !goal.trim()) return '填写研究需求后再预览计划。'
    if (kind === 'research' && scope === 'product' && (!pId || !selected.data))
      return '请先在商品库选择一个研究对象。'
    if (!Number.isSafeInteger(inputs.pageLimit) || inputs.pageLimit! < 1 || inputs.pageLimit! > 20)
      return '最大检索页数须为 1 至 20 页。'
    if (
      inputs.maxPrice != null &&
      (!Number.isFinite(inputs.maxPrice) || inputs.maxPrice < 0 || inputs.maxPrice > 1_000_000)
    )
      return '价格上限须在 0 至 1,000,000 美元之间。'
    if (
      boundaries.length < 1 ||
      boundaries.length > 6 ||
      boundaries.some((n, i) => !Number.isSafeInteger(n) || n < 0 || (i > 0 && n >= boundaries[i - 1]))
    )
      return '销量分层需填写从高到低的不重复整数。'
    if (mode === 'live' && kind === 'discovery' && plat !== 'amazon' && !inputs.categoryId && !inputs.keyword)
      return '在线发现需要至少一个来源类目或关键词。'
    if (
      mode === 'live' &&
      kind === 'discovery' &&
      (!(
        strategy?.capabilities?.discovery ??
        strategy?.connections?.productData ??
        strategy?.connections?.geekbi
      ) ||
        !points ||
        Number(points) <= 0)
    )
      return '在线发现需要启用商品数据连接，并填写大于零的数据积分上限。'
    if (
      mode === 'live' &&
      kind === 'research' &&
      (!(strategy?.capabilities?.research ?? strategy?.connections?.openrouter) ||
        !usd ||
        Number(usd) <= 0)
    )
      return '在线研究需要启用 AI 研究服务，并填写大于零的 AI 费用上限。'
    return ''
  }
  function plan() {
    const err = validate()
    setError(err)
    if (!err) setPreview(signature)
  }
  function run() {
    const err = validate()
    setError(err)
    if (err || !planned || !edit) return
    create.mutate({ path: '/jobs', body: { kind, inputs, requestId: reqId } })
  }
  return (
    <>
      <Title
        eyebrow="RESEARCH STUDIO"
        title={kind === 'discovery' ? '新建发现任务' : 'AI 研究台'}
        desc="选商品、写下想弄清的问题，再预览步骤和费用上限。"
      />
      <div className="workspace-two">
        <div className="stack">
          <Panel
            title="研究需求"
            extra={
              <div className="segmented">
                <button
                  type="button"
                  className={kind === 'research' ? 'selected' : ''}
                  onClick={() => setKind('research')}
                >
                  AI 研究
                </button>
                <button
                  type="button"
                  className={kind === 'discovery' ? 'selected' : ''}
                  onClick={() => setKind('discovery')}
                >
                  商品发现
                </button>
              </div>
            }
          >
            <div className="panel-body stack">
              {kind === 'research' && (
                <>
                  <Field label="你希望研究什么？">
                    <textarea
                      rows={3}
                      value={goal}
                      maxLength={500}
                      placeholder="例如，研究美国站低价家居用品的需求信号，并列出需要进一步核验的 Amazon 对照证据。"
                      onChange={(e) => setGoal(e.target.value)}
                    />
                  </Field>
                  <div className="counter">{goal.length} / 500</div>
                  <div className="mode-grid">
                    {[
                      ['batch', '批量研究', '按来源和筛选范围研究'],
                      ['product', '指定商品', '基于单件商品的现有证据'],
                    ].map(([k, title, desc]) => (
                      <button
                        type="button"
                        key={k}
                        aria-pressed={scope === k}
                        className={'mode-card ' + (scope === k ? 'chosen' : '')}
                        onClick={() => setScope(k)}
                      >
                        {k === 'batch' ? <Layers3 /> : <FileSearch />}
                        <span>
                          <b>{title}</b>
                          <small>{desc}</small>
                        </span>
                        <i />
                      </button>
                    ))}
                  </div>
                </>
              )}
              {kind === 'research' && scope === 'product' ? (
                <>
                  <ReferenceImage id={imageId} change={setImageId} />
                  {pId && selected.isPending ? (
                    <Loading />
                  ) : pId && selected.data ? (
                    <div className="selected-product">
                      <Thumb p={selected.data.product} />
                      <div>
                        <b>{selected.data.product.title_cn || selected.data.product.title}</b>
                        <small>{selected.data.product.id}</small>
                      </div>
                      <button
                        type="button"
                        className="icon"
                        aria-label="更换商品"
                        onClick={() => setPId('')}
                      >
                        <X />
                      </button>
                    </div>
                  ) : (
                    <>
                      <ErrorBox error={selected.error} />
                      <Selector choose={(p) => setPId(p.id)} />
                    </>
                  )}
                </>
              ) : (
                <div className="fields-2">
                  <Field label="数据平台">
                    <Select
                      value={plat}
                      onValueChange={(value) => {
                        setPlatform(value)
                        setTiers(value === 'amazon' ? '0' : '')
                        setCategory('__all')
                      }}
                      options={selectOptions({ temu: 'Temu', amazon: 'Amazon' })}
                    />
                  </Field>
                  <Field label="商品类目">
                    {plat === 'amazon' ? <input aria-label="Amazon 类目编号" placeholder="全部类目，或输入 Amazon 类目编号"
                      value={effectiveCategory} onChange={e => setCategory(e.target.value.replace(/\D/g,'') || '__all')} /> : <Select
                      value={effectiveCategory}
                      onValueChange={(value) => setCategory(value || '__all')}
                      options={[
                        { value: '', label: '全部类目' },
                        ...cats.map((c) => ({
                          value: c.value.replace(/^[^:]+:/, ''),
                          label: c.label,
                        })),
                      ]}
                    />}
                  </Field>
                  <Field label="关键词">
                    <input
                      value={keyword ?? f?.keyword ?? ''}
                      placeholder="不限"
                      onChange={(e) => setKeyword(e.target.value)}
                    />
                  </Field>
                  <Field label="价格上限（USD）">
                    <input
                      type="number"
                      min="0"
                      step=".01"
                      value={maxPrice ?? f?.maxPrice ?? ''}
                      placeholder="不限"
                      onChange={(e) => setPrice(e.target.value)}
                    />
                  </Field>
                  <Field label="各层累计销量至少多少件" hint="按从高到低的顺序填写，各层之间用逗号分隔。">
                    <input
                      value={tiers}
                      placeholder={f?.tiers?.join(', ') || '50000, 30000, 10000'}
                      onChange={(e) => setTiers(e.target.value)}
                    />
                  </Field>
                  <Field label="最大检索页数">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={pages}
                      placeholder={String(f?.pageLimit || 1)}
                      onChange={(e) => setPages(e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          </Panel>
          <Panel
            title="拟执行的步骤"
            extra={<Badge tone={planned ? 'blue' : 'neutral'}>{planned ? '已预览' : '待预览'}</Badge>}
          >
            <ol className="steps">
              {steps.map((v, i) => (
                <li key={v}>
                  <span>{i + 1}</span>
                  <div>
                    <b>{v}</b>
                    <small>
                      {
                        [
                          scope === 'product' && kind === 'research'
                            ? '使用已选商品及其可追溯快照'
                            : platforms[plat] + ' · 美国站',
                          kind === 'discovery'
                            ? '按累计销量分层，单独记录销量缺失的商品'
                            : '将历史观测、规格、价格与尚缺字段分开',
                          mode === 'cache'
                            ? '仅使用已入库的数据与证据'
                            : kind === 'research'
                              ? '对照来源商品与目录候选的规格、价格和类目排名'
                              : '按任务与每日预算推进，记录用量与步骤',
                          '记录 AI 判断、待核对的证据和后续行动',
                        ][i]
                      }
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="运行配置" extra={<SlidersIcon />}>
            <div className="panel-body stack">
              <Field label="执行方式" hint="使用已有资料免费。获取最新资料可能消耗数据积分或产生 AI 费用，受本次任务和团队每日预算限制。">
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as typeof mode)}
                  options={selectOptions(runModeLabels)}
                />
              </Field>
              <Field label="数据积分上限" hint="本次任务最多可使用的数据积分。">
                <input
                  type="number"
                  disabled={mode === 'cache'}
                  min="0"
                  step="1"
                  value={mode === 'cache' ? '0' : points}
                  placeholder="输入积分"
                  onChange={(e) => setPoints(e.target.value)}
                />
              </Field>
              <Field
                label="AI 费用上限（USD）"
                hint={
                  kind === 'discovery'
                    ? '用于本轮优先商品的 AI 子研究，0 表示仅保留清单。'
                    : '本次在线研究可使用的费用上限。'
                }
              >
                <input
                  disabled={!allowAiBudget}
                  type="number"
                  min="0"
                  step="0.000001"
                  value={allowAiBudget ? usd : '0'}
                  placeholder="输入美元金额"
                  onChange={(e) => setUsd(e.target.value)}
                />
              </Field>
              {admin && strategy?.models && (
                <div className="model-info">
                  <small>研究模型</small>
                  <span>{modelLabel(strategy.models.research)}</span>
                  <small>决策模型</small>
                  <span>{modelLabel(strategy.models.decision)}</span>
                </div>
              )}
              <ErrorBox error={s.error} retry={() => void s.refetch()} />
              <ErrorBox error={error || create.error} />
              <button type="button" disabled={pending} onClick={plan}>
                <ClipboardCheck />
                预览执行计划
              </button>
              {planned && (
                <div className="plan-summary">
                  <small>本次执行范围</small>
                  <b>
                    {scope === 'product' && kind === 'research'
                      ? selected.data?.product.id
                      : platforms[plat] +
                        ' · ' +
                        (cats.find((c) => c.value.replace(/^[^:]+:/, '') === effectiveCategory)?.label ||
                          '全部类目')}
                  </b>
                  <span>
                    数据上限 {amount(inputs.maxDataPoints)} 积分 · AI 上限 {dollars(inputs.maxAiMicros)}
                  </span>
                  {kind === 'discovery' && (
                    <span>
                      最多 {inputs.pageLimit} 页 · 各层累计销量至少{' '}
                      {boundaries.map((n) => amount(n)).join(' / ')}
                    </span>
                  )}
                </div>
              )}
              {planned && (
                <Notice success>
                  已核对输入范围。策略 v{strategy?.version}，
                  {mode === 'cache' ? '本次使用已有资料，免费核验。' : '本次获取最新资料，按实际用量计费。'}
                </Notice>
              )}
              <button
                type="button"
                className="primary"
                disabled={!planned || pending || !edit}
                onClick={run}
              >
                <Play />
                {create.isPending ? '正在创建…' : '创建并运行任务'}
              </button>
            </div>
          </Panel>
          <Panel title="报告内容">
            <div className="report-key">
              <p>
                <Database />
                来源事实 <small>已取得的快照和证据</small>
              </p>
              <p>
                <Sparkles />
                研究推断 <small>生成后单独标明</small>
              </p>
              <p>
                <ShieldCheck />
                待确认项 <small>缺失字段与人工核验</small>
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}
function SlidersIcon() {
  return <Wallet size={16} />
}
