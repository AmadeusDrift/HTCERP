import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, useRouterState } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  LoaderCircle,
  Search,
  X,
} from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  cloneElement,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { memberDiagnostic } from '../../../packages/contracts/presentation'
import { type Product, platforms, type Session, type Stage, stages, statusLabels } from './models'
import { Select } from './select'
import { loadSession, loginPath } from './session'
export async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  if (path === '/session' && body === undefined) return (await loadSession()) as T
  const response = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data === null) {
    if (response.status === 401 && !path.startsWith('/auth/') && window.location.pathname !== '/login')
      window.location.replace(loginPath(true))
    const message =
      data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : ''
    throw new Error(
      message ||
        (response.status === 401
          ? '请使用已授权的工作账号登录。'
          : '暂时无法读取工作台数据，请稍后重试。'),
    )
  }
  return data as T
}
export function useData<T>(path: string, enabled = true, interval: number | false = false) {
  return useQuery({
    queryKey: [path],
    queryFn: () => request<T>(path),
    enabled,
    refetchInterval: interval,
    retry: false,
    refetchOnWindowFocus: (query) => path === '/session' && !!query.state.data && 'always',
  })
}
export function useWrite<T>(onDone?: (value: T) => void) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => request<T>(path, body),
    onSuccess: (v) => {
      void cache.invalidateQueries()
      onDone?.(v)
    },
  })
}
export function useLocation() {
  const loc = useRouterState({ select: (s) => s.location })
  return {
    path: loc.pathname,
    params: new URLSearchParams(loc.searchStr),
    url: loc.pathname + loc.searchStr,
  }
}
export function useGo() {
  const router = useRouter()
  return (url: string, replace = false) => {
    if (replace) router.history.replace(url)
    else router.history.push(url)
  }
}
export function PageLink({ href, onClick, ...props }: ComponentPropsWithoutRef<'a'> & { href: string }) {
  const go = useGo()
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return
        const link = event.currentTarget
        if (link.origin !== window.location.origin || link.target || link.hasAttribute('download'))
          return
        event.preventDefault()
        const changedPage = link.pathname !== window.location.pathname
        go(link.pathname + link.search + link.hash)
        if (changedPage) window.scrollTo(0, 0)
      }}
    />
  )
}
export function productUrl(id: string, back?: string) {
  return '/products/' + encodeURIComponent(id) + (back ? '?back=' + encodeURIComponent(back) : '')
}
export function researchUrl(id?: string) {
  return '/research' + (id ? '?product=' + encodeURIComponent(id) : '')
}
export function safeBack(value: string | null) {
  return value && /^\/(?:\?|$|(?:candidates|daily|potential)(?:\?|$))/.test(value) ? value : '/'
}
export const amount = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
export const money = (value: number | null | undefined, currency = 'USD') =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(value)
export const dollars = (micros: number | null | undefined) =>
  micros == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
      }).format(micros / 1e6)
export function date(value?: string | null, withTime = false) {
  if (!value) return '未记录'
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(d)
}
export function useAccess() {
  const s = useData<Session>('/session')
  return {
    session: s.data,
    admin: s.data?.role === 'admin',
    edit: ['admin', 'operator'].includes(s.data?.role || ''),
  }
}
export function PlatformInitial({id}:{id:string}) {
  const name = platforms[id] || id
  return <span className="platform-initial" data-platform={id} role="img" aria-label={'来源：'+name} title={name}>{name.charAt(0).toUpperCase()}</span>
}
export function Platform({ id }: { id: string }) {
  return (
    <span className={'platform ' + id}>
      <PlatformInitial id={id}/>
      {platforms[id] || id}
    </span>
  )
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={'badge ' + tone}>
      <i />
      {children}
    </span>
  )
}
export function StageBadge({ stage }: { stage: Stage | null }) {
  return (
    <Badge
      tone={
        stage === 'watch'
          ? 'blue'
          : stage === 'follow'
            ? 'teal'
            : stage === 'candidate'
              ? 'purple'
              : 'neutral'
      }
    >
      {stage ? stages[stage] : '待研究'}
    </Badge>
  )
}
export function Status({ status }: { status: string }) {
  return (
    <Badge
      tone={
        status === 'succeeded' || status === 'success'
          ? 'teal'
          : status === 'failed'
            ? 'red'
            : ['partial', 'paused'].includes(status)
              ? 'amber'
              : ['running', 'queued'].includes(status)
                ? 'blue'
                : 'neutral'
      }
    >
      {statusLabels[status] || status}
    </Badge>
  )
}
export function Thumb({ p, big = false }: { p: Pick<Product,'title'|'thumbnail'> & Partial<Pick<Product,'title_cn'>>; big?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return (
    <span className={'thumb' + (big ? ' big' : '')}>
      {p.thumbnail && failedUrl !== p.thumbnail ? (
        <img
          src={p.thumbnail}
          alt={big ? p.title_cn || p.title : ''}
          loading={big ? 'eager' : 'lazy'}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(p.thumbnail)}
        />
      ) : (
        <span className="thumb-fallback" title="图片未取得">
          <Box size={big ? 36 : 20} />
          {big && <small>图片未取得</small>}
        </span>
      )}
    </span>
  )
}
const phoneScreen = window.matchMedia('(max-width: 600px), (max-width: 980px) and (pointer: coarse)')
function subscribePhone(change: () => void) {
  phoneScreen.addEventListener('change', change)
  return () => phoneScreen.removeEventListener('change', change)
}
export function usePhoneScreen() {
  return useSyncExternalStore(subscribePhone, () => phoneScreen.matches)
}
export function Title({
  eyebrow,
  title,
  desc,
  children,
}: {
  eyebrow: string
  title: string
  desc: string
  children?: ReactNode
}) {
  return (
    <header className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  )
}
export function SearchForm({
  value,
  onSearch,
  placeholder = '商品名称、关键词或商品 ID',
  id,
}: {
  value: string
  onSearch: (value: string) => void
  placeholder?: string
  id?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <search className="search-field" aria-label={id === 'global-search' ? '全库搜索' : placeholder}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSearch(draft.trim())
        }}
      >
        <Search size={16} />
        <input
          id={id}
          aria-label={placeholder}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (e.target.value === '') onSearch('')
          }}
        />
        {draft ? (
          <button
            type="button"
            className="icon mini"
            aria-label="清空搜索"
            onClick={() => {
              setDraft('')
              onSearch('')
            }}
          >
            <X size={13} />
          </button>
        ) : (
          <kbd>↵</kbd>
        )}
      </form>
    </search>
  )
}
export function Empty({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <FileSearch size={32} strokeWidth={1.3} />
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  )
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={17} /> 正在读取数据…
    </div>
  )
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={15} />
      <span>{memberDiagnostic(error instanceof Error ? error.message : String(error))}</span>
      {retry && (
        <button type="button" className="linkbtn" onClick={retry}>
          重试
        </button>
      )}
    </div>
  )
}
export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return (
    <div className={'notice ' + (success ? 'success' : '')} role="status">
      {success ? <Check size={15} /> : <AlertCircle size={15} />}
      <span>{children}</span>
    </div>
  )
}
export function Panel({
  title,
  extra,
  children,
  className = '',
}: {
  title?: string
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={'panel ' + className}>
      {title && (
        <header className="panel-head">
          <h2>{title}</h2>
          {extra}
        </header>
      )}
      {children}
    </section>
  )
}
export function Pager({
  total,
  page,
  size,
  onPage,
  onSize,
}: {
  total: number
  page: number
  size: number
  onPage: (page: number) => void
  onSize: (size: number) => void
}) {
  const count = Math.max(1, Math.ceil(total / size))
  const visible = [1, page - 1, page, page + 1, count]
    .filter((n, i, a) => n > 0 && n <= count && a.indexOf(n) === i)
    .sort((a, b) => a - b)
  return (
    <div className="pager">
      <span>
        {total ? `${amount((page - 1) * size + 1)}–${amount(Math.min(total, page * size))}` : '0'}{' '}
        <span className="muted">/ {amount(total)} 条</span>
      </span>
      <div>
        <button
          type="button"
          className="icon"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </button>
        {visible.map((n, i) => (
          <span className="page-choice" key={n}>
            {i > 0 && n - visible[i - 1] > 1 && <small>…</small>}
            <button
              type="button"
              className={page === n ? 'current' : ''}
              aria-label={'第 ' + n + ' 页'}
              aria-current={page === n ? 'page' : undefined}
              onClick={() => onPage(n)}
            >
              {n}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="icon"
          aria-label="下一页"
          disabled={page >= count}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </button>
        <Select
          variant="compact"
          aria-label="每页数量"
          value={String(size)}
          onValueChange={(v) => onSize(Number(v))}
          options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: n + ' 条 / 页' }))}
        />
      </div>
    </div>
  )
}
export function Dialog({
  title,
  children,
  onClose,
  className,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    el?.showModal()
    return () => el?.close()
  }, [])
  return (
    <dialog
        className={className}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      aria-label={title}
      closedby="any"
    >
      <div className="dialog-inner">
        <div className="panel-head">
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>
}) {
  const generated = useId()
  const id = children.props.id ?? generated
  const description = [children.props['aria-describedby'], hint ? id + '-hint' : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': description || undefined })}
      {hint && <small id={id + '-hint'}>{hint}</small>}
    </div>
  )
}
export function Form({
  children,
  onSubmit,
  className = '',
}: {
  children: ReactNode
  onSubmit: () => void
  className?: string
}) {
  return (
    <form
      className={className}
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <PageLink className="back-link" href={href}>
      <ArrowLeft size={15} />
      {label}
    </PageLink>
  )
}
