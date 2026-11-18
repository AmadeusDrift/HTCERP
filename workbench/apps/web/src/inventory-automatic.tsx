import { ErrorBox, Loading, Notice, Panel, useData, useWrite } from './ui'

type AutomaticStatus = {
  enabled: boolean
  intervalMinutes: number
  activatedAfter: number | null
  maxRows: number
  generation: { generation: string; state: string; updated_at: number } | null
  counts: { candidates: number; paused: number; coolingDown: number; pending: number }
  jobs: { batches: number; recorded: number; awaitingReceipt: number }
  reconciliation: { pending: number; unknown: number }
  history: {
    completedWindows: number
    oldestFrom: number | null
    latestThrough: number | null
    running: number
    positiveSkus: number
  }
}

export function InventoryAutomatic() {
  const status = useData<AutomaticStatus>('/inventory-sync/automatic/status', true, 15000)
  const settings = useWrite(() => void status.refetch())
  const data = status.data
  return (
    <Panel title="自动补库">
      <div className="panel-body stack">
        <ErrorBox error={status.error || settings.error} />
        {!data && !status.error && <Loading />}
        {data && (
          <>
            <Notice success={data.enabled}>
              {data.enabled
                ? `自动补库已开启 · 每 ${data.intervalMinutes} 分钟巡查。`
                : '自动补库已暂停；定时巡查可独立继续记录库存。'}
            </Notice>
            <p>
              开启时跳过已有批次及正在进行的巡查，从下一次新启动的巡查结果开始处理。 仅处理符合规则的 JIT
              / J1T，上传前重新读取 API，出单商品低于 5 补到 5，未出单新品低于 2 补到 2，其他老商品不补。
            </p>
            {data.activatedAfter && (
              <p className="muted">
                生效边界：{new Date(data.activatedAfter).toLocaleString('zh-CN')}。
                此时间之前启动的巡查不执行补库。
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={settings.isPending}
                onClick={() =>
                  settings.mutate({
                    path: '/inventory-sync/automatic/settings',
                    body: {
                      enabled: !data.enabled,
                      intervalMinutes: data.intervalMinutes,
                      startFrom: 'NEXT_PATROL',
                    },
                  })
                }
              >
                {data.enabled ? '暂停自动补库' : '从下一轮巡查开启自动补库'}
              </button>
              <button type="button" onClick={() => void status.refetch()}>
                刷新自动补库状态
              </button>
            </div>
            <p>
              候选商品 {data.counts.candidates.toLocaleString()} · 待处理{' '}
              {data.counts.pending.toLocaleString()} · 等待重试{' '}
              {data.counts.coolingDown.toLocaleString()} · 已暂停 {data.counts.paused.toLocaleString()}
            </p>
            <p>
              已创建批次 {data.jobs.batches.toLocaleString()} · 结果已保存{' '}
              {data.jobs.recorded.toLocaleString()} · 等待插件回传{' '}
              {data.jobs.awaitingReceipt.toLocaleString()}
            </p>
            <p>
              等待 API 对账 {data.reconciliation.pending.toLocaleString()} · 提交结果待核对{' '}
              {data.reconciliation.unknown.toLocaleString()}
            </p>
            <p className="muted">
              全量商品分批执行，每批最多 {data.maxRows} 个 SKU。插件离线时，ERP 保留待处理记录；
              恢复后以最新库存计算补量。暂停会阻止新的上传，已上传的批次继续核对结果。
            </p>
            <p className="muted">
              历史订单补查：已完成 {data.history.completedWindows} 个时间段，确认{' '}
              {data.history.positiveSkus.toLocaleString()} 个商品曾出单
              {data.history.running ? '，正在继续补查' : ''}。
              {data.history.oldestFrom && data.history.latestThrough
                ? ` 已覆盖 ${new Date(data.history.oldestFrom).toLocaleDateString('zh-CN')} 至 ${new Date(data.history.latestThrough).toLocaleDateString('zh-CN')}。`
                : ' 尚无历史补查完成记录。'}
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
