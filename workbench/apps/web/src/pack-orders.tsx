import { Download, RefreshCw } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import type { PackBatch } from '../../../packages/order-sorting/pack-types'
import type { PackFactoryPackages, FactoryPackage } from '../../../packages/order-sorting/pack-factory'
import { ErrorBox, Loading, Panel, request, useData, useLocation } from './ui'

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
  const [all, setAll] = useState(false)
  const [preview, setPreview] = useState<Awaited<ReturnType<PackFactoryPackages['preview']>> | null>(
    null,
  )
  const [previewError, setPreviewError] = useState('')
  const [expanded, setExpanded] = useState('')
  useEffect(() => {
    let active = true
    setPreview(null)
    setPreviewError('')
    if (batch && !batch.conflicts.length) {
      request<Awaited<ReturnType<PackFactoryPackages['preview']>>>(
        `/order-sorting/pack/${batch.id}/factory-preview`,
      )
        .then((value) => {
          if (active) setPreview(value)
        })
        .catch((reason) => {
          if (active) setPreviewError(reason.message || '读取全部订单失败')
        })
    }
    return () => {
      active = false
    }
  }, [batch])
  useEffect(() => {
    setOlder([])
    setNext(listing.data?.next ?? null)
  }, [listing.data])
  useEffect(() => {
    setAll(false)
    setExpanded('')
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
            (group) => file(`pack/${batch.id}/group-picking/${encodeURIComponent(group)}`),
          ),
          `Pack-${batch.date}-${batch.id.slice(0, 8)}.zip`,
          'application/zip',
        )
    })
  }
  async function factoryFile(groupFile?: string) {
    if (!batch || !preview) return
    const result = await request<FactoryPackage>(`/order-sorting/pack/${batch.id}/factory-package`, {})
    if (result.attributeRevision !== preview.revision)
      throw Error('属性清单已更新，请刷新本批次后重新核对。')
    const bytes = await file(`pack/${batch.id}/factory-package/${result.key}`)
    if (groupFile) {
      const { default: JSZip } = await import('jszip')
      const entry = (await JSZip.loadAsync(bytes)).file(groupFile)
      if (!entry) throw Error('工厂包缺少所选分组文件。')
      save(
        await entry.async('uint8array'),
        groupFile.split('/').pop()!,
        groupFile.endsWith('.pdf') ? 'application/pdf' : sheetType,
      )
    } else {
      save(bytes, result.filename, 'application/zip')
      setFactory(result)
    }
  }
  const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const groups = (all ? preview?.groups : batch?.plan?.groups) ?? []
  const units = groups.reduce((sum, group) => sum + group.units, 0)
  const count = groups.reduce((sum, group) => sum + group.raw.length, 0)
  async function groupFile(name: string, kind: '分拣表' | 'SKU标签' | '带图备货单') {
    if (!batch) return
    const group = groups.find((item) => item.name === name)!
    const filename =
      kind === '分拣表'
        ? group.filename
        : group.filename.replace(/\.xlsx$/i, kind === 'SKU标签' ? '.pdf' : '-带图备货单.xlsx')
    if (all) return act('正在读取分组文件', () => factoryFile(kind + '/' + filename))
    if (kind === 'SKU标签') return output(name)
    await act('正在读取分组文件', async () => {
      if (kind === '带图备货单') {
        save(
          await file(`pack/${batch.id}/group-picking/${encodeURIComponent(name)}`),
          filename,
          sheetType,
        )
      } else {
        const { exportGroup } = await import('../../../packages/order-sorting/workbook')
        const original = batch.plan!.groups.find((item) => item.name === name)!
        save(
          await exportGroup(await file('assets/' + batch.templateKey), original, batch.date),
          filename,
          sheetType,
        )
      }
    })
  }
  return (
    <div className="stack">
      <ErrorBox error={error || listing.error} />
      {busy && (
        <p aria-live="polite" className="muted">
          {busy}…
        </p>
      )}
      {batch && (
        <Panel
          title={batch.date + ' 订单'}
          extra={
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => {
                setSelected(null)
                setBatch(null)
              }}
            >
              切换批次
            </button>
          }
        >
          <div className="panel-body stack">
            <div className="sorting-toolbar">
              <span className="muted">
                批次 {batch.id.slice(0, 8)} · {names[batch.state]}
              </span>
              <button className="secondary" disabled={!!busy} onClick={() => void refreshBatch()}>
                <RefreshCw size={14} />
                刷新本批次
              </button>
            </div>
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
            <fieldset className="pack-scope">
              <legend>交厂范围</legend>
              <label>
                <input
                  type="radio"
                  name="pack-scope"
                  checked={!all}
                  disabled={!!busy}
                  onChange={() => {
                    setAll(false)
                    setExpanded('')
                  }}
                />
                <span>
                  <strong>仅本次新增</strong>
                  <small>
                    {batch.newRows} 条 / {batch.plan?.totalUnits ?? 0} 件
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="pack-scope"
                  checked={all}
                  disabled={!!busy || !!batch.conflicts.length}
                  onChange={() => {
                    setAll(true)
                    setExpanded('')
                  }}
                />
                <span>
                  <strong>本次全部</strong>
                  <small>
                    {preview
                      ? preview.orderCount +
                        ' 单 / ' +
                        preview.groups.reduce((sum, g) => sum + g.units, 0) +
                        ' 件 · '
                      : ''}
                    含已分拣的 {batch.skippedRows} 条
                  </small>
                </span>
              </label>
            </fieldset>
            {all && !preview && <p role="status">{previewError || '正在读取全部订单…'}</p>}
            {(!all || preview) && (
              <>
                <h3>
                  备货分组{' '}
                  <small className="muted">
                    {all ? '本次全部' : '仅本次新增'} · {groups.length} 组
                  </small>
                </h3>
                {groups.length ? (
                  <div className="table-wrap">
                    <table className="pack-group-table">
                      <thead>
                        <tr>
                          <th>分组</th>
                          <th>订单明细</th>
                          <th>备货件数</th>
                          <th>分组文件</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g) => (
                          <Fragment key={g.name}>
                            <tr>
                              <td>
                                <button
                                  className="pack-group-toggle"
                                  aria-expanded={expanded === g.name}
                                  onClick={() => setExpanded(expanded === g.name ? '' : g.name)}
                                >
                                  {expanded === g.name ? '▾' : '▸'}　{g.name}
                                </button>
                              </td>
                              <td>{g.raw.length} 条</td>
                              <td>
                                <strong>{g.units} 件</strong>
                              </td>
                              <td>
                                <details>
                                  <summary>下载文件</summary>
                                  {(['分拣表', '带图备货单', 'SKU标签'] as const).map((kind) => (
                                    <button
                                      key={kind}
                                      className="secondary"
                                      disabled={
                                        !!busy ||
                                        (!all &&
                                          kind === 'SKU标签' &&
                                          !batch.labelGroups?.find((item) => item.group === g.name)
                                            ?.ready)
                                      }
                                      onClick={() => void groupFile(g.name, kind)}
                                    >
                                      {kind}
                                    </button>
                                  ))}
                                </details>
                              </td>
                            </tr>
                            {expanded === g.name && (
                              <tr>
                                <td colSpan={4}>
                                  <table aria-label={g.name + ' 明细'}>
                                    <thead>
                                      <tr>
                                        <th>SKU</th>
                                        <th>FNSKU</th>
                                        <th>件数</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {g.raw.map((r, i) => (
                                        <tr key={i}>
                                          <td>{r[1]}</td>
                                          <td>{r[2]}</td>
                                          <td>{r[4]}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th>合计</th>
                          <td>{count} 条</td>
                          <td>
                            <strong>{units} 件</strong>
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ) : (
                  <p className="muted">本批没有新增备货明细。</p>
                )}
                <div className="sorting-toolbar pack-export">
                  <div>
                    <strong>工厂包内容</strong>
                    <small className="sorting-filename">分拣表、SKU 标签和带图备货单</small>
                  </div>
                  {!all && batch.state === 'LABELS_PENDING' ? (
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void act('正在生成备货单和标签', async () => {
                          setBatch(
                            await request<PackBatch>(
                              `/order-sorting/pack/${batch.id}/prepare-labels`,
                              {},
                            ),
                          )
                          await listing.refetch()
                        })
                      }
                    >
                      生成／重试备货单和标签
                    </button>
                  ) : (
                    <button
                      disabled={!!busy || !count || (!all && batch.state !== 'READY')}
                      onClick={() =>
                        all ? void act('正在整理全部订单工厂包', () => factoryFile()) : void output()
                      }
                    >
                      <Download size={16} />
                      {all ? '下载全部订单工厂包' : '下载新增订单工厂包'} · {units} 件
                    </button>
                  )}
                </div>
              </>
            )}
            {!all && (batch.labelError || batch.pickingError) && (
              <p role="alert">{[batch.labelError, batch.pickingError].filter(Boolean).join(' · ')}</p>
            )}
            {all && factory?.batchId === batch.id && (
              <p role="status">
                已导出全部订单工厂包：{factory.orderCount} 个订单 · {factory.units} 件
              </p>
            )}
            <details>
              <summary>原始订单文件</summary>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void act('正在读取原始订单', async () =>
                    save(await file(`pack/${batch.id}/source`), batch.filename, sheetType),
                  )
                }
              >
                下载原始订单
              </button>
            </details>
          </div>
        </Panel>
      )}
      {selected && !batch && !error && <Loading />}
      {!batch && (
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
      )}
    </div>
  )
}
