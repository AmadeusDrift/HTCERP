import { useState } from 'react'
import { ErrorBox, Field, Notice, Panel, useData, useWrite } from './ui'

type LiveStatus = {
  trial: null | {
    id: string
    state: string
    skus: string[]
    error: string | null
    endedAt: number | null
    snapshot: null | { observations: { sku: string; sellable: number | null }[] }
  }
  jobs: {
    id: string
    state: string
    filename: string | null
    rows: { sku: string; quantity: number }[]
    rowStates: { sku: string; outcome: string; active: number }[]
  }[]
}
const states: Record<string, string> = {
  READY: '等待插件领取',
  ACTIVE: '处理中',
  RETRY_WAIT: '等待失败重试',
  WAITING_API: '平台已确认，等待 API 对账',
  UNKNOWN: '提交结果待核对',
  COMPLETE: '对账完成',
  FAILED: '失败并暂停',
  SKIPPED: '无需补库',
  CLAIMED: '已领取',
  SUBMITTING: '已登记上传',
  SUBMITTED: '已派发上传',
  SUCCEEDED: '平台确认成功',
  PARTIAL: '部分成功',
  EXPIRED: '领取已过期',
}
export function InventoryLiveTrial() {
  const status = useData<LiveStatus>('/inventory-sync/live/status')
  const [skus, setSkus] = useState('')
  const create = useWrite(),
    reconcile = useWrite()
  const data = status.data
  return (
    <Panel title="真实小批量测试">
      <div className="panel-body stack">
        <Notice>
          本轮每批最多 2 个 SKU，按 API 可售量将出单商品补到 5、未出单新品补到 2。连接的插件会在当前
          Seller Flex Receive 页面执行真实上传。此工具独立于定时自动补库，请勿重复创建相同商品的测试。
        </Notice>
        <Field label="本次测试 SKU（每行一个）">
          <textarea
            rows={2}
            value={skus}
            onChange={(e) => setSkus(e.target.value)}
            placeholder="粘贴 1–2 个 JIT / J1T SKU"
          />
        </Field>
        <div className="actions">
          <button
            type="button"
            disabled={!skus.trim() || create.isPending || Boolean(data?.trial && !data.trial.endedAt)}
            onClick={() =>
              create.mutate({
                path: '/inventory-sync/live/trial',
                body: {
                  skus: skus
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              })
            }
          >
            创建并执行小批次
          </button>
          <button
            type="button"
            disabled={reconcile.isPending || !data?.trial}
            onClick={() => reconcile.mutate({ path: '/inventory-sync/live/reconcile', body: {} })}
          >
            回读 API 并对账
          </button>
          <button type="button" onClick={() => void status.refetch()}>
            刷新处理结果
          </button>
        </div>
        <ErrorBox error={status.error || create.error || reconcile.error} />
        {data?.trial && (
          <>
            <strong>{states[data.trial.state] ?? data.trial.state}</strong>
            <span>{data.trial.skus.join('；')}</span>
            {data.trial.snapshot?.observations.map((row) => (
              <span key={row.sku}>
                {row.sku} · 最近 API 可售：{row.sellable ?? '未知'}
              </span>
            ))}
            {data.trial.error && <Notice>{data.trial.error}</Notice>}
            {data.jobs.map((job) => (
              <div className="stack" key={job.id}>
                <strong>{states[job.state] ?? job.state}</strong>
                <span>{job.filename ?? '尚未生成上传文件'}</span>
                {job.rows.map((row) => (
                  <span key={row.sku}>
                    {row.sku} · 本次增加 {row.quantity} 件
                  </span>
                ))}
                {job.rowStates.map((row) => (
                  <span key={row.sku}>
                    {row.sku} · 平台结果：{states[row.outcome] ?? row.outcome} ·{' '}
                    {row.active ? '库存项仍在对账保护中' : '已结束'}
                  </span>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  )
}
