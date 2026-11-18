import { useEffect, useRef, useState } from 'react'
import { InventoryAutomatic } from './inventory-automatic'
import { InventoryLiveTrial } from './inventory-live'
import { ErrorBox, Field, Form, Loading, Notice, Panel, useData, useWrite } from './ui'

type Run = {
  id: string
  state: string
  started_at: number
  inventory_rows?: number
  listing_rows?: number
  inventory_status: string
  listings_status: string
  orders_status: string
}
type Status = {
  executor: { deviceId: string | null; version: number }
  activeTrialId: string | null
  activeTrialOwner: string | null
  settings: { enabled: boolean; intervalMinutes: number; activatedAt: number | null }
  latest: Run | null
  current: Run | null
  devices: {
    id: string
    name: string
    last_seen: number | null
    revoked_at: number | null
    last_test_passed: number | null
  }[]
}
const time = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString('zh-CN') : '暂无'
export function InventorySync() {
  const state = useData<Status>('/inventory-sync', true, 15000)
  const [interval, setInterval] = useState(60)
  const [enabled, setEnabled] = useState(false)
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null)
  const save = useWrite(),
    scan = useWrite<{ runId: string | null }>()
  const pairing = useWrite<{ code: string; expiresAt: number }>(setPair)
  const deviceAction = useWrite()
  const transferRequest = useRef<{
    requestId: string
    deviceId: string
    expectedExecutorId: string | null
    expectedVersion: number
    expectedTrialId: string | null
  } | null>(null)
  const transfer = useWrite(() => {
    transferRequest.current = null
  })
  const savedEnabled = state.data?.settings.enabled
  const savedInterval = state.data?.settings.intervalMinutes
  useEffect(() => {
    if (savedEnabled !== undefined && savedInterval !== undefined) {
      setInterval(savedInterval)
      setEnabled(savedEnabled)
    }
  }, [savedEnabled, savedInterval])
  if (state.error) return <ErrorBox error={state.error} />
  if (!state.data) return <Loading />
  const { latest, current, devices, executor, activeTrialId, activeTrialOwner } = state.data
  const chooseExecutor = (deviceId: string) => {
    if (!executor) return
    const previous = transferRequest.current
    if (
      !previous ||
      previous.deviceId !== deviceId ||
      previous.expectedVersion !== executor.version ||
      previous.expectedTrialId !== activeTrialId
    ) {
      transferRequest.current = {
        requestId: crypto.randomUUID(),
        deviceId,
        expectedExecutorId: executor.deviceId,
        expectedVersion: executor.version,
        expectedTrialId: activeTrialId,
      }
    }
    transfer.mutate({ path: '/inventory-sync/executor', body: transferRequest.current })
  }
  return (
    <div className="stack">
      <InventoryAutomatic />
      <Panel title="库存巡查">
        <Form
          className="panel-body stack"
          onSubmit={() =>
            save.mutate({
              path: '/inventory-sync/settings',
              body: { enabled, intervalMinutes: interval, mode: 'READ_ONLY' },
            })
          }
        >
          <p>
            JIT、J1T 出单商品补到 5，未出单新品补到
            2；两类重叠按出单商品处理，未出单老商品不补。首次纳入最近 7
            天的新上架商品，之后持续检测新增。
          </p>
          <label>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{' '}
            启用定时巡查
          </label>
          <Field label="巡查间隔（分钟，默认 60）">
            <input
              type="number"
              min={5}
              max={10080}
              step={5}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </Field>
          <p className="muted">系统每 5 分钟检查一次是否到期；插件离线时，巡查记录继续保存在 ERP。</p>
          <div className="actions">
            <button disabled={save.isPending} type="submit">
              保存巡查设置
            </button>
            <button
              type="button"
              disabled={!state.data.settings.enabled || scan.isPending}
              onClick={() => scan.mutate({ path: '/inventory-sync/scan', body: {} })}
            >
              检查并启动到期巡查
            </button>
            <button type="button" onClick={() => void state.refetch()}>
              刷新状态
            </button>
          </div>
          <ErrorBox error={save.error || scan.error} />
          {scan.isSuccess && (
            <Notice success>{scan.data.runId ? '巡查已进入后台队列。' : '尚未到巡查时间。'}</Notice>
          )}
          <p>最近巡查：{latest ? `${time(latest.started_at)} · ${latest.state}` : '未运行'}</p>
          {latest && (
            <p>
              库存报告：{latest.inventory_status}；刊登报告：{latest.listings_status}；订单：
              {latest.orders_status}
            </p>
          )}
          <p>最近完整快照：{current ? time(current.started_at) : '暂无完整快照'}</p>
          <p>
            补库以 Amazon API 返回的可售库存为准，不因 Seller Flex 页面显示不同而暂停计算。
            历史订单尚未覆盖的零库存商品保留为资格未知。巡查读取与自动上传可分别开启或暂停。
          </p>
          <p>
            巡查报告的 Inactive
            可能表示缺货或停售，不需要逐个手工核验。开启自动补库后，系统会在上传前自动读取 API
            刊登详情和报价有效期：符合规则的缺货商品补库，停售、禁售、抑制或属性被拦截的商品跳过。
            读取失败或证据不足的商品暂不补库，后续自动重查，不阻止其他商品处理。
          </p>
        </Form>
      </Panel>
      <details>
        <summary>小批量联调工具</summary>
        <InventoryLiveTrial />
      </details>
      <Panel title="Seller Flex 插件连接">
        <div className="panel-body stack">
          <p>
            在同一浏览器登录本 ERP，打开新版插件，点击“连接当前
            ERP”即可登记这台电脑。每台电脑独立连接，无需复制 Amazon 密钥。
          </p>
          <p>
            <a href="/downloads/SellerFlex-Batch-Inventory-v0.7.3.zip" download>
              下载插件 v0.7.3
            </a>{' '}
            · 解压后在浏览器扩展管理中加载；升级旧版请重新加载扩展，并刷新 ERP 和 Seller Flex 页面。
          </p>
          <Notice>
            当前执行电脑：{devices.find((d) => d.id === executor?.deviceId)?.name ?? '尚未选择'}。
            新连接的电脑不会自动抢占任务。切换后，未提交的任务重新读取
            API；可能已上传的任务只接管原文件核对，不再次上传。
          </Notice>
          <details>
            <summary>备用方式：配对码连接</summary>
            <p>ERP 与插件不在同一浏览器时使用。配对码 10 分钟有效，只能使用一次。</p>
            <button
              type="button"
              disabled={pairing.isPending}
              onClick={() => pairing.mutate({ path: '/inventory-sync/pair', body: {} })}
            >
              生成配对码
            </button>
            {pair && (
              <div>
                <Field label="配对码">
                  <input readOnly value={pair.code} onFocus={(e) => e.currentTarget.select()} />
                </Field>
                <small>有效至 {time(pair.expiresAt)}</small>
              </div>
            )}
          </details>
          <ErrorBox error={pairing.error || deviceAction.error || transfer.error} />
          {transfer.isSuccess && (
            <Notice success>执行电脑已更新；未完成任务已按提交状态安全转交。</Notice>
          )}
          {!devices.length && <p>尚未连接设备。</p>}
          {devices.map((d) => (
            <div key={d.id} className="stack">
              <strong>
                {d.name}
                {d.revoked_at ? '（已撤销）' : ''}
                {!d.revoked_at && d.id === executor?.deviceId ? ' · 当前执行电脑' : ''}
                {!d.revoked_at && d.id !== executor?.deviceId ? ' · 备用电脑' : ''}
              </strong>
              <span>
                {d.last_seen && Date.now() - d.last_seen < 180000 ? '最近在线' : '等待上线'} · 最近连接：
                {time(d.last_seen)}；文件联调通过：{time(d.last_test_passed)}
              </span>
              {!d.revoked_at && (
                <div className="actions">
                  {d.id !== executor?.deviceId && (
                    <button
                      type="button"
                      disabled={!executor || transfer.isPending || deviceAction.isPending}
                      onClick={() => chooseExecutor(d.id)}
                    >
                      {activeTrialId ? '设为执行电脑并接管任务' : '设为执行电脑'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={deviceAction.isPending || transfer.isPending}
                    onClick={() =>
                      deviceAction.mutate({ path: '/inventory-sync/test', body: { deviceId: d.id } })
                    }
                  >
                    发送模拟任务
                  </button>
                  <button
                    type="button"
                    disabled={
                      deviceAction.isPending ||
                      transfer.isPending ||
                      (Boolean(activeTrialId) && d.id === activeTrialOwner)
                    }
                    onClick={() =>
                      deviceAction.mutate({ path: '/inventory-sync/revoke', body: { deviceId: d.id } })
                    }
                  >
                    撤销连接
                  </button>
                  {activeTrialId && d.id === activeTrialOwner && (
                    <span className="muted">仍有未完成任务；撤销前请先由另一台电脑接管。</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
