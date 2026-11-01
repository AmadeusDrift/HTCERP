import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowUp,
  ClipboardList,
  Ellipsis,
  History,
  ImagePlus,
  MessageSquareText,
  PencilLine,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatTurn, HistoryPage, Transcript } from '../../../packages/assistant/model'
import type { DailyTask } from '../../../packages/assistant/tasks'
import type { Session } from './models'
import { prepareReference } from './reference-image'
import { date, ErrorBox, Loading, PageLink, request, Status, useData } from './ui'
import './assistant.css'

const base = '/assistant/conversations/'
type Panel = 'chat' | 'history' | 'tasks'
type Thread = { id: string; saved: boolean }
const fresh = (): Thread => ({ id: crypto.randomUUID(), saved: false })

function TaskPanel({ close }: { close: () => void }) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const [day, setDay] = useState(today)
  const result = useData<{ date: string; task: DailyTask | null }>(
    '/assistant/daily-tasks?date=' + day,
    true,
    day === today ? 15000 : false,
  )
  const task = result.data?.task
  return (
    <section className="oa-panel">
      <h3>每日选品任务</h3>
      <label>
        任务日期（北京时间）
        <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </label>
      {result.isPending ? (
        <Loading />
      ) : result.isError ? (
        <ErrorBox error={result.error} retry={() => void result.refetch()} />
      ) : task ? (
        <article className="oa-task">
          <div className="spread">
            <b>{task.title}</b>
            <Status status={task.status} />
          </div>
          <small>更新于 {date(task.updatedAt, true)}</small>
          <p>
            已完成 {task.steps} 个步骤 · 筛出 {task.selected} 件商品
          </p>
          {task.latestStep && <p>最近步骤 · {task.latestStep}</p>}
          {task.summary && <p>{task.summary}</p>}
          <PageLink className="btn" href={'/tasks?id=' + encodeURIComponent(task.id)} onClick={close}>
            查看执行详情与选品结果
          </PageLink>
        </article>
      ) : (
        <p className="oa-note">当天还没有团队定时选品任务。</p>
      )}
      <PageLink className="btn" href={'/daily?date=' + day} onClick={close}>
        查看当天选品日报
      </PageLink>
    </section>
  )
}

function AssistantDialog({
  page,
  path,
  session,
  close,
}: {
  page: string
  path: string
  session: Session
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    scroll = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null),
    input = useRef<HTMLTextAreaElement>(null)
  const [initial] = useState(fresh),
    [selection, setSelection] = useState<Thread | null>(null)
  const [panel, setPanel] = useState<Panel>('chat'),
    [menu, setMenu] = useState(false)
  const [question, setQuestion] = useState(''),
    [picture, setPicture] = useState('')
  const [error, setError] = useState(''),
    [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState<ChatTurn | null>(null)
  const sending = useRef(false),
    attempt = useRef(''),
    cache = useQueryClient()
  const product = /^\/products\/(amazon(?:%3A|:)US(?:%3A|:)[A-Z0-9]{10}|(?:temu|shein|tiktok|aliexpress)(?:%3A|:)US(?:%3A|:)\d{1,32})$/i.exec(
    path,
  )
  const productId = product ? decodeURIComponent(product[1]) : undefined
  const label = productId ? '商品详情 · ' + productId : page
  const historyKey = ['assistant-history', session.id]
  const history = useInfiniteQuery({
    queryKey: historyKey,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => request<HistoryPage>('/assistant/conversations?page=' + pageParam),
    getNextPageParam: (last, _, n) => (last.more ? n + 1 : undefined),
    retry: false,
    refetchOnMount: 'always',
  })
  const entries = history.data?.pages.flatMap((p) => p.items) ?? []
  const active = selection ?? (entries[0] ? { id: entries[0].id, saved: true } : initial)
  const turnKey = ['assistant-transcript', session.id, active.id]
  const transcript = useInfiniteQuery({
    queryKey: turnKey,
    initialPageParam: '',
    enabled: active.saved,
    retry: false,
    refetchOnMount: 'always',
    queryFn: ({ pageParam }) =>
      request<Transcript>(base + active.id + (pageParam ? '?before=' + pageParam : '')),
    getNextPageParam: (last) => (last.more ? last.items[0].id : undefined),
    refetchInterval: (q) =>
      q.state.data?.pages[0].items.some((v) => !v.answer && !v.issue) ? 3000 : false,
  })
  const turns = [...(transcript.data?.pages ?? [])].reverse().flatMap((p) => p.items)
  if (pending && !turns.some((v) => v.id === pending.id)) turns.push(pending)
  const latest = turns.at(-1)
  const waiting = !!pending || (!!latest && !latest.answer && !latest.issue)
  const inactive = history.data?.pages[0]?.unavailable
  const disabled =
    waiting ||
    uploading ||
    !!inactive ||
    history.isPending ||
    history.isError ||
    (active.saved && transcript.isPending)
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    const viewport = window.visualViewport
    const adjust = () => {
      if (viewport) {
        el?.style.setProperty('--oa-height', viewport.height + 'px')
        el?.style.setProperty('--oa-top', viewport.offsetTop + 'px')
      }
    }
    adjust()
    viewport?.addEventListener('resize', adjust)
    viewport?.addEventListener('scroll', adjust)
    return () => {
      viewport?.removeEventListener('resize', adjust)
      viewport?.removeEventListener('scroll', adjust)
      el?.close()
    }
  }, [])
  useEffect(() => {
    if (panel === 'chat' && latest && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [latest, panel])
  function choose(t: Thread) {
    setSelection(t)
    setPanel('chat')
    setMenu(false)
    setPicture('')
    setQuestion('')
    setError('')
    attempt.current = ''
  }
  async function attach(f?: File) {
    if (!f) return
    setUploading(true)
    setError('')
    attempt.current = ''
    try {
      setPicture(await prepareReference(f))
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取图片。')
    } finally {
      setUploading(false)
    }
  }
  async function send() {
    if (disabled || sending.current || (!question.trim() && !picture)) return
    sending.current = true
    const id = attempt.current || crypto.randomUUID()
    attempt.current = id
    const threadId = active.id
    const optimistic = {
      id,
      question: question.trim(),
      hasImage: Number(!!picture),
      createdAt: new Date().toISOString(),
      page: label,
      answer: null,
      issue: null,
    }
    setSelection(active)
    setPending(optimistic)
    setError('')
    setMenu(false)
    try {
      const turn = await request<ChatTurn>(base + threadId + '/turns', {
        id,
        question,
        image: picture || undefined,
        page,
        productId,
      })
      cache.setQueryData<{ pages: Transcript[]; pageParams: string[] }>(turnKey, (old) => {
        const pages = [...(old?.pages ?? [{ items: [], more: false }])]
        pages[0] = { ...pages[0], items: [...pages[0].items.filter((v) => v.id !== turn.id), turn] }
        return { pages, pageParams: old?.pageParams ?? [''] }
      })
      setSelection({ id: threadId, saved: true })
      setQuestion('')
      setPicture('')
      attempt.current = ''
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败，请重试。')
    } finally {
      sending.current = false
      setPending(null)
      void cache.invalidateQueries({ queryKey: historyKey })
    }
  }
  return (
    <dialog
      className="assistant-drawer oa-dialog"
      ref={dialog}
      aria-label="运营助手"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="oa-layout">
        <header className="oa-header">
          <button
            className="icon"
            type="button"
            aria-label="新建对话"
            title="新建对话"
            disabled={!!pending || uploading}
            onClick={() => choose(fresh())}
          >
            <PencilLine />
          </button>
          <button
            className="icon"
            type="button"
            aria-label="历史对话"
            title="历史对话"
            aria-pressed={panel === 'history'}
            disabled={!!pending || uploading}
            onClick={() => {
              setPanel(panel === 'history' ? 'chat' : 'history')
              setMenu(false)
            }}
          >
            <History />
          </button>
          <h2>运营助手</h2>
          <button
            className="icon"
            type="button"
            aria-expanded={menu}
            aria-label="更多选项"
            title="更多选项"
            onClick={() => setMenu(!menu)}
          >
            <Ellipsis />
          </button>
          <button className="icon" type="button" aria-label="关闭" onClick={close}>
            <X />
          </button>
          {menu && (
            <div className="oa-menu">
              <button
                type="button"
                onClick={() => {
                  setMenu(false)
                  setPanel('tasks')
                }}
              >
                <ClipboardList />
                每日选品任务
              </button>
            </div>
          )}
        </header>
        {panel !== 'chat' && (
          <button className="oa-back" type="button" onClick={() => setPanel('chat')}>
            <ArrowLeft size={16} />
            返回对话
          </button>
        )}
        {panel === 'history' ? (
          <section className="oa-panel">
            <h3>历史对话</h3>
            {history.isPending ? (
              <Loading />
            ) : history.isError ? (
              <ErrorBox error={history.error} retry={() => void history.refetch()} />
            ) : entries.length ? (
              entries.map((v) => (
                <button
                  type="button"
                  className="oa-thread"
                  key={v.id}
                  onClick={() => choose({ id: v.id, saved: true })}
                >
                  <b>{v.title}</b>
                  <small>{date(v.updatedAt, true)}</small>
                </button>
              ))
            ) : (
              <p className="oa-note">还没有保存的对话。</p>
            )}
            {history.hasNextPage && (
              <button
                type="button"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                查看更多对话
              </button>
            )}
          </section>
        ) : panel === 'tasks' ? (
          <TaskPanel close={close} />
        ) : (
          <>
            <div className="oa-context">
              当前页面 <span>{label}</span>
            </div>
            <div
              className="oa-messages"
              ref={scroll}
              role="log"
              aria-label="对话记录"
              aria-live="polite"
            >
              {history.isError && (
                <ErrorBox error={history.error} retry={() => void history.refetch()} />
              )}
              {active.saved && transcript.isError && (
                <ErrorBox error={transcript.error} retry={() => void transcript.refetch()} />
              )}
              {(history.isPending || (active.saved && transcript.isPending)) && <Loading />}
              {transcript.hasNextPage && (
                <button
                  type="button"
                  disabled={transcript.isFetchingNextPage}
                  onClick={() => void transcript.fetchNextPage()}
                >
                  加载更早的消息
                </button>
              )}
              {!turns.length && !history.isPending && !(active.saved && transcript.isPending) && (
                <div className="oa-empty">
                  <MessageSquareText />
                  <h3>想聊点什么？</h3>
                  <p>
                    {productId
                      ? '可以问这件商品的销量、评价或选品思路。'
                      : '可以问选品问题，也可以上传一张商品图一起看。'}
                  </p>
                </div>
              )}
              {turns.map((turn) => (
                <div className="oa-turn" key={turn.id}>
                  <div className="oa-bubble oa-user">
                    <small>我 · {turn.page}</small>
                    {!!turn.hasImage && (
                      <img
                        alt="对话中上传的图片"
                        src={
                          turn.id === pending?.id && picture
                            ? picture
                            : '/api' + base + active.id + '/images/' + turn.id
                        }
                      />
                    )}
                    {turn.question && <p>{turn.question}</p>}
                  </div>
                  <div className="oa-bubble">
                    <small>运营助手</small>
                    <p>{turn.answer || turn.issue || '正在回复…'}</p>
                  </div>
                </div>
              ))}
            </div>
            <form
              className="oa-composer"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              {inactive && (
                <p className="oa-note" role="status">
                  {inactive}
                </p>
              )}
              <ErrorBox error={error} />
              {picture && (
                <div className="oa-preview">
                  <img src={picture} alt="待发送的图片" />
                  <button
                    type="button"
                    aria-label="移除图片"
                    className="icon"
                    disabled={waiting}
                    onClick={() => {
                      setPicture('')
                      attempt.current = ''
                    }}
                  >
                    <X />
                  </button>
                </div>
              )}
              <textarea
                aria-label="消息"
                placeholder="输入消息…"
                ref={input}
                maxLength={2000}
                rows={2}
                value={question}
                disabled={waiting}
                onChange={(e) => {
                  setQuestion(e.target.value)
                  attempt.current = ''
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="oa-tools">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  ref={file}
                  onChange={(e) => {
                    void attach(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  aria-label="添加图片"
                  title="添加图片"
                  disabled={disabled}
                  onClick={() => file.current?.click()}
                >
                  <ImagePlus />
                  {uploading ? '正在处理…' : '图片'}
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={disabled || (!question.trim() && !picture)}
                  aria-label="发送消息"
                >
                  <ArrowUp />
                  发送
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </dialog>
  )
}
export function OperationsAssistant(props: { page: string; path: string; session: Session }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="assistant-launch"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <MessageSquareText />
        运营助手
      </button>
      {open && <AssistantDialog {...props} close={() => setOpen(false)} />}
    </>
  )
}
