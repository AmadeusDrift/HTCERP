import { useEffect, useState } from 'react'
import type { AuditHit, buildTitleAuditInspector } from '../../../packages/title-audit/context-review'
import { Title, useData, useWrite, useAccess, request, ErrorBox } from './ui'
import './title-audit.css'
import { TitleDictionary } from './title-dictionary'

type Result = ReturnType<ReturnType<typeof buildTitleAuditInspector>>
type Row = Result & {
  sku: string
  asin: string | null
  title: string
  disposition: string
  evidence: string
}
type AuditWindow = { id: string; window_start_ms: number; window_end_ms: number }
type Summary = {
  store: { seller: string; enabled: number } | null
  last: { status: string; started: string; error: string | null } | null
  complete: (AuditWindow & { finished: string; status: string; error: string | null }) | null
  runs?: AuditWindow[]
  counts: { verdict: Result['verdict']; n: number }[]
  total: number
  rows: Row[]
}
const states = ['重点提醒', '建议改写', '冲突', '低优先级', '通过', '缺少标题，待补查'] as const
function Marked({ title, hits }: { title: string; hits: AuditHit[] }) {
  let end = 0
  return (
    <>
      {hits.map((h) => {
        const prefix = title.slice(end, h.start)
        end = h.end
        return (
          <span key={h.start}>
            {prefix}
            <mark title={h.reason} data-level={h.verdict}>
              {title.slice(h.start, h.end)}
            </mark>
          </span>
        )
      })}
      {title.slice(end)}
    </>
  )
}
function Details({ hits }: { hits: AuditHit[] }) {
  return (
    <ul>
      {hits.map((h) => (
        <li key={h.start}>
          <b>{h.term}</b> · {h.verdict} {h.families.join(' / ')} — {h.reason}
        </li>
      ))}
    </ul>
  )
}
function date(s: string) {
  return new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
function Rewrite({ title, hits }: { title: string; hits: AuditHit[] }) {
  const [msg, setMsg] = useState('')
  const hit = hits.find((h) => h.verdict === '建议改写' && h.start === 0)
  if (!hit) return null
  const product = /\b(case|cover|charger|filter|adapter|protector|replacement band|lid)\b/i.exec(
    title.slice(hit.end),
  )
  if (!product) return null
  const at = hit.end + product.index
  const suggestion =
    product[0] + ' for ' + title.slice(0, at).trim() + title.slice(at + product[0].length)
  return (
    <p>
      确认适配后可参考：{suggestion}{' '}
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(suggestion)
            setMsg('已复制')
          } catch {
            setMsg('请选中文字复制')
          }
        }}
      >
        复制建议标题
      </button>{' '}
      {msg}
    </p>
  )
}
function Draft({ initial }: { initial: string }) {
  const [text, set] = useState(initial),
    [checked, save] = useState<{ title: string; r: Result } | null>(null)
  const check = useWrite<Result>()
  const [initialError, setInitialError] = useState('')
  useEffect(() => {
    if (!initial.trim()) return
    let active = true
    request<Result>('/title-audit/preview', { title: initial.trim() })
      .then((r) => {
        if (active) save({ title: initial.trim(), r })
      })
      .catch((e) => {
        if (active) setInitialError(e instanceof Error ? e.message : '复查失败')
      })
    return () => {
      active = false
    }
  }, [initial])
  return (
    <section className="audit-box">
      <h2>新上架产品 · 标题自查</h2>
      <label>
        美国站英文标题
        <textarea
          value={text}
          maxLength={1000}
          onChange={(e) => {
            set(e.target.value)
            save(null)
          }}
          placeholder="粘贴准备上架的英文商品标题"
        />
      </label>
      <button
        className="btn primary"
        disabled={!text.trim() || check.isPending}
        onClick={() => {
          const title = text.trim()
          check.mutate(
            { path: '/title-audit/preview', body: { title } },
            { onSuccess: (r) => save({ title, r }) },
          )
        }}
      >
        检查标题
      </button>
      {check.error && <ErrorBox error={check.error} />}
      {initialError && <p role="alert">{initialError}</p>}
      {checked && checked.title === text.trim() && (
        <div aria-live="polite">
          <h3>{checked.r.verdict}</h3>
          <Marked title={checked.title} hits={checked.r.hits} />
          <Details hits={checked.r.hits} />
          <Rewrite title={checked.title} hits={checked.r.hits} />
          {!checked.r.hits.length && '未发现需要复核的标题线索。'}
        </div>
      )}
    </section>
  )
}
export function TitleAudit() {
  const [tab, setTab] = useState('巡检'),
    [draft, setDraft] = useState(''),
    [result, setResult] = useState('风险'),
    [state, setState] = useState(''),
    [search, setSearch] = useState(''),
    [family, setFamily] = useState(''),
    [term, setTerm] = useState(''),
    [page, setPage] = useState(0),
    [selectedRun, setSelectedRun] = useState('')
  const haul = tab === 'Haul 新上架'
  const params = new URLSearchParams({ result, state, q: search, term, family, page: String(page) })
  if (haul) {
    params.set('scope', 'haul')
    if (selectedRun) params.set('run', selectedRun)
  }
  const list = useData<Summary>('/title-audit/results?' + params, haul || tab === '巡检', 15000),
    { admin, edit } = useAccess(),
    write = useWrite()
  const [enabled, setEnabled] = useState(false),
    [exporting, setExporting] = useState(false),
    [err, setErr] = useState('')
  const data = list.data
  useEffect(() => {
    if (data?.store) {
      setEnabled(!!data.store.enabled)
    }
  }, [data?.store?.seller, data?.store?.enabled])
  function reset(fn: (v: string) => void, v: string) {
    setPage(0)
    fn(v)
  }
  async function exportCsv(withImages = false) {
    if (!data?.complete) return
    setExporting(true)
    setErr('')
    try {
      if (withImages && data.total > 1000) throw new Error('带图 Excel 每次最多导出 1,000 条，请缩小筛选范围。')
      const workbook = withImages ? new (await import('exceljs')).Workbook() : null
      const sheet = workbook?.addWorksheet('标题巡检')
      if (sheet) {
        sheet.columns = ['产品图片','SKU','ASIN','疑似品牌或 IP','判断原因','检测结果','原标题','商品链接'].map((header,i) => ({header,width:[15,32,16,32,68,20,75,45][i]}))
        sheet.views = [{state:'frozen',ySplit:1}]
        sheet.autoFilter = 'A1:H1'
      }
      const imageIds = new Map<string,number | null>()
      const rows = [['SKU', 'ASIN', '商品链接', '原标题', '检测结果', '平台状态', '亚马逊依据']]
      params.set('run', data.complete.id)
      for (let i = 0; ; i++) {
        params.set('page', String(i))
        const p = await request<Summary>('/title-audit/results?' + params)
        if (!p.complete) throw new Error('巡检快照已过期，请刷新。')
        if (sheet && workbook) {
          const missing = [...new Set(p.rows.map(r => r.asin).filter((a): a is string => !!a && !imageIds.has(a)))]
          for (let j = 0; j < missing.length; j += 20) {
            const asins = missing.slice(j,j+20)
            const images = await request<Record<string,string>>('/title-audit/export-images', {run:data.complete.id, asins})
            for (const asin of asins) imageIds.set(asin, images[asin] ? workbook.addImage({base64:images[asin],extension:'jpeg'}) : null)
          }
          for (const r of p.rows) {
            const hits = r.hits.filter(h => h.verdict !== '通过')
            const id = r.asin ? imageIds.get(r.asin) : null
            const row = sheet.addRow([id == null ? '暂无主图' : '',r.sku,r.asin,
              [...new Set(hits.map(h => h.names.join(' / ') || h.term))].join('；'),
              hits.map(h => h.term + '：' + h.reason).join('\n') || (r.title ? '未命中风险词' : '标题为空，待补查'),
              r.verdict,r.title,r.asin ? 'https://www.amazon.com/dp/'+r.asin : ''])
            row.height = 64
            row.alignment = {vertical:'middle',wrapText:true}
            if (id != null) sheet.addImage(id, {tl:{col:0,row:row.number-1},ext:{width:80,height:80},editAs:'oneCell'})
          }
        }
        for (const r of p.rows)
          rows.push([
            r.sku,
            r.asin ?? '',
            r.asin ? 'https://www.amazon.com/dp/' + r.asin : '',
            r.title,
            r.verdict,
            r.disposition,
            r.evidence,
          ])
        if ((i + 1) * 50 >= p.total) break
      }
      const csv = rows
        .map((row) =>
          row
            .map((v) => '"' + (/^[=+@\-\t\r]/.test(v) ? "'" : '') + v.replaceAll('"', '""') + '"')
            .join(','),
        )
        .join('\r\n')
      const blob = workbook ? new Blob([await workbook.xlsx.writeBuffer() as ArrayBuffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}) : new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob),
        a = document.createElement('a')
      a.href = url
      a.download = workbook ? '美国站文字巡检-带图.xlsx' : '美国站文字巡检.csv'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }
  return (
    <div className="audit">
      <Title
        eyebrow="美国站 · 商品文案"
        title="文字侵权检测"
        desc="按品牌词和 IP 名称检查标题。平台销售状态单独显示。"
      />
      <div className="audit-tabs">
        {['巡检', 'Haul 新上架', '自查', '词库'].map((t) => (
          <button className={'btn ' + (t === tab ? 'primary' : '')} key={t} onClick={() => { setTab(t); setPage(0) }}>
            {t === '巡检' ? '已上架商品巡检' : t === '自查' ? '新上架标题自查' : t}
          </button>
        ))}
      </div>
      {tab === '词库' ? (
        <TitleDictionary />
      ) : tab === '自查' ? (
        <Draft initial={draft} />
      ) : (
        <>
          <section className="audit-box">
            <h2>{haul ? 'Haul 新上架巡检' : '店铺巡检'}</h2>
            {admin && (
              <details>
                <summary>美国站巡检设置</summary>
                <p>{data?.store ? '当前店铺：' + data.store.seller : '尚未绑定美国站店铺'} · <a href="/settings?tab=connections">前往 Amazon SP-API 数据连接</a></p>
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />{' '}
                  每 30 分钟巡检新上架 Haul 商品
                </label>
                <button
                  className="btn"
                  disabled={write.isPending || !data?.store}
                  onClick={() => write.mutate({ path: '/title-audit/schedule', body: { enabled } })}
                >
                  保存设置
                </button>
              </details>
            )}
            <p>
              {data?.complete
                ? (data.complete.status === 'partial' ? '最近部分结果（北京时间） ' : '最近完成（北京时间） ') + date(data.complete.finished)
                : '暂无已完成的巡检'}{' '}
              · 已扫描 {data?.counts.reduce((n, x) => n + x.n, 0) ?? 0} 个 SKU
            </p>
            {haul && !!data?.runs?.length && (
              <label>
                巡检批次（北京时间）
                <select value={selectedRun} onChange={(event) => reset(setSelectedRun, event.target.value)}>
                  <option value="">最新批次</option>
                  {data.runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {date(new Date(run.window_start_ms).toISOString())} 至 {date(new Date(run.window_end_ms).toISOString())}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {haul && selectedRun && data && !data.complete && <p role="status">该批次已过期，请选择其他批次。</p>}
            {data?.complete?.status === 'partial' && <p role="status">{data.complete.error}</p>}
            {data?.last?.status === 'running' && (
              <p role="status">正在读取美国站商品，完成后更新列表。</p>
            )}
            {data?.last?.status === 'failed' && (
              <p role="alert">本轮未完成：{data.last.error}。列表保留上次可用结果。</p>
            )}
            {edit && !haul && (
              <button
                className="btn primary"
                disabled={!data?.store || write.isPending || data.last?.status === 'running'}
                onClick={() => write.mutate({ path: '/title-audit/run', body: {} })}
              >
                立即巡检
              </button>
            )}
            {write.error && <ErrorBox error={write.error} />}
          </section>
          <section className="audit-box">
            <h2>巡检结果</h2>
            <div className="audit-tabs">
              {states.map((s) => (
                <button
                  key={s}
                  className="btn"
                  aria-pressed={result === s}
                  onClick={() => reset(setResult, s)}
                >
                  {s} {data?.counts.find((x) => x.verdict === s)?.n ?? 0}
                </button>
              ))}
            </div>
            <div className="audit-filters">
              <label>
                检测结果
                <select value={result} onChange={(e) => reset(setResult, e.target.value)}>
                  <option value="">全部</option>
                  <option value="风险">重点提醒＋建议改写</option>
                  {states.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                亚马逊处置
                <select value={state} onChange={(e) => reset(setState, e.target.value)}>
                  <option value="">全部状态</option>
                  {['官方已限制销售', '仍可购买', '状态待确认'].map((s) => (
                    <option key={s} value={s}>
                      {s === '官方已限制销售'
                        ? '官方下架／限制销售'
                        : s === '仍可购买'
                          ? '未下架（仍可购买）'
                          : s}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ['SKU / ASIN / 标题', search, setSearch],
                  ['品牌或 IP 家族', family, setFamily],
                  ['命中词或标准名', term, setTerm],
                ] as const
              ).map(([label, v, fn]) => (
                <label key={label}>
                  {label}
                  <input value={v} onChange={(e) => reset(fn, e.target.value)} />
                </label>
              ))}
            </div>
            <p>
              仅展示本次 Amazon 返回的美国站
              SKU。官方限制销售可能由价格或合规问题引起；搜索不可见、无库存或查询不到均不能证明官方下架。
            </p>
            <button className="btn" disabled={!data?.total || exporting} onClick={() => exportCsv()}>
              {exporting ? '导出中…' : '导出筛选结果'}
            </button>{' '}
            <button className="btn" disabled={!data?.total || exporting} onClick={() => exportCsv(true)}>导出带图 Excel</button>{' '}
            {data?.total ?? 0} 条{err && <p role="alert">{err}</p>}
            {list.error && <ErrorBox error={list.error} />}
            {list.isLoading ? (
              <p>读取中…</p>
            ) : data?.rows.length ? (
              data.rows.map((r) => (
                <article key={r.sku}>
                  <div>
                    <b>{r.verdict}</b> · {r.disposition}
                  </div>
                  <p>
                    <Marked title={r.title || '标题缺失'} hits={r.hits} />
                  </p>
                  <small>
                    SKU {r.sku} ·{' '}
                    {r.asin && (
                      <a
                        href={'https://www.amazon.com/dp/' + encodeURIComponent(r.asin)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.asin} ↗
                      </a>
                    )}
                  </small>
                  <details>
                    <summary>查看依据</summary>
                    <Details hits={r.hits} />
                    <Rewrite title={r.title} hits={r.hits} />
                    <p>Amazon：{r.evidence}</p>
                  </details>
                  <button
                    className="btn"
                    onClick={() => {
                      setDraft(r.title)
                      setTab('自查')
                    }}
                  >
                    单条复查
                  </button>
                </article>
              ))
            ) : (
              <p>没有符合筛选条件的商品。</p>
            )}
            <div className="audit-tabs">
              <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              第 {page + 1} 页
              <button
                className="btn"
                disabled={!data || (page + 1) * 50 >= data.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
