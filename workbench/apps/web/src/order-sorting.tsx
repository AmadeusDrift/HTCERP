import { Download, FileSpreadsheet, FolderOpen, PackageCheck, RefreshCw, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AttributeRow, Cell, OrderInput, SortPlan } from '../../../packages/order-sorting/rules'
import type {
  RunPage,
  RunResult,
  RunSummary,
  SortingState,
} from '../../../packages/order-sorting/service'
import { ErrorBox, Loading, Notice, Panel, request, Title, useAccess, useData } from './ui'
import './order-sorting.css'
import { PackOrdersPanel } from './pack-orders'

const labels = [
  '分组键',
  '运营',
  '产品类别',
  'SKU 示例',
  '名称',
  '规格描述',
  '材质 / 厚度',
  '含贴标单价',
  '包装方式',
  '配件',
  '备注',
]
const stamp = (time: number) => new Date(time).toLocaleString('zh-CN')
const copyRows = (rows: AttributeRow[]) => rows.map((r) => [...r])
async function bytes(file: File) {
  if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 6_000_000)
    throw Error('请选择不超过 6 MB 的 .xlsx 文件。')
  return new Uint8Array(await file.arrayBuffer())
}
function encoded(value: Uint8Array) {
  let text = ''
  for (let i = 0; i < value.length; i += 32768)
    text += String.fromCharCode(...value.subarray(i, i + 32768))
  return btoa(text)
}
async function asset(key: string) {
  const response = await fetch('/api/order-sorting/assets/' + encodeURIComponent(key), {
    credentials: 'same-origin',
  })
  if (!response.ok) throw Error('无法读取工作簿，请刷新登录后重试。')
  return new Uint8Array(await response.arrayBuffer())
}
function download(data: Uint8Array, name: string, zip = false) {
  const url = URL.createObjectURL(
    new Blob([data.slice().buffer as ArrayBuffer], {
      type: zip
        ? 'application/zip'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function OrderSortingPage() {
  const { admin, edit } = useAccess(),
    state = useData<SortingState>('/order-sorting/state')
  const config = state.data?.config
  const [tab, setTab] = useState<'sort' | 'attributes' | 'pack'>(() =>
    new URLSearchParams(window.location.search).has('packBatch') ? 'pack' : 'sort',
  )
  const [orderFile, setOrderFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{
    plan: SortPlan
    order: OrderInput
    revision: number
    id: string
  } | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(''),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState('')
  const [attrFile, setAttrFile] = useState<File | null>(null),
    [templateFile, setTemplateFile] = useState<File | null>(null)
  const [importKey, setImportKey] = useState(0)
  const [olderRuns, setOlderRuns] = useState<RunSummary[]>([])
  const [historyEnd, setHistoryEnd] = useState(false)
  const [edited, setEdited] = useState<AttributeRow[]>([]),
    [editRevision, setEditRevision] = useState(0),
    [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0)
  useEffect(() => {
    if (config && !dirty) {
      setEdited(copyRows(config.rows))
      setEditRevision(config.revision)
    }
  }, [config, dirty])
  const latestRun = state.data?.runs[0]?.id
  useEffect(() => {
    void latestRun
    setOlderRuns([])
    setHistoryEnd(false)
  }, [latestRun])
  async function perform(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setError(null)
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e : new Error('操作失败，请重试。'))
    } finally {
      setBusy('')
    }
  }
  async function previewOrder() {
    if (!orderFile || !config) return
    await perform('正在读取订单', async () => {
      const io = await import('../../../packages/order-sorting/workbook')
      const order = await io.parseOrder(await bytes(orderFile))
      const plan = await request<SortPlan>('/order-sorting/preview', {
        revision: config.revision,
        order,
      })
      setPreview({ plan, order, revision: config.revision, id: crypto.randomUUID() })
      setResult(null)
    })
  }
  async function generate() {
    if (!preview || !orderFile) return
    await perform('正在保存分拣结果', async () => {
      const saved = await request<RunResult>('/order-sorting/run', {
        id: preview.id,
        revision: preview.revision,
        filename: orderFile.name,
        order: preview.order,
      })
      setResult(saved)
      setPreview(null)
      await state.refetch()
      setMessage('分拣结果已保存，可下载各组文件或全部打包。')
    })
  }
  async function importFiles() {
    await perform('正在保存清单和模板', async () => {
      if (!config && (!attrFile || !templateFile))
        throw Error('首次使用请同时选择产品属性清单和分拣模板。')
      if (!attrFile && !templateFile) throw Error('请先选择需要导入的工作簿。')
      const io = await import('../../../packages/order-sorting/workbook')
      const attr = attrFile ? await bytes(attrFile) : null,
        template = templateFile ? await bytes(templateFile) : null
      if (template) await io.validateTemplate(template)
      const rows = attr ? (await io.parseAttributes(attr)).rows : config!.rows
      await request('/order-sorting/config', {
        revision: config?.revision ?? 0,
        rows,
        ...(attr && attrFile ? { attributeFile: { name: attrFile.name, base64: encoded(attr) } } : {}),
        ...(template && templateFile
          ? { templateFile: { name: templateFile.name, base64: encoded(template) } }
          : {}),
      })
      setDirty(false)
      setPreview(null)
      setAttrFile(null)
      setTemplateFile(null)
      setImportKey((key) => key + 1)
      await state.refetch()
      setMessage('清单和模板已保存。之后的分拣将使用这个版本。')
    })
  }
  async function saveRows() {
    await perform('正在保存属性', async () => {
      await request('/order-sorting/config', { revision: editRevision, rows: edited })
      setDirty(false)
      setPreview(null)
      await state.refetch()
      setMessage('属性清单已保存。已生成的历史结果保持原样。')
    })
  }
  async function exportRows() {
    if (!config) return
    await perform('正在导出属性清单', async () => {
      const io = await import('../../../packages/order-sorting/workbook')
      download(
        await io.exportAttributes(await asset(config.attributeKey), config.rows),
        '01_产品属性清单_待填写.xlsx',
      )
    })
  }
  async function exportResult(index?: number) {
    if (!result) return
    await perform('正在生成下载文件', async () => {
      const io = await import('../../../packages/order-sorting/workbook'),
        template = await asset(result.templateKey)
      if (index === undefined)
        download(
          await io.exportZip(template, result.plan),
          '分拣订单_' + result.plan.date + '.zip',
          true,
        )
      else {
        const group = result.plan.groups[index]
        download(await io.exportGroup(template, group, result.plan.date), group.filename)
      }
    })
  }
  function changeCell(index: number, column: number, value: string) {
    const next = copyRows(edited)
    let v: Cell = value === '' ? null : value
    if (column === 7 && value !== '' && !value.startsWith('=') && Number.isFinite(Number(value)))
      v = Number(value)
    next[index][column] = v
    setEdited(next)
    setDirty(true)
  }
  const plan = preview?.plan ?? result?.plan
  const history = [...(state.data?.runs ?? []), ...olderRuns]
  async function loadOlderRuns() {
    const last = history.at(-1)
    if (!last) return
    await perform('正在读取历史记录', async () => {
      const next = await request<RunPage>(
        `/order-sorting/history?time=${last.createdAt}&id=${encodeURIComponent(last.id)}`,
      )
      setOlderRuns((previous) => [...previous, ...next.runs])
      setHistoryEnd(!next.next)
    })
  }
  const filtered = edited
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !search ||
        row.some((v) =>
          String(v ?? '')
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
    )
  const visible = filtered.slice(page * 25, (page + 1) * 25)
  return (
    <div className="order-sorting-page">
      <Title
        eyebrow="ORDER SORTING"
        title="订单分拣"
        desc="上传 Seller Flex Order List，按产品属性清单分组，生成备货分拣表。"
      >
        <button
          type="button"
          className="secondary"
          disabled={!!busy}
          onClick={() => void state.refetch()}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </Title>
      <div className="sorting-tabs">
        <button type="button" className={tab === 'pack' ? 'active' : ''} onClick={() => setTab('pack')}>
          Pack 自动分拣
        </button>
        <button type="button" className={tab === 'sort' ? 'active' : ''} onClick={() => setTab('sort')}>
          <PackageCheck size={17} />
          订单分拣
        </button>
        <button
          type="button"
          className={tab === 'attributes' ? 'active' : ''}
          onClick={() => setTab('attributes')}
        >
          <FileSpreadsheet size={17} />
          属性清单与模板
        </button>
      </div>
      <ErrorBox error={error || state.error} />
      {message && <Notice success>{message}</Notice>}
      {busy && (
        <p className="muted" aria-live="polite">
          {busy}…
        </p>
      )}
      {state.isLoading ? (
        <Loading />
      ) : (
        <>
          {!config && (
            <Notice>
              尚未导入属性清单和模板。
              {admin ? '请在“属性清单与模板”中完成首次导入。' : '请联系管理员完成首次导入。'}
            </Notice>
          )}
          {tab === 'pack' ? (
            <PackOrdersPanel />
          ) : tab === 'sort' ? (
            <>
              <Panel title="上传订单">
                <div className="panel-body stack">
                  <label className="sorting-upload">
                    <Upload size={24} />
                    <span>
                      <strong>选择 Seller Flex 导出的订单列表</strong>
                      <small>包含 Order List 工作表的 .xlsx，最大 6 MB。</small>
                    </span>
                    <input
                      aria-label="Order List 文件"
                      type="file"
                      accept=".xlsx"
                      disabled={!edit || !!busy}
                      onChange={(e) => {
                        setOrderFile(e.target.files?.[0] ?? null)
                        setPreview(null)
                        setResult(null)
                        setError(null)
                        setMessage('')
                      }}
                    />
                  </label>
                  <div className="sorting-toolbar">
                    <span className="muted">
                      {orderFile?.name ?? '尚未选择订单文件'}
                      {config ? ` · 属性清单 v${config.revision}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={!edit || !config || !orderFile || !!busy}
                      onClick={() => void previewOrder()}
                    >
                      预览分拣
                    </button>
                  </div>
                  {!edit && (
                    <p className="muted">当前账户可查看和下载分拣记录，生成订单需要运营权限。</p>
                  )}
                </div>
              </Panel>
              {plan && (
                <Panel title={result ? '已生成的分拣结果' : '分拣预览'}>
                  <div className="panel-body stack">
                    <div className="sorting-stats">
                      <div>
                        <small>订单日期</small>
                        <strong>{plan.date}</strong>
                      </div>
                      <div>
                        <small>分组</small>
                        <strong>{plan.groups.length}</strong>
                      </div>
                      <div>
                        <small>原始记录</small>
                        <strong>{plan.totalRows}</strong>
                      </div>
                      <div>
                        <small>数量合计</small>
                        <strong>{plan.totalUnits}</strong>
                      </div>
                    </div>
                    <p className="muted">
                      新增产品代码 {plan.additions.length} 个，填写分类 {plan.filled} 处。
                      {preview
                        ? '预览尚未写入清单或生成记录。'
                        : `生成于 ${stamp(result!.createdAt)}，使用清单 v${result!.revision}。`}
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>分组 / 文件名</th>
                            <th>订单记录</th>
                            <th>合并后明细</th>
                            <th>数量</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.groups.map((g, i) => (
                            <tr key={g.name}>
                              <td>
                                <strong>{g.name}</strong>
                                <small className="sorting-filename">{g.filename}</small>
                              </td>
                              <td>{g.raw.length}</td>
                              <td>{g.detail.length}</td>
                              <td>{g.units}</td>
                              <td>
                                {result ? (
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={!!busy}
                                    aria-label={'下载 ' + g.filename}
                                    onClick={() => void exportResult(i)}
                                  >
                                    <Download size={15} />
                                    下载
                                  </button>
                                ) : g.name === '待确认' ? (
                                  '待确认分类'
                                ) : (
                                  '待生成'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {plan.additions.length > 0 && (
                      <details>
                        <summary>查看新增产品代码</summary>
                        <div className="sorting-additions">
                          {plan.additions.map((a) => (
                            <p key={a.code}>
                              <b>{a.code}</b> · {a.group ?? '分类留空'} <small>{a.sku}</small>
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                    <div className="actions">
                      {preview && preview.plan.groups.length === 1 && preview.order.rows.length <= 20 && (
                        <button type="button" className="secondary" disabled={!edit || !!busy} onClick={() => void perform('正在获取主图并生成带图预览', async () => {
                          const response = await fetch('/api/order-sorting/picking-preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: preview.revision, order: preview.order }) })
                          if (!response.ok) {
                            const data = await response.json() as { error?: { message?: string } }
                            throw new Error(data.error?.message ?? '带图预览暂未完成，请重试。')
                          }
                          download(new Uint8Array(await response.arrayBuffer()), preview.plan.groups[0].filename.replace(/\.xlsx$/i, '-带图备货单.xlsx'))
                          setMessage('带图预览已保存到 ERP 并下载；未写入正式分拣记录。')
                        })}>下载带图备货单预览</button>
                      )}
                      {preview && (
                        <button type="button" disabled={!edit || !!busy} onClick={() => void generate()}>
                          生成并保存分拣结果
                        </button>
                      )}
                      {result && (
                        <button type="button" disabled={!!busy} onClick={() => void exportResult()}>
                          <Download size={16} />
                          下载全部分拣表 ZIP
                        </button>
                      )}
                      {result && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => void exportRows()}
                        >
                          下载当前属性清单
                        </button>
                      )}
                    </div>
                  </div>
                </Panel>
              )}
              <Panel title="分拣记录">
                <div className="panel-body">
                  {!history.length ? (
                    <div className="sorting-empty">
                      <FolderOpen size={28} />
                      <p>生成后会在这里保存记录，可随时重新下载。</p>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>原始文件</th>
                            <th>订单日期</th>
                            <th>分组 / 记录 / 数量</th>
                            <th>生成时间</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((r) => (
                            <tr key={r.id}>
                              <td>{r.filename}</td>
                              <td>{r.date}</td>
                              <td>
                                {r.groups} / {r.rows} / {r.units}
                              </td>
                              <td>{stamp(r.createdAt)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void perform('正在读取历史结果', async () => {
                                      setResult(await request<RunResult>('/order-sorting/runs/' + r.id))
                                      setPreview(null)
                                    })
                                  }
                                >
                                  查看分拣结果
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!historyEnd && history.length >= 30 && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => void loadOlderRuns()}
                    >
                      加载更早记录
                    </button>
                  )}
                </div>
              </Panel>
            </>
          ) : (
            <>
              <Panel title="产品属性清单">
                <div className="panel-body stack">
                  <div className="sorting-toolbar">
                    <p>
                      {config
                        ? `版本 v${config.revision} · ${config.rows.filter((r) => r[2]).length} 个产品类别`
                        : '尚未导入'}
                      {dirty ? ' · 有未保存修改' : ''}
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!config || !!busy}
                        onClick={() => void exportRows()}
                      >
                        <Download size={16} />
                        导出属性清单
                      </button>
                      {admin && (
                        <button
                          type="button"
                          disabled={!dirty || !!busy}
                          onClick={() => void saveRows()}
                        >
                          保存清单修改
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="muted">
                    A 列分组优先于 SKU 关键词规则。生成分拣后，新增产品代码和可确定的空白分类会自动补录到
                    ERP。导入或编辑仅影响之后的分拣。
                  </p>
                  <label className="sorting-search">
                    搜索属性
                    <input
                      value={search}
                      placeholder="搜索产品类别、SKU 或分组"
                      onChange={(e) => {
                        setSearch(e.target.value)
                        setPage(0)
                      }}
                    />
                  </label>
                  {dirty && config?.revision !== editRevision && (
                    <Notice>
                      清单已有更新，你的编辑未被覆盖。保存时会检查版本，请先复制需保留的修改，再重新载入最新清单。
                    </Notice>
                  )}
                  <div className="table-wrap sorting-attributes">
                    <table>
                      <thead>
                        <tr>
                          <th>行</th>
                          {labels.map((l) => (
                            <th key={l}>{l}</th>
                          ))}
                          {admin && <th>操作</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(({ row, index }) => (
                          <tr key={index}>
                            <td>{index + 2}</td>
                            {labels.map((l, c) => (
                              <td key={l}>
                                {admin ? (
                                  <input
                                    aria-label={`第${index + 2}行 ${l}`}
                                    value={String(row[c] ?? '')}
                                    disabled={!!busy}
                                    onChange={(e) => changeCell(index, c, e.target.value)}
                                  />
                                ) : (
                                  String(row[c] ?? '')
                                )}
                              </td>
                            ))}
                            {admin && (
                              <td>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={!!busy}
                                  onClick={() => {
                                    setEdited(edited.filter((_, i) => i !== index))
                                    setDirty(true)
                                  }}
                                >
                                  删除
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="sorting-toolbar">
                    <div className="actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!page}
                        onClick={() => setPage(page - 1)}
                      >
                        上一页
                      </button>
                      <span>
                        {page + 1} / {Math.max(1, Math.ceil(filtered.length / 25))}
                      </span>
                      <button
                        type="button"
                        className="secondary"
                        disabled={(page + 1) * 25 >= filtered.length}
                        onClick={() => setPage(page + 1)}
                      >
                        下一页
                      </button>
                    </div>
                    {admin && (
                      <div className="actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!config || !!busy}
                          onClick={() => {
                            setEdited([...edited, Array(11).fill(null)])
                            setSearch('')
                            setPage(Math.floor(edited.length / 25))
                            setDirty(true)
                          }}
                        >
                          新增产品类别
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={!config || !!busy}
                          onClick={() => {
                            setDirty(false)
                            setEdited(copyRows(config!.rows))
                            setEditRevision(config!.revision)
                            setPage(0)
                          }}
                        >
                          重新载入已保存清单
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              {admin && (
                <Panel title="导入清单与模板">
                  <div className="panel-body stack">
                    <p className="muted">
                      选择文件后保存。导入清单会替换 ERP 当前清单；仅更换模板时，已有属性不变。清单由 ERP
                      维护，不自动写回共享盘。
                    </p>
                    <div className="sorting-imports" key={importKey}>
                      <label>
                        导入产品属性清单
                        <input
                          aria-label="导入产品属性清单"
                          type="file"
                          accept=".xlsx"
                          disabled={!!busy}
                          onChange={(e) => setAttrFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      <label>
                        导入分拣模板
                        <input
                          aria-label="导入分拣模板"
                          type="file"
                          accept=".xlsx"
                          disabled={!!busy}
                          onChange={(e) => setTemplateFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                    </div>
                    <div className="actions">
                      <button
                        type="button"
                        disabled={!!busy || (!attrFile && !templateFile) || dirty}
                        onClick={() => void importFiles()}
                      >
                        保存导入文件
                      </button>
                      {config && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!!busy}
                          onClick={() =>
                            void perform('正在下载模板', async () =>
                              download(await asset(config.templateKey), '分拣模板.xlsx'),
                            )
                          }
                        >
                          下载当前模板
                        </button>
                      )}
                    </div>
                    {dirty && (
                      <p className="muted">请先保存清单修改或重新载入已保存清单，再导入文件。</p>
                    )}
                  </div>
                </Panel>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
