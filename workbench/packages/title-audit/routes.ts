import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { launchAudit } from './jobs'
import { buildTitleAuditInspector, version } from './context-review'
import { customTerms, searchTerms } from './catalog'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials } from '../connections/credentials'

export const titleAudit = new Hono<AppEnv>()
titleAudit.post('/export-images', async c => {
  const { run, asins } = z.object({ run: z.string().max(128), asins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(20) }).parse(await c.req.json())
  const found = await c.env.DB.prepare(
    'SELECT DISTINCT asin FROM title_audit_rows WHERE run=? AND asin IN (SELECT value FROM json_each(?)) AND run IN (SELECT id FROM title_audit_runs WHERE seller=(SELECT seller FROM title_audit_store WHERE singleton=1))',
  ).bind(run, JSON.stringify(asins)).all<{asin:string}>()
  if (!found.results.length) return c.json({})
  const { credentials } = await providerCredentials(c.env, 'amazon')
  const images = await new AmazonUS(credentials, undefined, c.env.DB).mainImages(found.results.map(x => x.asin))
  const result: Record<string,string> = {}
  await Promise.all(images.map(async ({ asin, url }) => {
    try {
      const link = new URL(url)
      if (link.protocol !== 'https:' || !['m.media-amazon.com','images-na.ssl-images-amazon.com','images.amazon.com'].includes(link.hostname)) return
      if (!/^\/images\/I\/[\w%+-]+(?:\._[^/]+_)?\.jpg$/i.test(link.pathname)) return
      link.pathname = link.pathname.replace(/(?:\._[^/]+_)?\.jpg$/i, '._SL120_.jpg')
      const response = await fetch(link, { redirect:'error', signal:AbortSignal.timeout(8000) })
      if (!response.ok || !response.headers.get('content-type')?.includes('image/jpeg')) return
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.length || bytes.length > 100000) return
      result[asin] = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
    } catch { /* Missing or inaccessible images leave the individual row available for export. */ }
  }))
  return c.json(result)
})
titleAudit.get('/terms', async (c) => {
  const q = c.req.query()
  return c.json(
    searchTerms(
      q.q ?? '',
      q.source ?? '',
      Math.max(0, parseInt(q.page) || 0),
      await customTerms(c.env.DB),
      q.family ?? '',
    ),
  )
})
titleAudit.post('/terms', async (c) => {
  const word = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/[\p{L}\p{N}]/u)
  const p = z
    .object({
      name: word,
      family: z.string().trim().max(120),
      aliases: z.array(word).max(20),
      reason: z.string().trim().min(1).max(300),
    })
    .safeParse(await c.req.json())
  if (!p.success) throw new PublicError('INVALID_INPUT', '请填写名称及提醒原因，别名最多 20 个。', 400)
  const { name, family, aliases, reason } = p.data
  const added = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO title_audit_terms(name,name_key,family,aliases,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(
      name,
      name.normalize('NFKC').toLowerCase(),
      family,
      JSON.stringify([...new Set(aliases)]),
      reason,
      c.var.actor.id,
      new Date().toISOString(),
    )
    .run()
  if (!added.meta.changes) throw new PublicError('CONFLICT', '这个运营风险词已存在。', 409)
  return c.json({ ok: true })
})
titleAudit.post('/preview', async (c) => {
  const p = z.object({ title: z.string().trim().min(1).max(1000) }).safeParse(await c.req.json())
  if (!p.success) throw new PublicError('INVALID_INPUT', '请输入 1–1000 字符的标题。', 400)
  return c.json(buildTitleAuditInspector(await customTerms(c.env.DB))(p.data.title))
})
titleAudit.post('/store', async (c) => {
  const p = z
    .object({
      seller: z
        .string()
        .trim()
        .regex(/^[A-Z0-9]{5,64}$/),
      enabled: z.boolean(),
    })
    .safeParse(await c.req.json())
  if (!p.success) throw new PublicError('INVALID_INPUT', '请填写有效的 Seller ID。', 400)
  await c.env.DB.prepare('INSERT OR REPLACE INTO title_audit_store VALUES(1,?,?)')
    .bind(p.data.seller, +p.data.enabled)
    .run()
  return c.json({ ok: true })
})
titleAudit.post('/schedule', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可配置巡检。', 403)
  const p = z.object({ enabled: z.boolean() }).safeParse(await c.req.json())
  if (!p.success) throw new PublicError('INVALID_INPUT', '请选择巡检开关。', 400)
  const updated = await c.env.DB.prepare('UPDATE title_audit_store SET enabled=? WHERE singleton=1').bind(+p.data.enabled).run()
  if (!updated.meta.changes) throw new PublicError('INVALID_INPUT', '请先在 Amazon SP-API 数据连接中保存 Seller ID。', 409)
  return c.json({ ok: true })
})
titleAudit.post('/run', async (c) => {
  const store = await c.env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{
    seller: string
  }>()
  if (!store) throw new PublicError('INVALID_INPUT', '请先配置美国站 Seller ID。', 409)
  await launchAudit(c.env, store.seller)
  return c.json({ ok: true })
})
titleAudit.get('/results', async (c) => {
  const db = c.env.DB,
    q = c.req.query()
  const store = await db
    .prepare('SELECT seller,enabled FROM title_audit_store WHERE singleton=1')
    .first<{ seller: string; enabled: number }>()
  const seller = store?.seller ?? ''
  const scope = q.scope === 'haul' ? 'haul' : 'full'
  const last = await db
    .prepare(
      'SELECT id,status,started,finished,error FROM title_audit_runs WHERE seller=? AND scope=? ORDER BY started DESC,id DESC LIMIT 1',
    )
    .bind(seller, scope)
    .first()
  const complete = await db
    .prepare(
      "SELECT id,finished,status,error,version,window_start_ms,window_end_ms FROM title_audit_runs WHERE seller=? AND scope=? AND status IN ('done','partial') AND (?='' OR id=?) ORDER BY started DESC,id DESC LIMIT 1",
    )
    .bind(seller, scope, q.run ?? '', q.run ?? '')
    .first<{ id: string; finished: string; version: string }>()
  const runs = scope === 'haul'
    ? await db.prepare(`SELECT id,window_start_ms,window_end_ms,status FROM title_audit_runs
      WHERE seller=? AND scope='haul' AND status IN ('done','partial')
      ORDER BY window_end_ms DESC,id DESC LIMIT 336`).bind(seller).all()
    : null
  const run = complete?.id ?? '',
    where = ['run=?'],
    args: string[] = [run]
  if (q.result === '风险') where.push("verdict IN ('建议改写','重点提醒')")
  else if (q.result) {
    where.push('verdict=?')
    args.push(q.result)
  }
  if (q.state) {
    where.push('disposition=?')
    args.push(q.state)
  }
  if (q.q) {
    where.push("instr(lower(sku||' '||coalesce(asin,'')||' '||title),lower(?))>0")
    args.push(q.q)
  }
  if (q.term || q.family) {
    where.push(
      "EXISTS(SELECT 1 FROM json_each(hits) h WHERE (?='' OR instr(lower(json_extract(h.value,'$.term')),lower(?))>0 OR instr(lower(json_extract(h.value,'$.names')),lower(?))>0) AND (?='' OR EXISTS(SELECT 1 FROM json_each(h.value,'$.families') f WHERE instr(lower(f.value),lower(?))>0)))",
    )
    args.push(q.term ?? '', q.term ?? '', q.term ?? '', q.family ?? '', q.family ?? '')
  }
  const filter = where.join(' AND '),
    page = Math.max(0, Math.min(1000000, Number.parseInt(q.page ?? '0') || 0))
  const [counts, total, rows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT verdict,count(*) n FROM title_audit_rows WHERE run=? GROUP BY verdict').bind(run),
    db.prepare('SELECT count(*) n FROM title_audit_rows WHERE ' + filter).bind(...args),
    db
      .prepare(
        'SELECT sku,asin,title,verdict,disposition,evidence,hits FROM title_audit_rows WHERE ' +
          filter +
          " ORDER BY CASE verdict WHEN '重点提醒' THEN 0 WHEN '建议改写' THEN 1 WHEN '冲突' THEN 2 WHEN '低优先级' THEN 3 ELSE 4 END,sku LIMIT 50 OFFSET ?",
      )
      .bind(...args, page * 50),
  ])
  return c.json({
    store,
    last,
    complete,
    ...(runs && { runs: runs.results }),
    version: complete?.version ?? version,
    counts: counts.results,
    total: total.results[0]?.n ?? 0,
    rows: rows.results.map((r) => ({ ...r, hits: JSON.parse(String(r.hits)) })),
  })
})
