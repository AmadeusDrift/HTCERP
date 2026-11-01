// Official defaults: 2, 0.5, 0.1 requests/s. Our US batch calls still saw 429 at 12.5s.
const intervals = { catalog: 625, offer: 2500, batch: 25000 } as const
const clock = "CAST(unixepoch('subsec')*1000 AS INTEGER)"
export type AmazonOperation = keyof typeof intervals
export function pacedOperation(url: URL | string): AmazonOperation | undefined {
  const path = new URL(url).pathname
  if (path === '/catalog/2022-04-01/items') return 'catalog'
  if (path === '/batches/products/pricing/v0/itemOffers') return 'batch'
  if (/^\/products\/pricing\/v0\/items\/[^/]+\/offers$/.test(path)) return 'offer'
}
// API and job Workers share this D1 database and the same US selling account.
// Claim only when due; concurrent workers and previously sleeping callers must recheck the gate.
export async function acquireSlot(db: D1Database, op: AmazonOperation) {
  const minimum = intervals[op]
  for (;;) {
    const grant = await db.prepare(`INSERT INTO amazon_request_pacing(operation,next_at,interval_ms)
      VALUES(?,${clock}+?,?) ON CONFLICT(operation) DO UPDATE SET next_at=${clock}+MAX(?,interval_ms)*
      CASE WHEN slow_until>${clock} THEN 2 ELSE 1 END WHERE next_at<=${clock} RETURNING next_at`)
      .bind(op,minimum,minimum,minimum).first()
    if (grant) return
    const row = await db.prepare(`SELECT next_at-${clock} AS remaining FROM amazon_request_pacing WHERE operation=?`)
      .bind(op).first<{remaining:number}>()
    await new Promise(resolve=>setTimeout(resolve,Math.max(25,row?.remaining ?? 0)))
  }
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
