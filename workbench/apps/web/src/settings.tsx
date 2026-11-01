import { useQueryClient } from '@tanstack/react-query'
import {
  Cable,
  CalendarClock,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  GitFork,
  Save,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Accounts } from './accounts'
import { ConnectionCredentials, type CredentialProvider } from './connection-credentials'
import { Facts } from './detail'
import {
  type Connections,
  type GeekSlot,
  type Meta,
  modelLabel,
  platforms,
  positionLabels,
  roles,
  type Strategy,
  strategyCatalogFilters,
  type Settings as StrategyFields,
} from './models'
import { PersonalSettings } from './personal'
import { Select, selectOptions } from './select'
import {
  amount,
  Badge,
  date,
  dollars,
  ErrorBox,
  Field,
  Form,
  Loading,
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

function StrategyForm({ s, onSave }: { s: Strategy; onSave: () => void }) {
  const { admin } = useAccess(),
    [f, set] = useState<StrategyFields>({ ...s.settings, schedulePreset: s.settings.schedulePreset ?? (s.settings.scheduleEnabled ? 'custom' : 'potential') }),
    [tiers, setTiers] = useState(s.settings.tiers.join(', ')),
    [error, setError] = useState(''),
    save = useWrite(onSave),
    meta = useData<Meta>('/catalog/meta')
  const field = <K extends keyof StrategyFields>(k: K, v: StrategyFields[K]) => set({ ...f, [k]: v })
  const cats = meta.data?.categories.filter((c) => !c.platform || c.platform === f.platform) || []
  function submit() {
    const ns = tiers
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map(Number)
    if (
      !ns.length ||
      ns.length > 6 ||
      ns.some((n, i) => !Number.isSafeInteger(n) || n < 0 || (i > 0 && n >= ns[i - 1]))
    ) {
      setError('请填写 1 至 6 个从高到低的非负整数阈值。')
      return
    }
    setError('')
    save.mutate({ path: '/strategy', body: { baseVersion: s.version, settings: { ...f, tiers: ns } } })
  }
  return (
    <Form className="stack" onSubmit={submit}>
      <Panel title="发现策略" extra={<span className="subtle-pill">版本 v{s.version}</span>}>
        <div className="panel-body fields-2">
          <Field label="来源平台">
            <Select
              disabled={!admin}
              value={f.platform}
              onValueChange={(value) => set({ ...f, platform: value, categoryId: '' })}
              options={selectOptions({ temu: 'Temu', amazon: 'Amazon' })}
            />
          </Field>
          <Field label="来源类目">
            {f.platform === 'amazon' ? <input disabled={!admin} aria-label="Amazon 类目编号"
              placeholder="不限，或输入 Amazon 类目编号" value={f.categoryId}
              onChange={e => field('categoryId',e.target.value.replace(/\D/g,''))} /> : <Select
              disabled={!admin}
              value={f.categoryId}
              onValueChange={(value) => field('categoryId', value)}
              options={[
                { value: '', label: '不限' },
                ...cats.map((c) => ({
                  value: c.value.replace(/^[^:]+:/, ''),
                  label: c.label,
                })),
              ]}
            />}
          </Field>
          <Field label="关键词">
            <input
              disabled={!admin}
              maxLength={150}
              value={f.keyword}
              placeholder="可选"
              onChange={(e) => field('keyword', e.target.value)}
            />
          </Field>
          <Field label="价格上限（USD）">
            <input
              disabled={!admin}
              type="number"
              min="0"
              max="1000000"
              step=".01"
              value={f.maxPrice ?? ''}
              placeholder="不限"
              onChange={(e) => field('maxPrice', e.target.value === '' ? null : Number(e.target.value))}
            />
          </Field>
          <Field label="累计销量分层" hint="从高到低填写，边界值归入较高层。">
            <input disabled={!admin} value={tiers} onChange={(e) => setTiers(e.target.value)} />
          </Field>
          <Field label="每轮最多检索页数">
            <input
              disabled={!admin}
              type="number"
              required
              min="1"
              max="20"
              value={f.pageLimit}
              onChange={(e) => field('pageLimit', Number(e.target.value))}
            />
          </Field>
          <Field label="重点商品刷新上限" hint="按观察和跟进阶段选取重点商品。">
            <input
              disabled={!admin}
              required
              type="number"
              min="0"
              max="10"
              value={f.focusLimit}
              onChange={(e) => field('focusLimit', Number(e.target.value))}
            />
          </Field>
          <Field
            label="每轮自动研究商品上限"
            hint="每轮 0–3 件，按累计销量层优先选取。在线子研究共用每日 AI 预算，0 表示关闭。"
          >
            <input
              disabled={!admin}
              required
              type="number"
              min="0"
              max="3"
              value={f.researchLimit ?? 0}
              onChange={(e) => field('researchLimit', Number(e.target.value))}
            />
          </Field>
        </div>
      </Panel>
      <Panel title="调度与预算" extra={<Clock3 size={16} />}>
        <div className="panel-body stack">
          <div className="fields-2">
            <Field label="自动选品计划">
              <Select disabled={!admin} value={f.schedulePreset ?? 'potential'}
                onValueChange={(v) => field('schedulePreset', v === 'custom' ? 'custom' : 'potential')}
                options={[{value:'potential',label:'团队默认 · 潜力新品'},{value:'custom',label:'使用上方发现策略'}]} />
            </Field>
            <Field label="每日执行时间（北京时间）">
              <input
                disabled={!admin}
                type="time"
                value={f.scheduleTime}
                onChange={(e) => field('scheduleTime', e.target.value)}
              />
            </Field>
            <Field label="时区">
              <input value="Asia/Shanghai · UTC+8" readOnly />
            </Field>
            <Field label="每日数据积分上限">
              <input
                disabled={!admin}
                required
                type="number"
                min="0"
                max="100000"
                step="1"
                value={f.dataDailyPoints}
                onChange={(e) => field('dataDailyPoints', Number(e.target.value))}
              />
            </Field>
            <Field label="每日 AI 费用上限（USD）">
              <input
                disabled={!admin}
                required
                type="number"
                min="0"
                max="100"
                step="0.000001"
                value={f.aiDailyMicros / 1e6}
                onChange={(e) => field('aiDailyMicros', Math.round(Number(e.target.value) * 1e6))}
              />
            </Field>
          </div>
          <label className="switch-row">
            <span>
              <b>启用每日任务</b>
              <small>需要时间、有效发现条件和至少 10 积分的日预算。</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={f.scheduleEnabled}
              disabled={!admin}
              checked={f.scheduleEnabled}
              onChange={(e) => field('scheduleEnabled', e.target.checked)}
            />
          </label>
          <ErrorBox error={error || save.error} />
          <div className="dialog-actions">
            <button type="submit" className="primary" disabled={!admin || save.isPending}>
              <Save />
              {save.isPending ? '正在保存…' : '保存策略配置'}
            </button>
          </div>
        </div>
      </Panel>
    </Form>
  )
}
const employeeTabs = { schedule: '调度与预算', personal: '个人设置' }
const adminTabs = {
  connections: '数据连接',
  models: 'AI 模型',
  schedule: employeeTabs.schedule,
  members: '成员管理',
  personal: employeeTabs.personal,
}
function ListingFieldCheck({ configured }: { configured: boolean }) {
  const [sellerId, setSellerId] = useState('')
  const sample = useWrite<{
    sampled: number
    withSku: number
    withCreatedDate: number
    parent: number
    child: number
    standalone: number
    unknown: number
  }>()
  const result = sample.data
  return (
    <div className="panel-body stack">
      <h3>查询已刊登商品记录</h3>
      <p>按创建时间抽查美国站最近的最多 5 条刊登，核对 SKU、创建日期和变体关系。</p>
      <Form
        className="stack"
        onSubmit={() =>
          sample.mutate({
            path: '/connections/amazon/listing-fields',
            body: { sellerId: sellerId.trim() },
          })
        }
      >
        <Field label="Seller ID（Merchant Token）">
          <input
            autoComplete="off"
            placeholder="输入当前授权店铺的 Seller ID"
            value={sellerId}
            maxLength={64}
            required
            disabled={!configured || sample.isPending}
            onChange={(e) => {
              setSellerId(e.target.value)
              sample.reset()
            }}
          />
        </Field>
        <div className="spread">
          <a
            href="https://sellercentral.amazon.com/sw/AccountInfo/MerchantToken/step/MerchantToken"
            target="_blank"
            rel="noreferrer"
          >
            在卖家中心查看 Seller ID
          </a>
          <button
            type="submit"
            disabled={!configured || sample.isPending || !/^[A-Z0-9]{5,64}$/.test(sellerId.trim())}
          >
            {sample.isPending ? '正在读取…' : '查询刊登记录'}
          </button>
        </div>
      </Form>
      {result && (
        <Notice success>
          {result.sampled ? (
            <>
              本页 {result.sampled} 条，有 SKU {result.withSku} 条，有美国站创建日期{' '}
              {result.withCreatedDate} 条。按变体关系分为父商品 {result.parent} 条、子商品 {result.child}{' '}
              条、独立商品 {result.standalone} 条、关系待确认 {result.unknown} 条。
            </>
          ) : (
            '查询成功，本页没有可供核对的美国站刊登记录。'
          )}
        </Notice>
      )}
      <ErrorBox error={sample.error} />
    </div>
  )
}
export function Settings() {
  const { params } = useLocation(),
    go = useGo(),
    { admin, session } = useAccess()
  const tabs = admin ? adminTabs : employeeTabs
  const requested = params.get('tab')
  const tab =
    requested && Object.hasOwn(tabs, requested) ? requested : admin ? 'connections' : 'schedule'
  useEffect(() => {
    if (session && requested && requested !== tab) go('/settings?tab=' + tab, true)
  }, [session, requested, tab, go])
  const [listingVersion, setListingVersion] = useState(0)
  const [saved, setSaved] = useState(false),
    connections = useData<Connections>('/connections', admin && tab === 'connections'),
    strategy = useData<Strategy>(
      '/strategy',
      tab === 'schedule' || (admin && (tab === 'connections' || tab === 'models')),
    ),
    test = useWrite<{ status: string; message: string }>(() => void connections.refetch()),
    orders = useWrite<{
      orders: number
      haulOrders: number
      haulRows: number
      jit: number
      standard: number
      missingSku: number
      withQuantity: number
      withItemAmount: number
    }>()
  const c = connections.data,
    s = strategy.data
  const productDataConfigured = c?.productData?.configured ?? c?.geekbi?.configured ?? false
  const cache = useQueryClient()
  function credentialFields(names: string): [string, React.ReactNode][] {
    return admin ? [['凭据字段', <code key="fields">{names}</code>]] : []
  }
  function credentialControl(provider: CredentialProvider) {
    if (!admin || !c) return null
    return (
      <ConnectionCredentials
        provider={provider}
        configured={provider === 'geekbi' ? productDataConfigured : c[provider].configured}
        available={c.credentialEditing}
        slots={provider === 'geekbi' ? c.geekbi?.slots : undefined}
        onSaved={() => {
          if (provider === 'amazon') {
            test.reset()
            orders.reset()
            setListingVersion((previous) => previous + 1)
          }
          void cache.invalidateQueries()
        }}
      />
    )
  }
  return (
    <>
      <Title
        eyebrow="WORKSPACE SETTINGS"
        title={admin ? '数据与模型设置' : '工作台设置'}
        desc={
          admin
            ? '管理团队连接、研究模型、调度与预算、成员和个人偏好。'
            : '查看团队调度与预算，管理个人偏好和选品预设。'
        }
      />
      <div className="tabs">
        {Object.entries(tabs).map(([k, v]) => (
          <button
            type="button"
            className={tab === k ? 'active' : ''}
            aria-pressed={tab === k}
            key={k}
            onClick={() => go('/settings?tab=' + k)}
          >
            {v}
          </button>
        ))}
      </div>
      {admin && tab === 'connections' && (
        <div className="workspace-two">
          <div className="stack">
            {connections.isPending ? (
              <Loading />
            ) : connections.isError ? (
              <ErrorBox error={connections.error} retry={() => void connections.refetch()} />
            ) : (
              <>
                <Connector
                  name="极鲸云 API"
                  desc="跨平台商品、销量与历史观测"
                  icon={<Database />}
                  tone="product-data"
                  configured={productDataConfigured}
                  action={credentialControl('geekbi')}
                >
                  <Facts
                    rows={[
                      ['当前选品来源', 'Temu、Amazon 美国站'],
                      [
                        '使用顺序',
                        '从第 1 组开始，跳过空组。收到明确的余额不足回执后，在团队预算内尝试下一组。',
                      ],
                      ...credentialFields('GB_APP_KEY / GB_APP_SECRET'),
                    ]}
                  />
                  {c!.geekbi?.slots && (
                    <GeekbiChecks slots={c!.geekbi.slots} reload={() => void connections.refetch()} />
                  )}
                </Connector>
                <Connector
                  name="Amazon SP-API"
                  desc="核对商品目录、Haul 订单和店铺已有的刊登记录"
                  icon={<span>a</span>}
                  tone="amazon"
                  configured={c!.amazon.configured}
                  action={credentialControl('amazon')}
                >
                  <Facts
                    rows={[
                      ['目标站点', 'Amazon 美国站'],
                      [
                        '目录测试',
                        c!.amazon.status === 'catalog_verified'
                          ? '已验证目录检索'
                          : c!.amazon.status === 'unconfigured'
                            ? '等待配置'
                            : c!.amazon.status === 'untested'
                              ? '待测试'
                              : c!.amazon.status,
                      ],
                      ['最近测试', date(c!.amazon.lastTestedAt, true)],
                      ...credentialFields('SP_CLIENT_ID / SP_CLIENT_SECRET / SP_REFRESH_TOKEN'),
                    ]}
                  />
                  <div className="panel-end">
                    <span className="muted">绑定凭据后可核对美国站目录权限。</span>
                    <button
                      type="button"
                      disabled={!admin || !c!.amazon.configured || test.isPending}
                      onClick={() =>
                        test.mutate(
                          { path: '/connections/amazon/test', body: {} },
                          { onError: () => void connections.refetch() },
                        )
                      }
                    >
                      <Cable />
                      {test.isPending ? '测试中…' : '测试连接'}
                    </button>
                  </div>
                  {test.data && <Notice success>{test.data.message}</Notice>}
                  <ErrorBox error={test.error} />
                  <div className="panel-end">
                    <span className="muted">
                      抽查最近 7 天的最多 5 笔美国站订单，核对 Haul 标记和明细字段。
                    </span>
                    <button
                      type="button"
                      disabled={!c!.amazon.configured || orders.isPending}
                      onClick={() =>
                        orders.mutate({ path: '/connections/amazon/order-fields', body: {} })
                      }
                    >
                      {orders.isPending ? '正在核对…' : '核对订单字段'}
                    </button>
                  </div>
                  {orders.data && (
                    <Notice success>
                      读取 {orders.data.orders} 笔订单，其中 {orders.data.haulOrders} 笔带有 Haul 标记。
                      {orders.data.haulRows > 0
                        ? `共 ${orders.data.haulRows} 行，JIT ${orders.data.jit} 行，标准备货 ${orders.data.standard} 行，缺 SKU ${orders.data.missingSku} 行。有订购数量 ${orders.data.withQuantity} 行，有美元商品金额 ${orders.data.withItemAmount} 行。`
                        : '本页没有 Haul 明细可供核对。'}
                    </Notice>
                  )}
                  <ErrorBox error={orders.error} />
                  <ListingFieldCheck key={listingVersion} configured={c!.amazon.configured} />
                </Connector>
                <Connector
                  name="OpenRouter"
                  desc="研究模型与结构化决策"
                  icon={<GitFork />}
                  tone="router"
                  configured={c!.openrouter.configured}
                  action={credentialControl('openrouter')}
                >
                  <Facts
                    rows={[
                      ['费用口径', '按实际用量计费 · USD'],
                      ...credentialFields('OPENROUTER_API_KEY'),
                    ]}
                  />
                </Connector>
              </>
            )}
          </div>
          <div className="stack">
            <Panel title="当前调度策略" extra={<CalendarClock size={16} />}>
              <Facts
                rows={[
                  ['策略版本', s ? 'v' + s.version : '待载入'],
                  ['每日任务', s ? (s.settings.scheduleEnabled ? '已启用' : '未启用') : '待载入'],
                  ['执行时间', s?.settings.scheduleTime || '待设置'],
                  ['每日数据上限', amount(s?.settings.dataDailyPoints) + ' 积分'],
                  ['每日 AI 上限', dollars(s?.settings.aiDailyMicros)],
                ]}
              />
              <div className="panel-end">
                <PageLink href="/settings?tab=schedule" className="btn">
                  管理调度与预算 <ChevronRight />
                </PageLink>
              </div>
            </Panel>
            {c && (
              <Notice>
                {c.credentialEditing
                  ? '使用各服务卡片上的按钮配置或更新凭据。保存后可单独测试 Amazon 目录连接。'
                  : '服务端尚未启用凭据保存。请联系部署管理员启用连接凭据加密。'}
              </Notice>
            )}
          </div>
        </div>
      )}
      {tab === 'schedule' &&
        (strategy.isPending ? (
          <Loading />
        ) : strategy.isError ? (
          <ErrorBox error={strategy.error} retry={() => void strategy.refetch()} />
        ) : (
          <div className="workspace-two">
            <div className="stack">
              {admin && saved && <Notice success>策略配置已保存。后续任务使用新版本。</Notice>}
              {admin ? (
                <StrategyForm
                  key={strategy.data.version}
                  s={strategy.data}
                  onSave={() => setSaved(true)}
                />
              ) : (
                <>
                  <Panel title="团队发现策略" extra={<span className="subtle-pill">版本 v{s!.version}</span>}>
                    <Facts rows={[
                      ['来源平台', platforms[s!.settings.platform] || '不限'],
                      ['关键词', s!.settings.keyword || '不限'],
                      ['价格上限', s!.settings.maxPrice == null ? '不限' : 'USD ' + s!.settings.maxPrice],
                      ['销量分层', s!.settings.tiers?.map((n) => '累计销量至少 ' + amount(n)).join(' / ') || '不限'],
                    ]} />
                    <div className="panel-end">
                      <PageLink className="linkbtn" href={'/?' + strategyCatalogFilters(s!.settings)}>
                        以此筛选商品，可另存为我的预设 <ChevronRight size={14} />
                      </PageLink>
                    </div>
                  </Panel>
                  <Panel title="团队调度与预算" extra={<span className="subtle-pill">只读</span>}>
                    <Facts
                      rows={[
                        ['每日任务', s!.settings.scheduleEnabled ? '已启用' : '未启用'],
                        ['执行时间（北京时间）', s!.settings.scheduleTime || '未设置'],
                        ['每日数据积分上限', amount(s!.settings.dataDailyPoints) + ' 积分'],
                        ['每日 AI 费用上限', dollars(s!.settings.aiDailyMicros)],
                      ]}
                    />
                  </Panel>
                </>
              )}
            </div>
            <Panel title="今日预算记录">
              <Facts
                rows={[
                  ['商品数据用量', amount(s?.usage.dataPoints) + ' 积分'],
                  ['AI 费用', dollars(s?.usage.aiMicros)],
                  [
                    '其中待核账',
                    amount(s?.usage.unconfirmedDataPoints) +
                      ' 积分 / ' +
                      dollars(s?.usage.unconfirmedAiMicros),
                  ],
                  ['结算时区', 'Asia/Shanghai'],
                ]}
              />
              <div className="panel-end">
                <PageLink className="linkbtn" href="/tasks">
                  查看任务中心 <ChevronRight size={14} />
                </PageLink>
              </div>
            </Panel>
          </div>
        ))}
      {admin && tab === 'models' && (
        <div className="stack">
          <Panel title="研究与决策模型" extra={<Cpu size={16} />}>
            <Facts
              rows={[
                ['模型服务', 'OpenRouter'],
                ['研究模型', modelLabel(s?.models?.research)],
                ['决策模型', modelLabel(s?.models?.decision)],
                ['决策路由', 'Decisions API'],
                ['AI 每日上限', dollars(s?.settings.aiDailyMicros)],
              ]}
            />
          </Panel>
          <Notice>在线研究须有服务端凭据和可用预算，任务结果保留模型和证据记录。</Notice>
          <ErrorBox error={strategy.error} />
        </div>
      )}
      {tab === 'personal' && session && (
        <div className="stack">
          <Panel title="我的账号">
            <Facts
              rows={[
                ['账号', session.username || session.email],
                ['职位', session.position ? positionLabels[session.position] : '未设置'],
                ['角色', roles[session.role]],
              ]}
            />
          </Panel>
          <PersonalSettings />
        </div>
      )}
      {admin && tab === 'members' && (
        <div className="stack">
          {session && <Accounts session={session} />}
          <Panel title="当前访问权限" extra={<ShieldCheck size={16} />}>
            <Facts
              rows={[
                ['账号', session?.username || session?.email],
                ['角色', roles[session?.role || ''] || '待载入'],
                ['登录方式', session?.local ? '本机开发会话' : '账号密码'],
              ]}
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>可执行操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>管理员</td>
                    <td>管理成员账号，配置连接与策略，设置预算，执行任务与复核</td>
                  </tr>
                  <tr>
                    <td>运营</td>
                    <td>创建研究，跟进候选，执行商品复核</td>
                  </tr>
                  <tr>
                    <td>只读</td>
                    <td>查看商品、证据、研究和任务结果</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </>
  )
}
function GeekbiChecks({ slots, reload }: { slots: GeekSlot[]; reload: () => void }) {
  const test = useWrite<{ slot: number; testedAt: string }>(reload)
  return (
    <div className="slot-checks">
      <h3>密钥组与今日用量</h3>
      <p className="muted">
        验证只读取免费站点列表。付费查询的余额以服务商回执为准。用量按北京时间统计。
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>密钥组</th>
              <th>连接状态</th>
              <th>已记积分</th>
              <th>待核积分</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.slot}>
                <th scope="row">第 {s.slot} 组</th>
                <td>
                  {s.binding === 'locked'
                    ? '无法读取凭据'
                    : s.binding === 'incomplete'
                      ? '缺少配对字段'
                      : !s.configured
                        ? '未绑定'
                        : s.balanceRefused
                          ? '今日余额不足'
                          : s.testStatus === 'verified'
                            ? '签名已验证'
                            : s.testStatus === 'failed'
                              ? '验证失败'
                              : '已绑定 · 待验证'}
                  {s.lastTestedAt && <small className="slot-date">{date(s.lastTestedAt, true)}</small>}
                </td>
                <td>{s.confirmedPoints ?? '—'}</td>
                <td>{s.pendingPoints ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    disabled={!s.configured || test.isPending}
                    aria-label={'验证第 ' + s.slot + ' 组签名'}
                    onClick={() =>
                      test.mutate(
                        { path: '/connections/geekbi/slots/' + s.slot + '/test', body: {} },
                        { onError: reload },
                      )
                    }
                  >
                    验证签名
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {test.data && <Notice success>第 {test.data.slot} 组签名已通过美国站列表验证。</Notice>}
      <ErrorBox error={test.error} />
    </div>
  )
}
function Connector({
  name,
  desc,
  icon,
  tone,
  configured,
  action,
  children,
}: {
  name: string
  desc: string
  icon: React.ReactNode
  tone: string
  configured: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Panel>
      <div className="connection-head">
        <div className={'connector-icon ' + tone}>{icon}</div>
        <div>
          <h2>{name}</h2>
          <p>{desc}</p>
        </div>
        <Badge tone={configured ? 'blue' : 'amber'}>{configured ? '已绑定' : '待配置'}</Badge>
        {action}
      </div>
      {children}
    </Panel>
  )
}
