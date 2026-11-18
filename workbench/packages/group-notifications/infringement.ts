import type { WorkflowStep } from 'cloudflare:workers'
import type { z } from 'zod'
import { AmazonUS } from '../amazon/adapter'
import { providerCredentials, type ConnectionBindings } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import type { OpsBindings } from '../operations/model'
import { customTerms } from '../title-audit/catalog'
import { type auditPage, market } from '../title-audit/listings'
import { buildInspector } from '../title-audit/rules'
import { safeImage } from '../weekly-feedback/model'
import { feedbackOwnerRules, matchFeedbackOwner } from '../weekly-feedback/owner-rules'
import { batchInfringementMessages, enqueueDelivery, infringementMessage, infringementText } from './delivery'
import { type GroupNotificationBindings, groupMembers, serviceGroup } from './model'

type Listing = z.infer<typeof auditPage>['items'][number]
const ipReason =
  /\b(?:trademark|copyright|intellectual property|patent infringement|counterfeit)\b|商标|著作权|知识产权|专利侵权|假冒/i
const listingSearchLimit = 1000

function scanStart(env: Pick<GroupNotificationBindings, 'INFRINGEMENT_SCAN_START'>) {
  const value = env.INFRINGEMENT_SCAN_START
  if (value === undefined) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid INFRINGEMENT_SCAN_START')
  return timestamp
}

export async function recordInfringements(
  db: D1Database,
  seller: string,
  listings: Listing[],
  observed: string,
  lease?: string,
  historical = false,
) {
  const statements = listings.map((item) => {
    const summary = item.summaries?.find((entry) => entry.marketplaceId === market)
    const issues = (item.issues ?? []).filter(
      (issue) =>
        (!issue.marketplaceIds || issue.marketplaceIds.includes(market)) &&
        (issue.code === '18146' || ipReason.test(issue.message)),
    )
    const codes = issues.map((issue) =>
      JSON.stringify([
        issue.code,
        issue.message,
        [...new Set(issue.enforcements?.actions.map((entry) => entry.action))].sort(),
        issue.enforcements?.exemption?.status ?? null,
        issue.enforcements?.exemption?.expiryDate ?? null,
      ]),
    )
    const fingerprint = JSON.stringify([...new Set(codes)].sort())
    const issueDetails = issues.map(({ message, attributeNames }) => ({
      message,
      attributeNames: [...new Set((attributeNames ?? []).map((name) => name.trim()).filter(Boolean))].sort(),
    }))
    return db
      .prepare(`INSERT INTO notification_infringements
      (seller,sku,asin,title,image,listed_at,fingerprint,issue_details,changed_at,revision)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (?<>'[]' OR EXISTS(SELECT 1 FROM notification_infringements WHERE seller=? AND sku=?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM notification_infringement_scan WHERE seller=? AND lease=?))
      ON CONFLICT(seller,sku) DO ${historical ? 'NOTHING' : `UPDATE SET
        asin=coalesce(excluded.asin,asin),image=CASE WHEN excluded.asin<>asin THEN excluded.image ELSE coalesce(excluded.image,image) END,
        title=CASE WHEN excluded.asin IS NOT NULL AND excluded.asin IS NOT asin THEN excluded.title ELSE coalesce(excluded.title,title) END,
        listed_at=coalesce(excluded.listed_at,listed_at),fingerprint=excluded.fingerprint,issue_details=excluded.issue_details,
        changed_at=CASE WHEN fingerprint<>excluded.fingerprint THEN excluded.changed_at ELSE changed_at END,
        revision=CASE WHEN excluded.fingerprint<>'[]' AND (
          (excluded.asin IS NOT NULL AND asin IS NOT NULL AND excluded.asin<>asin)
          OR EXISTS(
            SELECT 1 FROM json_each(excluded.fingerprint) AS incoming
            WHERE NOT EXISTS(
              SELECT 1 FROM json_each(notification_infringements.fingerprint) AS previous
              WHERE json_extract(previous.value,'$[0]')=json_extract(incoming.value,'$[0]')
                AND json_extract(previous.value,'$[1]')=json_extract(incoming.value,'$[1]')
            )
          )
        ) THEN excluded.revision ELSE revision END
      WHERE excluded.changed_at>=notification_infringements.changed_at`}`)
      .bind(
        seller,
        item.sku,
        summary?.asin ?? null,
        summary?.itemName?.trim() || null,
        safeImage(summary?.mainImage?.link),
        summary?.lastUpdatedDate ?? null,
        fingerprint,
        JSON.stringify(issueDetails),
        observed,
        (historical ? 'history:' : '') + crypto.randomUUID(),
        fingerprint,
        seller,
        item.sku,
        lease ?? null,
        seller,
        lease ?? null,
      )
  })
  if (statements.length) return db.batch(statements)
  return []
}

export async function archiveInfringementHistory(env: OpsBindings, step: WorkflowStep, archiveId: string) {
  const range = await step.do('history-range', async () => {
    const cutoff = scanStart(env)
    if (cutoff === null) throw new Error('Missing infringement scan start')
    const store = await env.DB.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{ seller: string }>()
    if (!store) throw new Error('Missing Amazon seller')
    return { seller: store.seller, from: cutoff - 7 * 86400000, to: cutoff - 1 }
  })
  const observed = await step.do('history-observation-time', async () => new Date().toISOString())
  let pages = 0
  let inserted = 0
  const gaps: { start: number; end: number; severity: string; expected: number; seen: number }[] = []
  for (const severity of ['ERROR', 'WARNING'] as const) {
    const pending = [{ start: range.from, end: range.to, retried: false }]
    while (pending.length) {
      const { start, end, retried } = pending.pop()!
      let token: string | undefined
      let seen = 0
      let expected = 0
      let page = 0
      const usedTokens = new Set<string>()
      do {
        const cursor = token
        const pageNumber = page++
        const result = await step.do(`${severity}-${start}-${end}-${pageNumber}`,
          { retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
          async () => {
            const { credentials } = await providerCredentials(env, 'amazon')
            const listings = await new AmazonUS(credentials, undefined, env.DB)
              .recentlyUpdatedListings(range.seller, start, end, cursor, severity)
            let inserted = 0
            if (listings.numberOfResults <= listingSearchLimit) {
              const saved = await recordInfringements(env.DB, range.seller, listings.items, observed, undefined, true)
              inserted = saved.reduce((total, write) => total + write.meta.changes, 0)
            }
            return { expected: listings.numberOfResults, count: listings.items.length, next: listings.pagination?.nextToken, inserted }
          },
        )
        pages++
        inserted += result.inserted
        expected = Math.max(expected, result.expected)
        seen += result.count
        token = result.next
        if (expected > listingSearchLimit || !result.count || !token || usedTokens.has(token) || page >= 100) break
        usedTokens.add(token)
      } while (token)
      if (expected <= listingSearchLimit && !token && seen >= expected) continue
      const overLimit = expected > listingSearchLimit
      if (end > start && (overLimit || !retried)) {
        const middle = Math.floor((start + end) / 2)
        pending.push({ start: middle + 1, end, retried: retried || !overLimit }, { start, end: middle, retried: retried || !overLimit })
      } else {
        gaps.push({ start, end, severity, expected, seen })
      }
    }
  }
  const report = { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), observed, pages, inserted, gaps }
  await step.do('save-history-coverage', async () => {
    await env.ARCHIVE.put('infringement/history/' + archiveId + '.json', JSON.stringify(report))
  })
  return { ...report, gaps: gaps.length }
}

export async function scanInfringements(
  env: OpsBindings,
  step: WorkflowStep,
  tick: number,
  lease: string,
) {
  const scan = await step.do('claim-infringement-scan', async () => {
    const store = await env.DB.prepare(`SELECT seller FROM title_audit_store WHERE singleton=1
      AND EXISTS(SELECT 1 FROM notification_groups WHERE enabled=1)`).first<{ seller: string }>()
    if (!store) return null
    const end = tick - 120000
    const earliest = scanStart(env)
    if (earliest !== null && end < earliest) return null
    const initialCursor = earliest === null ? end - 1800000 : earliest - 1
    await env.DB.prepare(
      'INSERT OR IGNORE INTO notification_infringement_scan(seller,through_ms) VALUES(?,?)',
    )
      .bind(store.seller, initialCursor)
      .run()
    const now = Date.now()
    const current = await env.DB.prepare(`UPDATE notification_infringement_scan SET lease=?,lease_until=?
      WHERE seller=? AND through_ms<? AND (lease IS NULL OR lease=? OR lease_until<=?) RETURNING through_ms`)
      .bind(lease, now + 20 * 60000, store.seller, end, lease, now)
      .first<{ through_ms: number }>()
    if (!current) return null
    const through = Math.max(current.through_ms, earliest === null ? current.through_ms : earliest - 1)
    return {
      seller: store.seller,
      start: Math.max(through - 300000, earliest ?? -Infinity),
      end: Math.min(end, through + 3600000),
    }
  })
  if (!scan) return
  const { seller } = scan
  const observed = new Date(tick).toISOString()
  const ranges = [{ start: scan.start, end: scan.end, retried: false }]
  let incompleteWindows = 0
  try {
    while (ranges.length) {
      const { start, end, retried } = ranges.pop()!
      let cursor: string | undefined
      let seen = 0
      let page = 0
      let expected = 0
      const usedTokens = new Set<string>()
      do {
        const token = cursor
        const result = await step.do(`infringement-${start}-${end}-${page++}`, async () => {
          const granted = await env.DB.prepare(`UPDATE notification_infringement_scan SET lease_until=?
            WHERE seller=? AND lease=? RETURNING seller`)
            .bind(Date.now() + 20 * 60000, seller, lease)
            .first()
          if (!granted) throw new Error('scan lease lost')
          const { credentials } = await providerCredentials(env, 'amazon')
          const data = await new AmazonUS(credentials, undefined, env.DB).recentlyUpdatedListings(
            seller,
            start,
            end,
            token,
          )
          if (data.numberOfResults <= listingSearchLimit)
            await recordInfringements(env.DB, seller, data.items, observed, lease)
          return {
            total: data.numberOfResults,
            count: data.items.length,
            next: data.pagination?.nextToken ?? '',
          }
        })
        expected = Math.max(expected, result.total)
        seen += result.count
        if (expected > listingSearchLimit) break
        if (result.next) {
          if (usedTokens.has(result.next) || page >= 100) throw new Error('invalid pagination')
          usedTokens.add(result.next)
        }
        cursor = result.next || undefined
      } while (cursor)
      const overLimit = expected > listingSearchLimit
      if (overLimit && end - start < 1000) throw new Error('Amazon listing window exceeds search limit')
      // A terminal page can disagree with the reported total. Retry in smaller ranges once,
      // then keep the items actually returned and surface the remaining coverage gap.
      if (overLimit || (seen < expected && !retried && end - start >= 1000)) {
        const middle = Math.floor((start + end) / 2)
        ranges.push(
          { start: middle + 1, end, retried: retried || !overLimit },
          { start, end: middle, retried: retried || !overLimit },
        )
      } else if (seen < expected) {
        incompleteWindows++
      }
    }
    return await step.do('finish-infringement-scan', async () => {
      const warning = incompleteWindows
        ? `Amazon 有 ${incompleteWindows} 个时间段返回条数少于声明总数，已保存返回结果并推进扫描进度。`
        : null
      const saved = await env.DB.prepare(`UPDATE notification_infringement_scan SET through_ms=?,lease=NULL,lease_until=NULL,error=?
        WHERE seller=? AND lease=? RETURNING through_ms`)
        .bind(scan.end, warning, seller, lease)
        .first<{ through_ms: number }>()
      return saved ? { throughMs: saved.through_ms, incompleteWindows } : null
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowInternalError') throw error
    await step.do('fail-infringement-scan', async () => {
      await env.DB.prepare(`UPDATE notification_infringement_scan SET lease=NULL,lease_until=NULL,error=?
        WHERE seller=? AND lease=?`)
        .bind('Amazon 商品问题扫描未完成，下轮会从上次进度继续。', seller, lease)
        .run()
    })
  }
}

type InfringementRecord = {
  sku: string
  asin: string | null
  title: string | null
  image: string | null
  observed_at: string
  fingerprint: string
  issue_details: string | null
  assigned_owner: string | null
}

function amazonForInfringement(env: ConnectionBindings) {
  let client: Promise<AmazonUS> | undefined
  return () => (client ??= providerCredentials(env, 'amazon')
    .then(({ credentials }) => new AmazonUS(credentials, undefined, env.DB)))
}

async function prepareInfringementMessage(
  row: InfringementRecord,
  seller: string,
  name: string,
  amazon: () => Promise<AmazonUS>,
) {
  let asin = row.asin
  let title = row.title?.trim() || null
  let image = safeImage(row.image)
  const lookupErrors: Partial<Record<'title' | 'image', string>> = {}
  if (!title) {
    try {
      const listing = await (await amazon()).listingTitleBySku(seller, row.sku)
      if (listing && (!asin || !listing.asin || asin === listing.asin)) {
        asin ??= listing.asin
        title = listing.title
      } else if (listing) {
        lookupErrors.title = 'ASIN_MISMATCH'
      }
    } catch (error) {
      lookupErrors.title = error instanceof PublicError ? error.code : 'DATA_INCOMPLETE'
    }
  }
  if (!image && asin && /^[A-Z0-9]{10}$/.test(asin)) {
    try {
      image = safeImage(await (await amazon()).mainImageByAsin(asin))
    } catch (error) {
      lookupErrors.image = error instanceof PublicError ? error.code : 'DATA_INCOMPLETE'
    }
  }
  return { asin, title, image, lookupErrors, row: { ...row, asin, title, image, name } }
}

function infringementOwnerName(sku: string, owner?: string | null) {
  return /^HUJM/i.test(sku) ? '集美' : owner ?? '未匹配'
}

export async function previewInfringement(env: ConnectionBindings, sku: string) {
  const db = env.DB
  const row = await db.prepare(`SELECT i.*,i.changed_at observed_at,o.account_id assigned_owner
    FROM notification_infringements i LEFT JOIN weekly_feedback_owners o
    ON o.seller=i.seller AND o.sku=i.sku AND o.marketplace=?
    WHERE i.sku=? AND i.fingerprint<>'[]' AND i.seller=(SELECT seller FROM title_audit_store WHERE singleton=1)`)
    .bind(market, sku).first<InfringementRecord & { seller: string }>()
  if (!row) return null
  const [rules, terms] = await Promise.all([feedbackOwnerRules(db, row.seller), customTerms(db)])
  const accountId = row.assigned_owner ?? matchFeedbackOwner(row.sku, rules)?.account_id
  const owner = accountId
    ? await db.prepare("SELECT username FROM accounts WHERE id=? AND active=1 AND role IN ('admin','operator')")
      .bind(accountId).first<string>('username')
    : null
  const name = infringementOwnerName(sku, owner)
  const { row: enriched, ...message } = await prepareInfringementMessage(row, row.seller, name, amazonForInfringement(env))
  return { sku, owner: name === '未匹配' ? null : name, ...message, content: infringementText(enriched, buildInspector(terms)) }
}

export async function queueInfringements(env: ConnectionBindings & GroupNotificationBindings) {
  const db = env.DB
  const [group, store] = await Promise.all([
    serviceGroup(db, 'infringement'),
    db.prepare('SELECT seller FROM title_audit_store WHERE singleton=1').first<{ seller: string }>(),
  ])
  if (!group?.enabled || !store) return
  const { seller } = store
  const [rules, members, terms] = await Promise.all([
    feedbackOwnerRules(db, seller),
    groupMembers(db, group.id),
    customTerms(db),
  ])
  const owners = new Map(members.results.map((member) => [member.accountId, member.name]))
  const inspect = buildInspector(terms)
  const amazon = amazonForInfringement(env)
  const earliest = scanStart(env)
  const observedAt = earliest === null
    ? group.activated_at
    : new Date(Math.max(Date.parse(group.activated_at), earliest)).toISOString()
  const { results } = await db.prepare(`WITH pending AS (
      SELECT e.id,e.sku,e.observed_at,i.asin,i.title,i.image,
      i.fingerprint,i.issue_details,o.account_id assigned_owner
      FROM notification_infringement_events e
      JOIN notification_infringements i ON i.revision=e.id AND i.seller=e.seller AND i.sku=e.sku
      LEFT JOIN weekly_feedback_owners o ON o.seller=e.seller AND o.sku=e.sku AND o.marketplace=?
      WHERE e.seller=? AND i.fingerprint<>'[]' AND e.id NOT LIKE 'history:%' AND e.observed_at>=?
      AND NOT EXISTS(SELECT 1 FROM notification_infringement_scan s WHERE s.seller=e.seller AND s.lease_until>?)
      AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.id='infringement:'||e.id)
      AND NOT EXISTS(SELECT 1 FROM notification_infringement_deliveries b WHERE b.event_id=e.id)
    ) SELECT * FROM pending WHERE observed_at IN (SELECT DISTINCT observed_at FROM pending ORDER BY observed_at LIMIT 3)
      ORDER BY observed_at,sku,id`)
    .bind(market, seller, observedAt, Date.now())
    .all<InfringementRecord & { id: string }>()
  const byOwner = new Map<string, { row: InfringementRecord & { id: string }; name: string; accountId: string | null }[]>()
  for (const row of results) {
    const accountId = row.assigned_owner ?? matchFeedbackOwner(row.sku, rules)?.account_id ?? null
    const owner = accountId ? owners.get(accountId) : null
    const name = infringementOwnerName(row.sku, owner)
    const key = JSON.stringify([row.observed_at, name, name === '集美' ? null : owner ? accountId : row.id])
    const matches = byOwner.get(key) ?? []
    matches.push({ row, name, accountId })
    byOwner.set(key, matches)
  }
  for (const matches of byOwner.values()) {
    const prepared = []
    for (const { row, name, accountId } of matches) {
      const { row: enriched } = await prepareInfringementMessage(row, seller, name, amazon)
      prepared.push({ id: row.id, accountId, message: infringementMessage(enriched, inspect) })
    }
    for (const { rows, content } of batchInfringementMessages(prepared)) {
      const current = await serviceGroup(db, 'infringement')
      if (!current?.enabled || current.id !== group.id || current.activated_at !== group.activated_at) return
      const [first] = rows
      const id = 'infringement-batch:' + first.id
      const accountId = rows.every((row) => row.accountId === first.accountId) ? first.accountId : null
      const images = rows.flatMap(({ message }) => message.image ? [message.image] : [])
      await db.batch([enqueueDelivery(db, {
        id,
        service: 'infringement',
        groupId: group.id,
        accountId,
        content,
        image: images.length > 1 ? JSON.stringify(images) : images[0],
      }), ...rows.map((row) => db.prepare(
        'INSERT INTO notification_infringement_deliveries(event_id,delivery_id) VALUES(?,?)',
      ).bind(row.id, id))])
    }
  }
}
