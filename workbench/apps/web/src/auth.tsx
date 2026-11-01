import { ArrowRight, LogOut } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Brand } from './brand'
import { roles, type Session } from './models'
import { isSignedOut, loginPath, returnPath } from './session'
import { Dialog, ErrorBox, Field, Loading, Notice, request, useData, useLocation } from './ui'

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand brand">
          <Brand />
        </div>
        <div className="auth-body">{children}</div>
      </section>
    </main>
  )
}

function Login({ next, expired }: { next: string; expired: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      await request<Session>('/auth/login', {
        username: String(data.get('username')).trim(),
        password: data.get('password'),
      })
      window.location.replace(next)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <AuthFrame>
      <h1>登录工作台</h1>
      <p className="auth-intro">使用管理员分配的账号继续。</p>
      <form className="auth-form" onSubmit={signIn}>
        {expired && <Notice>登录已过期，请重新登录。</Notice>}
        <Field label="账号">
          <input
            name="username"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="输入工作台账号"
            maxLength={40}
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            placeholder="输入密码"
            maxLength={128}
          />
        </Field>
        <ErrorBox error={error} />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'} <ArrowRight aria-hidden="true" />
        </button>
      </form>
      <p className="auth-foot">需要开通账号或重置密码？请联系管理员。</p>
    </AuthFrame>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { path, params } = useLocation()
  const s = useData<Session>('/session')
  const login = path === '/login' || path === '/login/'
  const next = returnPath(params.get('next'))
  const signedOut = isSignedOut(s.error)
  const target = signedOut && !login ? loginPath(!!s.data) : s.isSuccess && login ? next : null
  useEffect(() => {
    if (target) window.location.replace(target)
    if (login) document.title = '登录 · 海天城ERP'
  }, [target, login])
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload()
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])
  if (s.isPending || target)
    return (
      <AuthFrame>
        <Loading />
      </AuthFrame>
    )
  if (signedOut) return <Login next={next} expired={params.get('expired') === '1'} />
  if (s.isError)
    return (
      <AuthFrame>
        <h1>工作台访问</h1>
        <ErrorBox error="暂时无法验证登录状态，请重试。" retry={() => void s.refetch()} />
      </AuthFrame>
    )
  return <>{children}</>
}

export function SignOut({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function signOut() {
    setBusy(true)
    try {
      await request('/auth/logout', {})
      window.location.replace('/login')
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="icon"
        aria-label="退出登录"
        title={session.username + ' · ' + roles[session.role] + ' · 退出登录'}
        disabled={busy}
        onClick={signOut}
      >
        <LogOut />
      </button>
      {!!error && (
        <Dialog title="退出登录失败" onClose={() => setError(null)}>
          <div className="dialog-body">
            <ErrorBox error={error} retry={() => void signOut()} />
          </div>
        </Dialog>
      )}
    </>
  )
}
