import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Select } from './select'
import { Badge, Dialog, ErrorBox, Field, Form, Loading, Notice, Panel, request, useData, useWrite } from './ui'
import './infringement-notifications.css'

const path = '/group-notifications'
const service = 'infringement'

type Group = {
  id: string
  name: string
  webhookKey: string | null
  webhookHint?: string | null
  status: 'active' | 'test' | 'paused'
  services: string[]
}
type Member = { accountId: string; name: string; userid: string | null; enabled: boolean }
type Delivery = {
  id: string
  phase: 'text' | 'image'
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'
  error: string | null
}

function finished(delivery?: Delivery) {
  return !!delivery && delivery.status !== 'queued' && delivery.status !== 'sending'
}

function AddGroup({ onClose, onAdded, dailySales = false }: {
  onClose: () => void
  onAdded: (id: string) => void
  dailySales?: boolean
}) {
  const [name, setName] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const save = useWrite<{ id: string }>(({ id }) => onAdded(id))
  const valid = name.trim() && webhookUrl.trim()

  return (
    <Dialog title="新增企业微信群" onClose={() => { if (!save.isPending) onClose() }}>
      <Form className="panel-body stack" onSubmit={() => {
        if (valid && !save.isPending) {
          save.mutate({
            path: `${path}/groups`,
            body: { name: name.trim(), webhookUrl: webhookUrl.trim(), enabled: true, ...(dailySales ? { dailySales } : {}) },
          })
        }
      }}>
        <Field label="群名称">
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
        </Field>
        <Field label="机器人 Webhook 链接" hint="粘贴企业微信群机器人提供的完整链接。保存后仅显示末四位。">
          <input
            type="password"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            placeholder="https://qyapi.weixin.qq.com/…"
            maxLength={512}
            autoComplete="off"
            required
          />
        </Field>
        {save.isError && <ErrorBox error={save.error} />}
        <div className="infringement-notification-buttons">
          <button type="button" onClick={onClose} disabled={save.isPending}>取消</button>
          <button type="submit" className="primary" disabled={!valid || save.isPending}>
            {save.isPending ? '正在保存…' : '保存群'}
          </button>
        </div>
      </Form>
    </Dialog>
  )
}

export function DailySalesNotifications() {
  const statusPath = path + '/daily-sales'
  const [adding, setAdding] = useState(false)
  const status = useData<{
    run: { status: 'running' | 'ready' | 'failed'; error: string | null } | null
    preview: string | null
    target: { id: string; name: string; webhookHint: string | null; scheduled: number } | null
    trial: Pick<Delivery, 'status' | 'error'> | null
  }>(statusPath, true, 3000)
  const preview = useWrite()
  const trial = useWrite()
  const schedule = useWrite()
  if (status.isPending) return <Loading />
  if (status.isError) return <ErrorBox error={status.error} retry={() => void status.refetch()} />
  const { run, target, trial: lastTrial } = status.data
  const trialPending = lastTrial?.status === 'queued' || lastTrial?.status === 'sending'
  return (
    <div className="stack infringement-notification-settings">
      <Panel title="销量日报机器人">
        <div className="panel-body stack">
          <p>北京时间每天 08:00、17:00、23:00 汇总上一时段销量。17:00 同时附上美西上一完整自然日的日报。群消息会 @所有人。</p>
          {target ? (
            <div className="infringement-notification-current">
              <strong>{target.name}</strong>
              {target.webhookHint && <span className="muted">Webhook 尾号 {target.webhookHint}</span>}
              <Badge tone={target.scheduled ? 'blue' : 'neutral'}>{target.scheduled ? '自动推送已启用' : '待启用'}</Badge>
            </div>
          ) : <Notice>请在目标企微群创建新的群机器人，再登记它的 Webhook。</Notice>}
          <div className="infringement-notification-buttons">
            <button type="button" onClick={() => setAdding(true)} disabled={!!target?.scheduled}>
              {target ? '更换机器人' : '添加 Webhook'}
            </button>
            {target && (
              <>
                <button type="button" disabled={!status.data.preview || trial.isPending || trialPending || run?.status === 'running'}
                  onClick={() => trial.mutate({ path: `${path}/groups/${target.id}/trial`, body: { service: 'daily-sales' } })}>
                  {trialPending ? '正在试发…' : '试发到群'}
                </button>
                <button type="button" className={target.scheduled ? undefined : 'primary'}
                  disabled={schedule.isPending || (!target.scheduled && lastTrial?.status !== 'sent')}
                  onClick={() => schedule.mutate({
                    path: `${path}/services/daily-sales`, body: { groupId: target.scheduled ? null : target.id },
                  })}>
                  {target.scheduled ? '暂停自动推送' : '启用每日推送'}
                </button>
              </>
            )}
          </div>
          <ErrorBox error={trial.error || schedule.error || lastTrial?.error} />
          {lastTrial?.status === 'sent' && <Notice success>企微已接收试发，请核对群消息。</Notice>}
        </div>
      </Panel>
      <Panel title="日报预览" extra={
        <button type="button" disabled={preview.isPending || run?.status === 'running'}
          onClick={() => preview.mutate({ path: `${statusPath}/preview`, body: {} })}>
          {run?.status === 'running' ? '正在读取订单…' : '生成预览'}
        </button>
      }>
        <div className="panel-body stack">
          <ErrorBox error={preview.error || run?.error} />
          {status.data.preview
            ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{status.data.preview}</pre>
            : <Notice>生成预览后可查看 Amazon 实际销量并试发。</Notice>}
        </div>
      </Panel>
      {adding && <AddGroup dailySales onClose={() => setAdding(false)} onAdded={() => setAdding(false)} />}
    </div>
  )
}

function GroupMembers({ groupId }: { groupId: string }) {
  const memberPath = `${path}/groups/${groupId}/members`
  const members = useData<{ members: Member[] }>(memberPath)
  const save = useWrite()

  if (members.isPending) return <Loading />
  if (members.isError) return <ErrorBox error={members.error} retry={() => void members.refetch()} />
  if (!members.data.members.length) return <Notice>目前没有可配置的运营账号。</Notice>

  return (
    <div className="stack">
      <p className="muted">启用已加入该群的成员。缺少 UserID 时，请先到差评专区绑定企业微信账号。</p>
      {save.isError && <ErrorBox error={save.error} />}
      <div className="table-scroll">
        <table>
          <thead><tr><th>运营</th><th>企业微信 UserID</th><th>启用</th></tr></thead>
          <tbody>
            {members.data.members.map((entry) => (
              <tr key={entry.accountId}>
                <td>{entry.name}</td>
                <td>{entry.userid || '未绑定'}</td>
                <td>
                  <input
                    aria-label={`启用 ${entry.name}`}
                    type="checkbox"
                    checked={entry.enabled}
                    disabled={save.isPending || members.isFetching || (!entry.userid && !entry.enabled)}
                    onChange={(event) => save.mutate({
                      path: memberPath,
                      body: { accountId: entry.accountId, enabled: event.target.checked },
                    })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ChangeGroup({ current, target, onSwitched }: {
  current?: Group
  target: Group
  onSwitched: () => void
}) {
  const [accountId, setAccountId] = useState('')
  const [sku, setSku] = useState('')
  const [confirm, setConfirm] = useState(false)
  const groupPath = `${path}/groups/${target.id}`
  const members = useData<{ members: Member[] }>(`${groupPath}/members`)
  const eligible = members.data?.members.filter((member) => member.enabled && member.userid) ?? []
  const member = eligible.find((entry) => entry.accountId === accountId)
  const trial = useWrite<{ id: string }>()
  const deliveryPath = `${groupPath}/deliveries`
  const delivery = useQuery({
    queryKey: [deliveryPath],
    queryFn: () => request<{ deliveries: Delivery[] }>(deliveryPath),
    enabled: !!trial.data?.id,
    refetchInterval: (query) =>
      finished(query.state.data?.deliveries.find((item) => item.id === trial.data?.id)) ? false : 1500,
    retry: false,
  })
  const result = delivery.data?.deliveries.find((item) => item.id === trial.data?.id)
  const ready = result?.status === 'sent'
  const waiting = trial.isPending || (!!trial.data?.id && !finished(result))
  const change = useWrite(onSwitched)

  function sendTrial() {
    if (!member || waiting) return
    trial.mutate({
      path: `${groupPath}/trial`,
      body: { service, accountId: member.accountId, ...(sku.trim() && { sku: sku.trim() }) },
    })
  }

  return (
    <div className="stack infringement-notification-actions">
      <div className="fields-2">
        <Field label="试发接收人">
          <Select
            value={accountId}
            disabled={members.isPending || !eligible.length || waiting}
            onValueChange={(value) => { setAccountId(value); trial.reset() }}
            options={[
              { value: '', label: '选择已启用的成员', disabled: true },
              ...eligible.map((entry) => ({ value: entry.accountId, label: entry.name })),
            ]}
          />
        </Field>
        <Field label="试发商品 SKU" hint="可选。留空时使用已有的带主图样例。">
          <input
            value={sku}
            maxLength={120}
            disabled={waiting}
            placeholder="输入要试发的 SKU"
            onChange={(event) => { setSku(event.target.value); trial.reset() }}
          />
        </Field>
      </div>
      {members.isError && <ErrorBox error={members.error} retry={() => void members.refetch()} />}
      {members.isSuccess && !eligible.length && <Notice>这个群还没有已启用并绑定企业微信的成员。</Notice>}
      <div className="infringement-notification-buttons">
        <button type="button" disabled={!member || waiting} onClick={sendTrial}>
          {trial.isPending ? '正在提交试发…' : '试发到目标群'}
        </button>
        <button type="button" className="primary" disabled={!ready || !member} onClick={() => setConfirm(true)}>
          切换自动推送
        </button>
      </div>
      {trial.isError && <ErrorBox error={trial.error} />}
      {trial.data && waiting && !delivery.isError && (
        <Notice>{result?.phase === 'image' ? '文字已送达，正在等待主图。' : '已提交试发，正在等待发送结果。'}</Notice>
      )}
      {delivery.isError && <ErrorBox error={delivery.error} retry={() => void delivery.refetch()} />}
      {result && finished(result) && (ready
        ? <Notice success>试发已送达「{target.name}」。核对群内文字、主图和 @ 后，可以切换自动推送。</Notice>
        : <ErrorBox error={result.error || '试发未确认送达。请核对群内消息后重试。'} />)}
      {confirm && (
        <Dialog title="确认切换自动推送" onClose={() => { if (!change.isPending) setConfirm(false) }}>
          <div className="panel-body stack">
            <p>之后的侵权提醒将发往 <strong>{target.name}</strong>。</p>
            {current && <p className="muted">切换前的接收群为「{current.name}」。</p>}
            <ErrorBox error={change.error} />
            <div className="infringement-notification-buttons">
              <button type="button" disabled={change.isPending} onClick={() => { change.reset(); setConfirm(false) }}>取消</button>
              <button
                type="button"
                className="primary"
                disabled={!ready || !member || change.isPending}
                onClick={() => change.mutate({ path: `${path}/services/${service}`, body: { groupId: target.id } })}
              >
                {change.isPending ? '正在切换…' : '确认切换'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

export function InfringementNotifications() {
  const groupsQuery = useData<{ groups: Group[] }>(path)
  const [targetId, setTargetId] = useState('')
  const [switchedTo, setSwitchedTo] = useState('')
  const [adding, setAdding] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState('')
  if (groupsQuery.isPending) return <Loading />
  if (groupsQuery.isError) return <ErrorBox error={groupsQuery.error} retry={() => void groupsQuery.refetch()} />

  const groups = groupsQuery.data.groups
  const current = groups.find((group) => group.services.includes(service))
  const candidates = groups.filter((group) => group.id !== current?.id && group.status !== 'paused')
  const target = candidates.find((group) => group.id === targetId)

  return (
    <div className="stack infringement-notification-settings">
      <Panel title="当前接收群">
        <div className="panel-body infringement-notification-current">
          <strong>{current?.name ?? '尚未设置'}</strong>
          <Badge tone={current?.status === 'active' ? 'blue' : 'neutral'}>
            {current?.status === 'active' ? '自动推送已启用' : current ? '已暂停' : '未启用自动推送'}
          </Badge>
        </div>
      </Panel>
      {switchedTo && <Notice success>自动推送已切换至「{switchedTo}」。</Notice>}
      <Panel title="更换接收群">
        <div className="panel-body stack">
          {candidates.length ? (
            <Field label="目标群" hint="选择目标群，试发成功并核对群内消息后再切换。">
              <Select
                value={target?.id ?? ''}
                onValueChange={(value) => { setTargetId(value); setSwitchedTo('') }}
                options={[
                  { value: '', label: '选择目标群', disabled: true },
                  ...candidates.map((group) => ({ value: group.id, label: group.name })),
                ]}
              />
            </Field>
          ) : <Notice>没有可切换的群。请先登记并启用另一个企业微信群。</Notice>}
          {target && (
            <ChangeGroup key={target.id} current={current} target={target} onSwitched={() => {
              setSwitchedTo(target.name)
              setTargetId('')
            }} />
          )}
        </div>
      </Panel>
      <Panel title="企业微信群" extra={<button type="button" onClick={() => setAdding(true)}>新增群</button>}>
        <div className="panel-body stack">
          {groups.length === 0 && <Notice>还没有登记企业微信群。</Notice>}
          {groups.map((group) => (
            <div className="stack infringement-notification-group" key={group.id}>
              <div className="infringement-notification-buttons">
                <button
                  type="button"
                  aria-expanded={expandedGroup === group.id}
                  onClick={() => setExpandedGroup(expandedGroup === group.id ? '' : group.id)}
                >
                  {group.name}
                </button>
                <span className="muted">
                  {group.webhookHint ? `Webhook 尾号 ${group.webhookHint}` : group.webhookKey ? '使用既有配置' : '已保存 Webhook'}
                </span>
                {group.status === 'paused' && <Badge tone="neutral">已暂停</Badge>}
              </div>
              {expandedGroup === group.id && <GroupMembers groupId={group.id} />}
            </div>
          ))}
        </div>
      </Panel>
      {adding && (
        <AddGroup onClose={() => setAdding(false)} onAdded={(id) => {
          setAdding(false)
          setSwitchedTo('')
          setTargetId(id)
          setExpandedGroup(id)
        }} />
      )}
    </div>
  )
}
