import { useState } from 'react'
import { ErrorBox, useData, useAccess, useWrite } from './ui'
type Entry = {
  name: string
  family: string
  aliases: string[]
  policy: string
  source: string
  url?: string
}
export function TitleDictionary() {
  const [q, setQ] = useState(''),
    [source, setSource] = useState(''),
    [family, setFamily] = useState(''),
    [page, setPage] = useState(0)
  const [name, setName] = useState(''),
    [group, setGroup] = useState(''),
    [aliases, setAliases] = useState(''),
    [reason, setReason] = useState(''),
    [saved, setSaved] = useState('')
  const { edit } = useAccess()
  const write = useWrite(() => {
    setSaved(name)
    setName('')
    setGroup('')
    setAliases('')
    setReason('')
    setQ(name)
    setPage(0)
    setSource('运营新增')
    setFamily('')
  })
  const list = useData<{ rows: Entry[]; total: number; customCount: number }>(
    '/title-audit/terms?' + new URLSearchParams({ q, source, family, page: String(page) }),
  )
  return (
    <section className="audit-box">
      <h2>品牌与 IP 词库</h2>
      <p>
        美国站 v0.3 · 34,478 个基础检索写法 · 550 个品牌或 IP 家族 · 运营新增{' '}
        {list.data?.customCount ?? 0} 条
      </p>
      <div className="audit-filters">
        <label>
          查词或关联表达
          <input
            placeholder="例如 HelloKitty、Sanrio、Marvel"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(0)
            }}
          />
        </label>
        <label>
          词库来源
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value)
              setPage(0)
            }}
          >
            <option value="">全部来源</option>
            {['品牌与 IP', '美国商标', '运营新增'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        {family && (
          <button
            className="btn"
            onClick={() => {
              setFamily('')
              setPage(0)
            }}
          >
            {family} ×
          </button>
        )}
      </div>
      {edit && (
        <details>
          <summary>新增运营风险词</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              write.mutate({
                path: '/title-audit/terms',
                body: {
                  name,
                  family: group,
                  aliases: aliases
                    .split(/[,，\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                  reason,
                },
              })
            }}
          >
            <label>
              标准名称
              <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              所属家族（选填）
              <input maxLength={120} value={group} onChange={(e) => setGroup(e.target.value)} />
            </label>
            <label>
              别名（用逗号分隔）
              <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </label>
            <label>
              重点提醒的原因
              <input
                required
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button className="btn primary" disabled={write.isPending}>
              保存风险词
            </button>
          </form>
        </details>
      )}
      {saved && <p role="status">已加入「{saved}」，自查立即生效，下轮巡检重新匹配。</p>}
      {write.error && <ErrorBox error={write.error} />} {list.error && <ErrorBox error={list.error} />}
      <p>{list.isLoading ? '查询中…' : (list.data?.total ?? 0) + ' 条名称记录'}</p>
      {list.data?.rows.map((r, i) => (
        <article key={r.source + r.name + r.family + i}>
          <b>{r.name}</b> · {r.source} · {r.policy}
          {r.family && (
            <button
              className="btn"
              onClick={() => {
                setFamily(r.family)
                setQ('')
                setSource('')
                setPage(0)
              }}
            >
              查看 {r.family} 关联词
            </button>
          )}
          {r.aliases.length > 0 && <p>关联写法　{r.aliases.join(' / ')}</p>}
          {r.url && (
            <p>
              <a href={r.url} target="_blank" rel="noreferrer">
                查看公开依据 ↗
              </a>
            </p>
          )}
        </article>
      ))}
      <div className="audit-tabs">
        <button className="btn" disabled={!page} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        第 {page + 1} 页
        <button
          className="btn"
          disabled={(page + 1) * 40 >= (list.data?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  )
}
