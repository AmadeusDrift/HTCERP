import type { AmazonComparison } from '../../../packages/amazon/auto-compare'
import type { Position } from '../../../packages/contracts/accounts'

export const selectionLabels = {
  recommend: '推荐跟进',
  pass: '暂不推荐',
  insufficient: '证据不足',
}

export type Stage = 'candidate' | 'watch' | 'follow' | 'hold' | 'reject'
export const stages: Record<Stage, string> = {
  candidate: '候选',
  watch: '观察',
  follow: '跟进',
  hold: '暂缓',
  reject: '不适合',
}
export const lines: Record<string, string> = { standard: '标品', pod: '差异化 / POD' }
export const platforms: Record<string, string> = {
  amazon: 'Amazon',
  temu: 'Temu',
  shein: 'SHEIN',
  tiktok: 'TikTok Shop',
  aliexpress: 'AliExpress',
}
export const tierNames: Record<string, string> = {
  '50k': '至少 5 万',
  '30k': '至少 3 万，不足 5 万',
  '10k': '至少 1 万，不足 3 万',
  below: '不足 1 万',
  missing: '累计销量缺失',
}
export const runModeLabels = { cache: '使用已有资料', live: '获取最新资料' }

const modelLabels: Record<string, string> = {
  'openai/gpt-6.1-terra': 'OpenAI ChatGPT 6.1 Terra',
  'openai/gpt-6-luna-decisions': 'OpenAI ChatGPT 6 Luna Decisions',
}
export function modelLabel(id?: string) {
  return id ? (modelLabels[id] ?? id) : '待载入'
}

export const roles: Record<string, string> = {
  admin: '管理员',
  operator: '运营',
  viewer: '只读',
  readonly: '只读',
}
export const positionLabels: Record<Position, string> = {
  product_lead: '开发主管',
  general_manager: '总经理',
  operations_lead: '运营主管',
  operations_assistant: '运营助理',
  amazon_operator: '亚马逊运营',
}
export interface Session {
  id: string
  username: string
  email: string
  role: 'admin' | 'operator' | 'viewer'
  position?: Position | null
  local: boolean
}
export interface Account {
  id: string
  username: string
  role: Session['role']
  position?: Position | null
  active: boolean
}
export interface Product {
  id: string
  platform: string
  market: string
  external_id: string
  title: string
  title_cn: string | null
  thumbnail: string | null
  source_url?: string | null
  category_id: string | null
  category_name: string | null
  category_path: string | null
  min_price: number | null
  currency: string | null
  total_sold: number | null
  day_sold: number | null
  week_sold: number | null
  month_sold: number | null
  rating: number | null
  review_count: number | null
  shop_id: string | null
  updated_at: string | null
  fetched_at: string | null
  stage: Stage | null
  lines: string[]
  note: string | null
  updated_by: string | null
  feedback_at: string | null
}
export interface Meta {
  total: number
  platforms: { platform: string; count: number }[]
  categories: { value: string; label: string; platform: string | null }[]
  tiers: { tier: string; count: number }[]
  historyProducts: number
  candidates: number
  latestUpdatedAt: string | null
  latestFetchedAt: string | null
}
export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
export interface Observation {
  observed_at?: string | null
  updated_at?: string | null
  min_price: number | null
  total_sold: number | null
  day_sold: number | null
  week_sold: number | null
  month_sold: number | null
}
export interface Detail {
  product: Product
  history: Observation[]
  snapshots: Observation[]
  variants: { sku_id: string; specs: { specKey: string; specValue: string }[] }[]
  feedback: { stage: Stage; lines: string[]; note: string; author: string; created_at: string }[]
}
export interface Match {
  searchId: string
  asin: string
  title: string
  price: number | null
  currency: string | null
  rank: number | null
  rankCategory?: string | null
  specs: unknown
  method: string
  status: 'confirmed' | 'rejected' | 'pending'
  note: string | null
  fetchedAt: string
  reviewer?: string
  reviewedAt?: string | null
  priceStatus?: string
  priceFetchedAt?: string
  shipping?: number | null
}
export interface AmazonPanel {
  automation?: { runId: string; comparison: AmazonComparison | null; canBackfill: boolean } | null
  matches: Match[]
  searches: {
    id: string
    status: string
    query: string
    returned: number | null
    hasMore: boolean
    fetchedAt: string
  }[]
  configured: boolean
}
export interface GeekSlot {
  slot: number
  configured: boolean
  binding?: 'bound' | 'locked' | 'incomplete' | 'empty'
  balanceRefused?: boolean
  testStatus?: 'verified' | 'failed' | null
  lastTestedAt?: string | null
  confirmedPoints?: number
  pendingPoints?: number
}
export interface Connections {
  credentialEditing: boolean
  productData?: { configured: boolean }
  geekbi?: { configured: boolean; slots?: GeekSlot[] }
  openrouter: { configured: boolean }
  amazon: { sellerId?: string | null; configured: boolean; status: string; lastTestedAt?: string | null }
  haul: { configured: boolean }
}
export interface Settings {
  platform: string
  market: string
  categoryId: string
  keyword: string
  maxPrice: number | null
  tiers: number[]
  pageLimit: number
  focusLimit: number
  researchLimit: number
  dataDailyPoints: number
  aiDailyMicros: number
  schedulePreset?: 'potential' | 'custom'
  scheduleEnabled: boolean
  scheduleTime: string
}
export function strategyCatalogFilters(settings: Settings) {
  const next = new URLSearchParams({ sort: 'total_sold', order: 'desc' })
  if (settings.platform) next.set('platform', settings.platform)
  if (settings.categoryId)
    next.set(
      'category',
      settings.categoryId === 'home' ? 'home' : settings.platform + ':' + settings.categoryId,
    )
  if (settings.keyword) next.set('q', settings.keyword)
  if (settings.maxPrice != null) next.set('maxPrice', String(settings.maxPrice))
  if (settings.tiers?.length) next.set('minSold', String(Math.min(...settings.tiers)))
  return next
}

export interface Strategy {
  version: number
  settings: Settings
  usage: Usage
  capabilities?: { discovery: boolean; research: boolean }
  connections?: { productData?: boolean; geekbi?: boolean; openrouter: boolean }
  models?: { research: string; decision: string }
}
export interface Usage {
  dataPoints: number
  aiMicros: number
  unconfirmedDataPoints?: number
  unconfirmedAiMicros?: number
}
export type JobKind = 'discovery' | 'research'
export interface JobInputs {
  imageId?: string
  goal?: string
  productId?: string
  keyword?: string
  platform?: string
  categoryId?: string
  maxPrice?: number | null
  tiers?: number[]
  mode?: 'live' | 'cache'
  pageLimit?: number
  maxDataPoints?: number
  maxAiMicros?: number
}
export interface Job {
  scheduled?: boolean
  id: string
  kind: JobKind
  status: string
  title: string
  createdAt: string
  updatedAt: string
  actor: string
  strategyVersion: number
  inputs: JobInputs
  summary: string
  usage?: Usage
  steps?: {
    key: string
    title: string
    status: string
    summary: string
    result: unknown
    evidenceRef: string | null
    updatedAt: string
  }[]
}
export const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  pausing: '正在暂停',
  paused: '已暂停',
  cancelling: '正在取消',
  cancelled: '已取消',
  succeeded: '已完成',
  success: '已完成',
  partial: '部分完成',
  failed: '失败',
  skipped: '已跳过',
  pending: '待执行',
  retryable_failure: '可重试',
  permanent_failure: '失败',
}
