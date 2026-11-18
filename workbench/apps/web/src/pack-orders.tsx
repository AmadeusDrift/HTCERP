import { Download, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PackBatch } from '../../../packages/order-sorting/pack-types'
import type { FactoryPackage } from '../../../packages/order-sorting/pack-factory'
import { ErrorBox, Loading, Notice, Panel, request, useData, useLocation } from './ui'

const names = {
  READY: '分拣、带图备货单与标签已完成',
  LABELS_PENDING: '分拣完成，备货单或标签待生成',
  NO_NEW: '没有新增订单',
}
type Page = { batches: PackBatch[]; next: { time: number; id: string } | null }
async function file(path: string) {
  const response = await fetch('/api/order-sorting/' + path, { credentials: 'same-origin' })
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
    throw Error(error?.error?.message || '文件暂时无法读取，请检查登录状态后重试。')
  }
  return new Uint8Array(await response.arrayBuffer())
}
function save(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type })),
    link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
export function PackOrdersPanel() {
  const location = useLocation(),
    hint = location.params.get('packBatch')
  const listing = useData<Page>('/order-sorting/pack/batches')
  const [selected, setSelected] = useState<string | null>(
    hint && /^[a-f\d-]{36}$/i.test(hint) ? hint : null,
  )
  const [batch, setBatch] = useState<PackBatch | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState('')
  const [older, setOlder] = useState<PackBatch[]>([]),
    [next, setNext] = useState<Page['next']>(null)
  const [factory, setFactory] = useState<FactoryPackage | null>(null)
  useEffect(() => {
    setOlder([])
    setNext(listing.data?.next ?? null)
  }, [listing.data])
  useEffect(() => {
    if (!selected) return
    setBatch(null)
    setFactory(null)
    setError(null)
    let active = true
    request<PackBatch>('/order-sorting/pack/' + encodeURIComponent(selected)).then(
      (value) => {
        if (active) setBatch(value)
      },
      (reason) => {
        if (active) setError(reason)
      },
    )
    return () => {
      active = false
    }
  }, [selected])
  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e : new Error('操作失败。'))
    } finally {
      setBusy('')
    }
  }
  async function refreshBatch() {
    if (selected)
      await act('正在刷新', async () => {
        setBatch(await request<PackBatch>('/order-sorting/pack/' + encodeURIComponent(selected)))
        await listing.refetch()
      })
  }
  async function output(group?: string) {
    if (!batch) return
    await act('正在整理下载文件', async () => {
      const io = await import('../../../packages/order-sorting/pack-output')
      const readLabel = (group: string) =>
        file(`pack/${batch.id}/group-labels/${encodeURIComponent(group)}`)
      if (group)
        save(
          await io.mergePackLabels(batch, group, readLabel),
          `${group}-${batch.date.replaceAll('-', '')}-SKU标签.pdf`,
          'application/pdf',
        )
      else
        save(
          await io.exportPackBundle(
            batch,
            await file('assets/' + batch.templateKey),
            await file(`pack/${batch.id}/source`),
            readLabel,
            group => file(`pack/${batch.id}/group-picking/${encodeURIComponent(group)}`),
          ),
          `Pack-${batch.date}-${batch.id.slice(0, 8)}.zip`,
          'application/zip',
        )
    })
  }
  async function factoryOutput() {
    if (!batch) return
    const id = batch.id
    await act('正在合并本次全部订单的分拣表、标签和带图备货单', async () => {
      const result = await request<FactoryPackage>(`/order-sorting/pack/${id}/factory-package`, {})
      save(await file(`pack/${id}/factory-package/${result.key}`), result.filename, 'application/zip')
      setFactory(result)
    })
  }
  return (
    <div className="stack">
      <ErrorBox error={error || listing.error} />
      <Notice>
        在 SellerFlex Pack 选择订单并打开 Order List，点击插件“同步到 ERP
        并分拣”。重复项自动跳过，数量变化项单列待核对。默认导出新增订单；需要把本次全部订单一起交厂，可选择“导出本次全部订单工厂包”。{' '}
        <a href="/downloads/SellerFlex-Batch-Inventory-v0.7.1.zip" download>
          下载插件 v0.7.1
        </a>
      </Notice>
      {busy && (
        <p aria-live="polite" className="muted">
          {busy}…
        </p>
      )}
      {batch && (
        <Panel
          title="Pack 自动分拣批次"
          extra={
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => void refreshBatch()}
            >
              <RefreshCw size={15} />
              刷新本批次
            </button>
          }
        >
          <div className="panel-body stack">
            <div className="sorting-toolbar">
              <p>
                <strong>{batch.filename}</strong>
                <small className="sorting-filename">
                  {batch.date} · 批次 {batch.id.slice(0, 8)}
                </small>
              </p>
              <strong>{names[batch.state]}</strong>
            </div>
            <div className="sorting-stats">
              <div>
                <small>原始记录</small>
                <strong>{batch.totalRows}</strong>
              </div>
              <div>
                <small>新增分拣</small>
                <strong>{batch.newRows}</strong>
              </div>
              <div>
                <small>重复跳过</small>
                <strong>{batch.skippedRows}</strong>
              </div>
              <div>
                <small>数量待核对</small>
                <strong>{batch.conflicts.length}</strong>
              </div>
            </div>
            <p className="muted">
              API 标签已生成 {batch.labelGroups?.filter((x) => x.ready).length ?? 0} /{' '}
              {batch.plan?.groups.length ?? 0} 组。 原版 SKU 标签和合成文件保存在
              ERP，后续直接复用；固定欧代标在上、SKU 条码在下，每件一页 80×80 mm。
            </p>
            {batch.labelError && <p role="alert">{batch.labelError}</p>}
            <p className="muted">带图备货单已生成 {batch.pickingGroups?.filter(x => x.ready).length ?? 0} / {batch.plan?.groups.length ?? 0} 组。商品展示主图首次从 Amazon API 获取，图片和备货单保存在 ERP，换电脑直接复用。</p>
            {batch.pickingError && <p role="alert">{batch.pickingError}</p>}
            <div className="actions">
              {batch.state === 'LABELS_PENDING' && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void act('正在生成主图、备货单和 API 标签', async () => {
                      setBatch(
                        await request<PackBatch>(`/order-sorting/pack/${batch.id}/prepare-labels`, {
                          method: 'POST',
                        }),
                      )
                      await listing.refetch()
                    })
                  }
                >
                  生成／重试备货单和标签
                </button>
              )}

              <button
                type="button"
                disabled={!!busy || batch.state !== 'READY'}
                onClick={() => void output()}
              >
                <Download size={16} />
                下载新增订单分拣包
              </button>
              <button
                type="button"
                disabled={!!busy || batch.conflicts.length > 0}
                onClick={() => void factoryOutput()}
              >
                <Download size={16} />
                导出本次全部订单工厂包
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void act('正在读取原始订单', async () =>
                    save(
                      await file(`pack/${batch.id}/source`),
                      batch.filename,
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    ),
                  )
                }
              >
                下载原始订单
              </button>
            </div>
            <p className="muted">全部订单工厂包包含本次新增及重复跳过的订单，按当前产品属性清单统一分组，复用 ERP 图片和标签缓存；仅合并导出，不重复入账。数量待核对时暂不能导出全部工厂包。</p>
            {factory?.batchId === batch.id && <p role="status">已导出全部订单工厂包：{factory.orderCount} 个订单 · {factory.rowCount} 条明细 · {factory.units} 件 · {factory.groups.length} 组，包含分拣表、SKU 标签和带图备货单。</p>}
            {batch.plan && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>分组</th>
                      <th>新增记录 / 件数</th>
                      <th>分拣表</th>
                      <th>带图备货单</th>
                      <th>官方 SKU 标签</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.plan.groups.map((group) => (
                      <tr key={group.name}>
                        <td>{group.name}</td>
                        <td>
                          {group.raw.length} / {group.units}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            disabled={!!busy}
                            onClick={() =>
                              void act('正在生成分拣表', async () => {
                                const io = await import('../../../packages/order-sorting/workbook')
                                save(
                                  await io.exportGroup(
                                    await file('assets/' + batch.templateKey),
                                    group,
                                    batch.date,
                                  ),
                                  group.filename,
                                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                )
                              })
                            }
                          >
                            下载 {group.filename}
                          </button>
                        </td>
                        <td>
                          <button type="button" className="secondary" disabled={!!busy} onClick={() => void act('正在读取带图备货单', async () => {
                            save(await file(`pack/${batch.id}/group-picking/${encodeURIComponent(group.name)}`), group.filename.replace(/\.xlsx$/i, '-带图备货单.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                            setBatch(await request<PackBatch>('/order-sorting/pack/' + batch.id))
                          })}>下载带图备货单</button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              !!busy || !batch.labelGroups?.find((x) => x.group === group.name)?.ready
                            }
                            onClick={() => void output(group.name)}
                          >
                            下载 {group.name} 标签 PDF
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!batch.conflicts.length && (
              <>
                <h3>数量变化，待核对</h3>
                <p className="muted">以下项目未再次生成备货数量或标签，请先核对原订单。</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>FNSKU</th>
                        <th>Transfer Id</th>
                        <th>之前数量</th>
                        <th>本次数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.conflicts.map((item) => (
                        <tr key={item.rowIndex}>
                          <td>{item.sku}</td>
                          <td>{item.fnsku}</td>
                          <td>{item.transferId}</td>
                          <td>{item.previousUnits}</td>
                          <td>{item.units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </Panel>
      )}
      <Panel
        title="Pack 导入记录"
        extra={
          <button
            type="button"
            className="secondary"
            disabled={!!busy}
            onClick={() => void listing.refetch()}
          >
            刷新记录
          </button>
        }
      >
        <div className="panel-body">
          {listing.isLoading ? (
            <Loading />
          ) : !listing.data?.batches.length ? (
            <p className="muted">尚无 Pack 自动导入批次。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>订单日期 / 批次</th>
                    <th>新增 / 跳过 / 待核对</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {[...listing.data.batches, ...older].map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.date}
                        <small className="sorting-filename">{item.id.slice(0, 8)}</small>
                      </td>
                      <td>
                        {item.newRows} / {item.skippedRows} / {item.conflicts.length}
                      </td>
                      <td>{names[item.state]}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => {
                            setSelected(item.id)
                            setBatch(item)
                            setError(null)
                          }}
                        >
                          查看批次
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {next && (
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() =>
                void act('正在读取历史批次', async () => {
                  const more = await request<Page>(
                    `/order-sorting/pack/batches?time=${next.time}&id=${encodeURIComponent(next.id)}`,
                  )
                  setOlder([...older, ...more.batches])
                  setNext(more.next)
                })
              }
            >
              加载更早批次
            </button>
          )}
        </div>
      </Panel>
    </div>
  )
}
