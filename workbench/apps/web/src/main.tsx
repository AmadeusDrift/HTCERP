import '@fontsource-variable/inter/standard.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import {
  Bookmark,
  BriefcaseBusiness,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Compass,
  FlaskConical,
  House,
  ListChecks,
  Menu,
  Settings2,
  Table2,
  UserRound,
} from 'lucide-react'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OperationsAssistant } from './assistant'
import { AuthGate, SignOut } from './auth'
import { Brand } from './brand'
import { Candidates, Discovery } from './catalog'
import { Daily } from './daily'
import { ProductDetail } from './detail'
import { MarketClocks } from './market-clocks'
import { roles, type Session } from './models'
import { Potential } from './potential'
import { Research } from './research'
import { Settings } from './settings'
import { StoreHome, StorePerformance } from './store-sales'
import { Tasks } from './tasks'
import { Dialog, Empty, PageLink, SearchForm, useData, useGo, useLocation } from './ui'
import './styles.css'
import './store-sales.css'

const nav = [
  { url: '/', name: '发现商品', icon: Compass },
  { url: '/potential', name: '潜力新品', icon: ListChecks },
  { url: '/research', name: 'AI 研究台', icon: FlaskConical },
  { url: '/candidates', name: '候选与观察池', icon: Bookmark },
  { url: '/daily', name: '选品日报', icon: CalendarDays },
  { url: '/tasks', name: '任务中心', icon: ListChecks },
]
const homeItem = { url: '/home', name: '首页', icon: House }
const performanceItem = { url: '/performance', name: '业绩表', icon: Table2 }
const settingsItem = { url: '/settings', name: '设置', icon: Settings2 }
function Shell() {
  const { path } = useLocation(),
    go = useGo(),
    [open, setOpen] = useState(false),
    [selectionOpen, setSelectionOpen] = useState(true),
    [help, setHelp] = useState(false),
    s = useData<Session>('/session')
  const current = [homeItem, ...nav, performanceItem, settingsItem].find((n) => n.url === path) || nav[0]
  function navLink(item: (typeof nav)[number]) {
    const active = current.url === item.url
    return (
      <PageLink
        href={item.url}
        onClick={() => setOpen(false)}
        className={active ? 'active' : ''}
        aria-current={active ? 'page' : undefined}
        key={item.url}
      >
        <item.icon />
        {item.name}
        {active && <span />}
      </PageLink>
    )
  }
  useEffect(() => {
    setOpen(false)
    document.title = (path.startsWith('/products/') ? '商品详情' : current.name) + ' · 海天城ERP'
  }, [current.name, path])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        document.getElementById('global-search')?.focus()
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      {open && (
        <button type="button" className="scrim" aria-label="关闭导航" onClick={() => setOpen(false)} />
      )}
      <aside className={'sidebar ' + (open ? 'open' : '')}>
        <PageLink className="brand" href="/home">
          <Brand />
        </PageLink>
        <div className="module-nav">
          <nav aria-label="首页">{navLink(homeItem)}</nav>
          <button
            type="button"
            className="nav-group"
            aria-expanded={selectionOpen}
            aria-controls="selection-nav"
            onClick={() => setSelectionOpen(!selectionOpen)}
          >
            <BriefcaseBusiness size={17} />
            选品工作台 <ChevronRight size={15} />
          </button>
          <nav id="selection-nav" aria-label="选品工作台" hidden={!selectionOpen}>
            {nav.map(navLink)}
          </nav>
          <nav aria-label="业绩与设置">{[performanceItem, settingsItem].map(navLink)}</nav>
        </div>
        <div className="side-bottom">
          <PageLink
            className="user-block"
            href="/settings?tab=personal"
            onClick={() => setOpen(false)}
            title="个人设置"
          >
            <div className="avatar">
              <UserRound />
            </div>
            <div>
              <b>{roles[s.data?.role || ''] || '工作台账户'}</b>
              <small>{s.data?.username || s.data?.email}</small>
            </div>
            <ChevronRight size={16} />
          </PageLink>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="mobile-menu icon"
            onClick={() => setOpen(!open)}
            aria-label="打开导航"
            aria-expanded={open}
          >
            <Menu />
          </button>
          <div className="market">
            <span className="us-flag" aria-hidden="true" />
            <b>美国站</b>
            <span>US</span>
          </div>
          <div className="top-rule" />
          <SearchForm
            id="global-search"
            value=""
            placeholder="搜索全库商品、关键词或商品 ID"
            onSearch={(q) => go(q ? '/?q=' + encodeURIComponent(q) : '/')}
          />
          <kbd className="shortcut">Ctrl K</kbd>
          <div className="top-end">
            <MarketClocks />
            <button
              type="button"
              className="icon"
              aria-label="工作台说明"
              title="工作台说明"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={17} />
            </button>
            {s.data && !s.data.local && <SignOut session={s.data} />}
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {s.data && (
        <OperationsAssistant key={s.data.id + path} page={current.name} path={path} session={s.data} />
      )}
      {help && (
        <Dialog title="关于海天城ERP" onClose={() => setHelp(false)}>
          <div className="dialog-body stack">
            <p>在发现商品页筛选美国站商品，核对详情、历史与来源，再将值得跟进的商品加入候选池。</p>
            <p>研究台可使用缓存生成计划。执行记录、预算和证据都可以在任务中心查看。</p>
            <PageLink className="btn" href="/settings" onClick={() => setHelp(false)}>
              <Settings2 />
              {s.data?.role === 'admin' ? '查看连接与预算' : '查看调度与预算'}
            </PageLink>
          </div>
        </Dialog>
      )}
    </div>
  )
}
const rootRoute = createRootRoute({
  component: () => (
    <AuthGate>
      <Shell />
    </AuthGate>
  ),
  notFoundComponent: () => (
    <Empty title="没有找到这个页面">
      <PageLink className="btn" href="/">
        返回商品库
      </PageLink>
    </Empty>
  ),
})
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Discovery })
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login' })
const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/products/$id',
  component: ProductRoute,
})
function ProductRoute() {
  const { id } = detailRoute.useParams()
  return <ProductDetail key={id} id={id} />
}
const researchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/research',
  component: Research,
})
const candidatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/candidates',
  component: Candidates,
})
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tasks', component: Tasks })
const dailyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/daily', component: Daily })
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
})
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    createRoute({ getParentRoute: () => rootRoute, path: '/home', component: StoreHome }),
    createRoute({ getParentRoute: () => rootRoute, path: '/performance', component: StorePerformance }),
    loginRoute,
    detailRoute,
    researchRoute,
    candidatesRoute,
    createRoute({ getParentRoute: () => rootRoute, path: '/potential', component: Potential }),
    dailyRoute,
    tasksRoute,
    settingsRoute,
  ]),
  parseSearch: (s) => Object.fromEntries(new URLSearchParams(s)),
  stringifySearch: (v) => {
    const s = new URLSearchParams(Object.entries(v).map(([k, x]) => [k, String(x)])).toString()
    return s ? '?' + s : ''
  },
})
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 10000, refetchOnWindowFocus: false } },
})
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
