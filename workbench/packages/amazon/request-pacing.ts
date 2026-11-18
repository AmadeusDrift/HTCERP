import { PublicError } from '../contracts/errors'

// Official defaults: 2, 0.5, 0.1 requests/s. Our US batch calls still saw 429 at 12.5s.
const intervals = { catalog: 625, offer: 2500, batch: 25000, feedback: 1250, listings: 300,
  'sales-read': 2500, 'listing-read': 300, 'listing-write': 500 } as const
const clock = "CAST(unixepoch('subsec')*1000 AS INTEGER)"
export type AmazonOperation = keyof typeof intervals
export function pacedOperation(url: URL | string, partner = false): AmazonOperation | undefined {
  const path = new URL(url).pathname
  if (path === '/catalog/2022-04-01/items') return 'catalog'
  if (/^\/listings\/2021-08-01\/items\/[^/]+$/.test(path)) return 'listings'
  if (partner && /^\/listings\/2021-08-01\/items\/[^/]+\/[^/]+$/.test(path)) return 'listing-read'
  if (path === '/sales/v1/orderMetrics') return 'sales-read'
  if (path === '/batches/products/pricing/v0/itemOffers') return 'batch'
  if (/^\/products\/pricing\/v0\/items\/[^/]+\/offers$/.test(path)) return 'offer'
}
// API and job Workers share this D1 database and the same US selling account.
// Claim only when due; concurrent workers and previously sleeping callers must recheck the gate.
export async function acquireSlot(db: D1Database, op: AmazonOperation, maxWaitMs?: number) {
  const minimum = intervals[op]
  const deadline = maxWaitMs === undefined ? Infinity : Date.now() + maxWaitMs
  for (;;) {
    const grant = await db.prepare(`INSERT INTO amazon_request_pacing(operation,next_at,interval_ms)
      VALUES(?,${clock}+?,?) ON CONFLICT(operation) DO UPDATE SET next_at=${clock}+MAX(?,interval_ms)*
      CASE WHEN slow_until>${clock} THEN 2 ELSE 1 END WHERE next_at<=${clock} RETURNING next_at`)
      .bind(op,minimum,minimum,minimum).first()
    if (grant) return
    const row = await db.prepare(`SELECT next_at-${clock} AS remaining FROM amazon_request_pacing WHERE operation=?`)
      .bind(op).first<{remaining:number}>()
    const delay = Math.max(25,row?.remaining ?? 0)
    if (Date.now() + delay > deadline) throw new PublicError('SOURCE_THROTTLED','Amazon 配额暂时忙，请稍后重试。',429,'amazon',true,Math.max(1,Math.ceil(delay/1000)))
    await new Promise(resolve=>setTimeout(resolve,delay))
  }
}

export async function acquirePartnerOrders(db: D1Database, performance = false) {
  // The default rate is one request per ~3 minutes with a burst of 20.
  // Reserve part of the burst for the ERP's existing background jobs.
  const now = Date.now()
  // Protect one replenished token only while the performance reader has made
  // no progress for 30 seconds. Other readers share the same unchanged budget
  // and regain the full pool as soon as that reader advances or finishes.
  const waiting = !performance && await db.prepare(`SELECT 1 FROM performance_sync_runs
    WHERE status IN ('queued','running') AND updated_at<=? LIMIT 1`)
    .bind(new Date(now - 30000).toISOString()).first()
  const required = waiting ? 2 : 1
  const reserved = await db.prepare(`INSERT INTO partner_orders_budget VALUES(1,11,0.0056,?,0)
    ON CONFLICT(singleton) DO UPDATE SET tokens=MIN(12,tokens+MAX(0,?-updated_at)*rate/1000)-1,updated_at=?
    WHERE blocked_until<=? AND MIN(12,tokens+MAX(0,?-updated_at)*rate/1000)>=? RETURNING tokens`)
    .bind(now,now,now,now,now,required).first()
  if (!reserved) {
    const state = await db.prepare('SELECT tokens,rate,updated_at,blocked_until FROM partner_orders_budget WHERE singleton=1')
      .first<{tokens:number;rate:number;updated_at:number;blocked_until:number}>()
    const remaining = state ? Math.max(state.blocked_until-now, (required-state.tokens)*1000/state.rate - (now-state.updated_at)) : 180000
    throw new PublicError('SOURCE_THROTTLED','Haul 订单读取配额已用尽，请稍后重试。',429,'amazon',true,Math.max(1,Math.ceil(remaining/1000)))
  }
}

export function amazonRetrySeconds(headers: Headers, fallback: number) {
  const value = headers.get('retry-after')?.trim()
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value)
    if (Number.isSafeInteger(seconds) && seconds <= 31_536_000) return Math.max(1,seconds)
  }
  const date = value ? Date.parse(value) : NaN
  return Number.isFinite(date) ? Math.max(1,Math.ceil((date-Date.now())/1000)) : fallback
}

export async function observePartnerOrders(db: D1Database, response: Response) {
  const rate = Number(response.headers.get('x-amzn-ratelimit-limit'))
  const knownRate = Number.isFinite(rate) && rate > 0 ? rate : 0
  if (!knownRate && response.status !== 429) return
  const now = Date.now()
  const wait = response.status === 429 ? amazonRetrySeconds(response.headers,60)*1000 : 0
  await db.prepare(`UPDATE partner_orders_budget SET
    tokens=MIN(12,tokens+MAX(0,?-updated_at)*rate/1000),updated_at=?,
    rate=CASE WHEN ?>0 THEN MIN(?,2) ELSE rate END,blocked_until=MAX(blocked_until,?) WHERE singleton=1`)
    .bind(now,now,knownRate,knownRate,now+wait).run()
}
export async function observeLimit(db:D1Database,op:AmazonOperation,headers:Headers,throttled:boolean){
  const rate=Number(headers.get('x-amzn-ratelimit-limit'))
  const interval=Number.isFinite(rate)&&rate>0 ? Math.max(intervals[op], Math.ceil(1250/rate)) : null
  if (!throttled && interval===null) return
  const now=Date.now(),retry=headers.get('retry-after')
  const retryMs=retry && /^\d+(?:\.\d+)?$/.test(retry)? Number(retry)*1000 : Math.max(0,(Date.parse(retry??'')||now)-now)
  await db.prepare(`UPDATE amazon_request_pacing SET interval_ms=COALESCE(?,interval_ms),
    slow_until=MAX(slow_until,?), next_at=MAX(next_at,?+MAX(?,COALESCE(?,interval_ms)*
    CASE WHEN MAX(slow_until,?)>? THEN 2 ELSE 1 END)) WHERE operation=?`)
    .bind(interval,throttled?now+600000:0,now,retryMs,interval,throttled?now+600000:0,now,op).run()
}
