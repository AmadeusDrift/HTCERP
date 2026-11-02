import { useRef, useState } from 'react'
import { date, ErrorBox, request } from './ui'

type OnlineAction = {
  operation: string
  productId?: string
  platform?: string
  keyword?: string
  categoryId?: string
  maxPrice?: number | null
  minSold?: number
  pages: number
  calls: number
  childResearch: number
  maxDataPoints: number
  maxAiMicros: number
  writeWatchPool: boolean
}
export type CollaborationState = {
  scopeVersion?: number
  proposals?: {
    id: string
    scopeVersion: number
    status: string
    expiresAt: string
    actions: OnlineAction[]
    maxDataPoints: number
    maxAiMicros: number
  }[]
  messages?: { id: string; message: string; state: string; createdAt?: string }[]
  reportVersions?: { revision: number; scopeVersion: number; generatedAt: string; answer: string }[]
  linkedJobs?: { id: string; jobId?: string; operation: string; status: string; summary?: string }[]
}
const operations: Record<string, string> = {
  discovery: '在线找商品',
  product_refresh: '更新商品资料',
  research: '研究指定商品',
  amazon_backfill: '补查 Amazon 竞品',
  reviews_refresh: '更新评论分析',
}
const dollars = (micros: number) => '$' + (micros / 1000000).toFixed(6)

export function AssistantCollaboration({
  runId,
  status,
  run,
  canOnline,
  isAdmin,
  changed,
}: {
  runId: string
  status: string
  run: CollaborationState
  canOnline: boolean
  isAdmin: boolean
  changed: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [operation, setOperation] = useState('research'),
    [productId, setProductId] = useState(''),
    [keyword, setKeyword] = useState('')
  const [platform, setPlatform] = useState('temu'),
    [pages, setPages] = useState(1),
    [points, setPoints] = useState(10),
    [ai, setAi] = useState('0.36')
  const [write, setWrite] = useState(false)
  const messageId = useRef('')
  const base = '/assistant/investigations/' + encodeURIComponent(runId)
  async function act(path: string, body: unknown) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await request(base + path, body)
      await changed()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试。')
      return false
    } finally {
      setBusy(false)
    }
  }
  async function send() {
    if (!message.trim()) return
    messageId.current ||= crypto.randomUUID()
    if (await act('/messages', { id: messageId.current, message, intent: 'continue' })) {
      setMessage('')
      messageId.current = ''
    }
  }
  async function propose() {
    const totalAi = Math.round(Number(ai) * 1000000)
    if (!Number.isSafeInteger(totalAi) || totalAi < 0) {
      setError('请输入有效的 AI 美元上限。')
      return
    }
    const calls =
      operation === 'discovery'
        ? platform === 'amazon'
          ? pages * 3
          : pages
        : operation === 'research'
          ? 8
          : operation === 'amazon_backfill'
            ? 5
            : operation === 'reviews_refresh'
              ? 2
              : 1
    const actionAi = operation === 'research' ? 33000 : operation === 'reviews_refresh' ? 30000 : 0
    await act('/proposals', {
      actions: [
        {
          operation,
          ...(operation === 'discovery' ? { platform, keyword, pages } : { productId, pages: 1 }),
          calls,
          childResearch: 0,
          maxDataPoints: points,
          maxAiMicros: actionAi,
          writeWatchPool: operation === 'research' && write,
        },
      ],
      maxDataPoints: points,
      maxAiMicros: totalAi,
      expiresInMinutes: 30,
    })
  }
  const pending = (run.proposals ?? []).filter((p) => p.status === 'pending')
  return (
    <div className="oa-collaboration">
      {pending.map((proposal) => (
        <section className="oa-proposal" key={proposal.id} aria-label="在线补查计划">
          <b>在线补查计划</b>
          <small>
            范围版本 {proposal.scopeVersion} · 有效至 {date(proposal.expiresAt, true)}
          </small>
          {(proposal.scopeVersion !== run.scopeVersion ||
            Date.parse(proposal.expiresAt) <= Date.now()) && (
            <small>计划已过期或条件已改变，请重新制定计划。</small>
          )}
          {proposal.actions.map((action) => (
            <div key={JSON.stringify(action)}>
              <p>
                {operations[action.operation] ?? action.operation} ·{' '}
                {action.productId || action.keyword || action.platform}
              </p>
              <small>
                美国站 · 平台 {action.platform || action.productId?.split(':')[0] || '未指定'} · 类目{' '}
                {action.categoryId || '不限'} · 关键词 {action.keyword || '不限'}
              </small>
              <small>
                价格上限 {action.maxPrice == null ? '不限' : dollars(action.maxPrice * 1000000)} ·
                销量下限 {action.minSold ?? 0}
              </small>
              <small>
                {action.pages} 页 · 最多 {action.calls} 次请求 · 最多 {action.childResearch} 个子研究
              </small>
              <small>
                动作额度：{action.maxDataPoints} 数据积分 · AI {dollars(action.maxAiMicros)}
              </small>
              <small>
                {action.writeWatchPool ? '允许写入观察池，保留已有人工意见' : '只分析，不写入观察池'}
              </small>
            </div>
          ))}
          <p>
            整次调查上限：{proposal.maxDataPoints} 数据积分 · AI {dollars(proposal.maxAiMicros)}
            （包含已用和预留）
          </p>
          <div className="inline wrap">
            <button
              type="button"
              disabled={
                busy ||
                !canOnline ||
                (!isAdmin && proposal.actions.some((a) => a.operation === 'reviews_refresh')) ||
                proposal.scopeVersion !== run.scopeVersion ||
                Date.parse(proposal.expiresAt) <= Date.now()
              }
              onClick={() => void act('/proposals/' + encodeURIComponent(proposal.id) + '/confirm', {})}
            >
              确认这次补查
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('/proposals/' + encodeURIComponent(proposal.id) + '/reject', {})}
            >
              拒绝补查
            </button>
          </div>
          {!canOnline && <small>需要运营或管理员账号确认在线补查。</small>}
          {!isAdmin && proposal.actions.some((a) => a.operation === 'reviews_refresh') && (
            <small>评论更新需要管理员确认。</small>
          )}
        </section>
      ))}
      {!!run.linkedJobs?.length && (
        <div>
          {run.linkedJobs.map((job) => (
            <small key={job.id}>
              {operations[job.operation] ?? job.operation} · {job.summary || job.status}
            </small>
          ))}
        </div>
      )}
      {!!run.messages?.length && (
        <section aria-label="调查补充记录">
          {run.messages.map((m) => (
            <p key={m.id}>
              {m.message}
              <small>{m.state === 'pending' ? '已收到，将在下一步采用' : '已采用'}</small>
            </p>
          ))}
        </section>
      )}
      {!['cancelled', 'cancelling', 'pausing'].includes(status) && (
        <div className="oa-followup">
          <label>
            补充调查条件
            <textarea
              aria-label="补充调查条件"
              rows={2}
              maxLength={2000}
              value={message}
              disabled={busy}
              onChange={(e) => {
                setMessage(e.target.value)
                messageId.current = ''
              }}
              placeholder="例如：排除第二款，重点比较第一款和第三款"
            />
          </label>
          <button type="button" disabled={busy || !message.trim()} onClick={() => void send()}>
            发送补充，继续这次调查
          </button>
          <small>沿用本次调查额度；改条件后，旧补查确认失效。</small>
        </div>
      )}
      {!!run.reportVersions?.length && (
        <details>
          <summary>查看历史报告（{run.reportVersions.length}）</summary>
          {run.reportVersions.map((v) => (
            <article key={v.revision}>
              <small>
                报告 {v.revision} · 范围版本 {v.scopeVersion} · {date(v.generatedAt, true)}
              </small>
              <p>{v.answer}</p>
            </article>
          ))}
        </details>
      )}
      {canOnline && !['cancelled', 'cancelling', 'paused', 'pausing', 'failed'].includes(status) && (
        <details className="oa-proposal-form">
          <summary>制定补查计划</summary>
          <label>
            补查动作
            <select value={operation} onChange={(e) => setOperation(e.target.value)}>
              {Object.entries(operations)
                .filter(([key]) => isAdmin || key !== 'reviews_refresh')
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {operation === 'discovery' ? (
            <>
              <label>
                平台
                <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  <option value="temu">Temu 美国站</option>
                  <option value="amazon">Amazon 美国站</option>
                </select>
              </label>
              <label>
                关键词
                <input value={keyword} maxLength={150} onChange={(e) => setKeyword(e.target.value)} />
              </label>
              <label>
                最多页数
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={pages}
                  onChange={(e) => setPages(Number(e.target.value))}
                />
              </label>
            </>
          ) : (
            <label>
              商品 ID
              <input
                value={productId}
                placeholder="temu:US:123"
                onChange={(e) => setProductId(e.target.value)}
              />
            </label>
          )}
          <label>
            整次调查数据积分上限
            <input
              type="number"
              min={0}
              max={100000}
              value={points}
              onChange={(e) => setPoints(Number(e.target.value))}
            />
          </label>
          <label>
            整次调查 AI 美元上限
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={ai}
              onChange={(e) => setAi(e.target.value)}
            />
          </label>
          {operation === 'research' && (
            <label className="inline">
              <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
              允许将建议跟进的商品加入观察池
            </label>
          )}
          <small>计划有效 30 分钟。生成计划后仍需确认，才会联网补查。</small>
          <button type="button" disabled={busy} onClick={() => void propose()}>
            生成待确认计划
          </button>
        </details>
      )}
      <ErrorBox error={error} />
    </div>
  )
}
