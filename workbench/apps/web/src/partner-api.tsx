import { useState } from 'react'
import { type Permission, permissions } from '../../../packages/partner-api/permissions'
import { date, ErrorBox, Field, Form, Loading, Notice, Panel, useData, useWrite } from './ui'

type Client = {
  linked: boolean
  id: string
  name: string
  seller: string
  active: number
  expires_at: number
  permissions: Permission[]
}
type Entry = {
  id: string
  clientId: string
  operation: Permission
  status: string
  reviewer: string | null
  createdAt: number
  outcome: string | null
  reference: string | null
  input: {
    sku: string
    quantity?: number
    cents?: number
    expectedQuantity?: number
    expectedCents?: number
    audience?: string
  }
}
type Call = {
  id: string
  client_id: string | null
  actor: string | null
  operation: string
  scope: string | null
  status: number
  row_count: number | null
  created_at: number
}
type Overview = {
  writesEnabled: boolean
  clients: Client[]
  requests: Entry[]
  audit: Call[]
  auditBefore: number | null
}
const entries = Object.entries(permissions) as [Permission, (typeof permissions)[Permission]][]
const stamp = (value: number) => date(new Date(value).toISOString(), true)
const statuses: Record<string, string> = {
  PENDING: '待审批',
  APPROVED: '已批准，待仓库处理',
  SENDING: '提交中',
  ACCEPTED: 'Amazon 已接收，待生效',
  REJECTED: '已拒绝',
  UNKNOWN: '待核对',
  CANCELLED: '已取消',
  CONFIRMED: '已核实',
}
const auditLabels: Record<string, string> = {
  'connection.read': '检查连接',
  'write.status': '读取写入状态',
  'admin.client.create': '创建接入',
  'admin.client.active': '变更接入状态',
  'admin.client.permission': '变更权限',
  'admin.writes': '变更写入总开关',
  'admin.client.rotate': '轮换令牌',
  'admin.request': '处理写入申请',
}
const outcomes: Record<string, string> = {
  WRITE_DISABLED: '写入总开关已关闭',
  PERMISSION_CHANGED: '接入权限已变更',
  CLIENT_PAUSED: '接入已暂停',
  TOKEN_ROTATED: '令牌已轮换',
  ADMIN_REJECTED: '管理员拒绝',
  CHECK_AMAZON_BEFORE_RETRY: '结果不明确，请先核对 Amazon',
  CURRENT_VALUE_CHANGED: '当前值已变化',
  OFFER_NOT_ELIGIBLE: '无法确认指定报价或价格计划',
  INVENTORY_CHANNEL_NOT_SUPPORTED: '当前库存渠道需通过 SellerFlex 或原仓库流程处理',
  WAREHOUSE_ACTION_REQUIRED: '通过 SellerFlex 核对并处理，完成后在此登记',
  UNEXPECTED_PREVIEW_ACCEPTED: 'Amazon 预检回执异常，请先核对当前值',
  LIVE_TARGET_OBSERVED: '已读到目标值',
  ALREADY_AT_TARGET: '当前值已达到目标',
  PRECHECK_FAILED: '提交前检查失败',
}

export function PartnerApiSettings() {
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState(7)
  const [token, setToken] = useState('')
  const [filter, setFilter] = useState('')
  const [before, setBefore] = useState<number | null>(null)
  const [decision, setDecision] = useState<{ path: string; body: object; message: string } | null>(null)
  const query = new URLSearchParams()
  if (filter) query.set('clientId', filter)
  if (before) query.set('before', String(before))
  const base = '/partner-admin'
  const overview = useData<Overview>(base + (query.size ? '?' + query : ''), true, 15000)
  const write = useWrite<{ token?: string }>((value) => {
    if (value.token) setToken(value.token)
    setDecision(null)
    void overview.refetch()
  })
  const mutate = (path: string, body: object) => write.mutate({ path: base + path, body })
  if (overview.isPending) return <Loading />
  if (overview.isError) return <ErrorBox error={overview.error} retry={() => void overview.refetch()} />
  const data = overview.data
  const clientName = (id?: string | null) => data.clients.find((c) => c.id === id)?.name ?? '—'
  return (
    <div className="stack">
      <Panel title="业务 API">
        <div className="panel-body stack">
          <p>
            按接入方管理美国站权限。新接入默认开放销量、商品和库存读取。写入须开启总开关、授予对应权限，再逐笔审批。
          </p>
          <div>
            <strong>写入总开关 · {data.writesEnabled ? '已开启' : '已关闭'}</strong>{' '}
            <button
              type="button"
              className="btn"
              disabled={write.isPending}
              onClick={() =>
                setDecision({
                  path: '/writes',
                  body: { enabled: !data.writesEnabled },
                  message: data.writesEnabled
                    ? '关闭后会取消所有待审批的写入。'
                    : '开启后，拥有对应写入权限的接入方可以提交申请。',
                })
              }
            >
              {data.writesEnabled ? '关闭写入' : '开启写入'}
            </button>
          </div>
          {write.error && <ErrorBox error={write.error} />}
          {decision && (
            <Notice>
              {decision.message}{' '}
              <button
                type="button"
                className="btn"
                disabled={write.isPending}
                onClick={() => mutate(decision.path, decision.body)}
              >
                确认
              </button>{' '}
              <button
                type="button"
                className="btn"
                disabled={write.isPending}
                onClick={() => setDecision(null)}
              >
                取消
              </button>
            </Notice>
          )}
          {token && (
            <Notice success>
              令牌只显示这一次。
              <input aria-label="接入令牌" readOnly value={token} onFocus={(e) => e.target.select()} />{' '}
              <button type="button" className="btn" onClick={() => setToken('')}>
                已保存
              </button>
            </Notice>
          )}
          <Form
            onSubmit={() => {
              setToken('')
              mutate('/clients', { name, days: expiry })
            }}
          >
            <div className="fields-2">
              <Field label="接入方名称">
                <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="令牌有效天数">
                <input
                  type="number"
                  required
                  min={1}
                  max={90}
                  value={expiry}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                />
              </Field>
            </div>
            <button className="btn primary" type="submit" disabled={write.isPending || !name.trim()}>
              创建只读接入
            </button>
          </Form>
        </div>
      </Panel>
      <Panel title="接入方与权限">
        <div className="panel-body stack">
          {!data.clients.length && <p>暂无接入方。</p>}
          {data.clients.map((client) => (
            <details key={client.id}>
              <summary>
                {client.name} · {client.seller} ·{' '}
                {client.active
                  ? !client.linked
                    ? '待重新绑定'
                    : client.expires_at > Date.now()
                      ? '启用'
                      : '已过期'
                  : '暂停'}{' '}
                · 到期 {stamp(client.expires_at)}
              </summary>
              <div className="stack">
                <div>
                  <button
                    type="button"
                    className="btn"
                    disabled={write.isPending}
                    onClick={() =>
                      setDecision({
                        path: '/clients/' + client.id + '/active',
                        body: { enabled: !client.active },
                        message: client.active
                          ? '暂停 ' + client.name + ' 并取消此接入方待审批的写入。'
                          : '恢复 ' + client.name + ' 的接入。',
                      })
                    }
                  >
                    {client.active ? '暂停接入' : '恢复接入'}
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    disabled={write.isPending}
                    onClick={() =>
                      setDecision({
                        path: '/clients/' + client.id + '/rotate',
                        body: { days: expiry },
                        message:
                          '核验当前 Amazon 授权并更新绑定。旧令牌立即失效，新令牌有效期为 ' +
                          expiry +
                          ' 天。',
                      })
                    }
                  >
                    轮换令牌
                  </button>
                </div>
                {(['read', 'write'] as const).map((mode) => (
                  <fieldset key={mode}>
                    <legend>{mode === 'read' ? '读取权限' : '写入权限'}</legend>
                    <div className="fields-2">
                      {entries
                        .filter(([, p]) => p.mode === mode)
                        .map(([key, permission]) => (
                          <label key={key}>
                            <input
                              type="checkbox"
                              checked={client.permissions.includes(key)}
                              disabled={write.isPending}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                const path = '/clients/' + client.id + '/permissions'
                                const body = { permission: key, enabled }
                                if (mode === 'write' && enabled)
                                  setDecision({
                                    path,
                                    body,
                                    message:
                                      '授予 ' + client.name + '「' + permission.label + '」权限。',
                                  })
                                else mutate(path, body)
                              }}
                            />{' '}
                            {permission.label}
                          </label>
                        ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </details>
          ))}
        </div>
      </Panel>
      <Panel title="写入申请">
        <div className="panel-body stack">
          {!data.requests.length && <p>暂无写入申请。</p>}
          {data.requests.map((row) => {
            const path = '/requests/' + row.id
            const price = row.input.cents !== undefined
            const current = price ? row.input.expectedCents : row.input.expectedQuantity
            return (
              <div key={row.id} className="stack">
                <strong>
                  {row.input.sku} · {permissions[row.operation].label} ·{' '}
                  {statuses[row.status] ?? row.status}
                </strong>
                <span>
                  {clientName(row.clientId)} · {stamp(row.createdAt)} ·{' '}
                  {current === undefined
                    ? ''
                    : (price ? '$' + (current / 100).toFixed(2) : current) + ' → '}
                  {price
                    ? '$' +
                      (row.input.cents! / 100).toFixed(2) +
                      ' ' +
                      (row.input.audience === 'BZR' ? 'Haul' : '普通报价')
                    : row.input.quantity + ' 件'}
                  {row.outcome && ' · ' + (outcomes[row.outcome] ?? row.outcome)}
                  {row.reference && ' · ' + row.reference}
                </span>
                {row.status === 'PENDING' && (
                  <div>
                    <button
                      type="button"
                      className="btn"
                      disabled={write.isPending || !data.writesEnabled}
                      onClick={() =>
                        setDecision({
                          path: path + '/approve',
                          body: {},
                          message:
                            row.operation === 'inventory.request'
                              ? '批准此库存调整申请，交由仓库处理。'
                              : '批准后将先核对当前值，预检通过才向 Amazon 提交。',
                        })
                      }
                    >
                      批准
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      disabled={write.isPending}
                      onClick={() => mutate(path + '/reject', {})}
                    >
                      拒绝
                    </button>
                  </div>
                )}
                {['SENDING', 'APPROVED', 'ACCEPTED', 'UNKNOWN'].includes(row.status) && (
                  <div>
                    {['ACCEPTED', 'UNKNOWN'].includes(row.status) && (
                      <button
                        type="button"
                        className="btn"
                        disabled={write.isPending}
                        onClick={() => mutate(path + '/reconcile', {})}
                      >
                        查询 Amazon 当前值
                      </button>
                    )}{' '}
                    <button
                      type="button"
                      className="btn"
                      disabled={write.isPending}
                      onClick={() =>
                        setDecision({
                          path: path + '/close',
                          body: { outcome: 'CONFIRMED' },
                          message: '仅在已通过 Amazon 或仓库核实目标值生效后确认。',
                        })
                      }
                    >
                      登记已核实
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      disabled={write.isPending}
                      onClick={() =>
                        setDecision({
                          path: path + '/close',
                          body: { outcome: 'REJECTED' },
                          message: '仅在核实没有待执行的 Amazon 或仓库任务后关闭此申请。',
                        })
                      }
                    >
                      登记未执行
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Panel>
      <Panel title="调用记录">
        <div className="panel-body stack">
          <Field label="接入方">
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setBefore(null)
              }}
            >
              <option value="">全部</option>
              {data.clients.map((client) => (
                <option value={client.id} key={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </Field>
          {!data.audit.length && <p>暂无调用记录。</p>}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>接入方 / 管理员</th>
                  <th>操作</th>
                  <th>查询范围</th>
                  <th>状态</th>
                  <th>条数</th>
                </tr>
              </thead>
              <tbody>
                {data.audit.map((row) => (
                  <tr key={row.id}>
                    <td>{stamp(row.created_at)}</td>
                    <td>
                      {clientName(row.client_id)}
                      {row.actor ? ' / ' + row.actor : ''}
                    </td>
                    <td>
                      {auditLabels[row.operation] ??
                        permissions[row.operation as Permission]?.label ??
                        row.operation}
                    </td>
                    <td>{row.scope ?? '—'}</td>
                    <td>{row.status}</td>
                    <td>{row.row_count ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            {before && (
              <button type="button" className="btn" onClick={() => setBefore(null)}>
                返回最新记录
              </button>
            )}{' '}
            {data.auditBefore && (
              <button type="button" className="btn" onClick={() => setBefore(data.auditBefore)}>
                更早记录
              </button>
            )}
          </div>
        </div>
      </Panel>
    </div>
  )
}
