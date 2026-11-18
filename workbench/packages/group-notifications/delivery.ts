import { PublicError } from '../contracts/errors'
import { inspectTitle } from '../title-audit/rules'
import { safeImage } from '../weekly-feedback/model'
import { type FeedbackRun, notificationDraft } from '../weekly-feedback/report'
import type { ProductNames } from '../weekly-feedback/product-names'
import {
  type GroupNotificationBindings,
  groupMembers,
  type NotificationService,
  serviceGroup,
  webhookUrl,
} from './model'

interface DeliveryInput {
  id: string
  service: NotificationService
  groupId: string
  accountId: string | null
  content: string
  image?: string | null
  trial?: boolean
}

const wecomTextBytes = 2000

function messageText(content: string, link?: string) {
  const encoder = new TextEncoder()
  const suffix = link ? '\n\n查看周报：' + link : ''
  const budget = wecomTextBytes - encoder.encode(suffix).length
  if (encoder.encode(content).length <= budget) return content + suffix
  const truncatedBudget = budget - encoder.encode('…').length
  let length = 0
  let text = ''
  for (const character of content) {
    length += encoder.encode(character).length
    if (length > truncatedBudget) return text + '…' + suffix
    text += character
  }
  return text + suffix
}

export function enqueueDelivery(db: D1Database, input: DeliveryInput) {
  const now = new Date().toISOString()
  return db
    .prepare(`INSERT INTO notification_deliveries
    (id,service,group_id,account_id,trial,content,image,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,account_id=excluded.account_id,content=excluded.content,image=excluded.image
    WHERE notification_deliveries.status='queued' AND notification_deliveries.phase='text'`)
    .bind(
      input.id,
      input.service,
      input.groupId,
      input.accountId,
      Number(!!input.trial),
      input.content,
      input.image ?? null,
      now,
      now,
    )
}

export async function queueWeeklyGroup(db: D1Database, runId: string, names?: ProductNames) {
  const group = await serviceGroup(db, 'feedback')
  if (!group) return false
  if (!group.enabled) return true
  const run = await db
    .prepare(`SELECT * FROM weekly_feedback_runs WHERE id=? AND status IN ('done','partial')
    AND seller=(SELECT seller FROM title_audit_store WHERE singleton=1)`)
    .bind(runId)
    .first<FeedbackRun>()
  if (!run) return true
  const { results: members } = await groupMembers(db, group.id)
  const recipients = new Set(
    members.filter((member) => member.enabled && member.userid).map((member) => member.accountId),
  )
  if (!recipients.size) return true
  const { groups } = await notificationDraft(db, run, { names, recipients })
  const deliveries = groups.map((target) =>
    enqueueDelivery(db, {
      id: JSON.stringify(['feedback', run.seller, run.marketplace, run.week, target.accountId]),
      service: 'feedback',
      groupId: group.id,
      accountId: target.accountId,
      content: target.groupText,
    }),
  )
  for (let offset = 0; offset < deliveries.length; offset += 50)
    await db.batch(deliveries.slice(offset, offset + 50))
  return true
}

const issueAttributeLabels = new Map([
  ['item_name', '商品标题'],
  ['brand', '品牌'],
  ['main_product_image_locator', '商品主图'],
  ['product_description', '商品描述'],
  ['bullet_point', '商品卖点'],
  ['generic_keyword', '搜索关键词'],
])

const issueTranslations = new Map([
  ['trademark misuse', '滥用商标'],
  ['potential trademark misuse', '涉嫌滥用商标'],
  ['trademark text misuse', '滥用商标文字'],
  ['potential trademark text misuse', '涉嫌滥用商标文字'],
  ['trademark logo misuse', '滥用商标标识'],
  ['potential trademark logo misuse', '涉嫌滥用商标标识'],
  ['copyright infringement', '侵犯版权'],
  ['patent infringement', '侵犯专利权'],
  ['intellectual property infringement', '侵犯知识产权'],
  ['counterfeit', '假冒商品'],
])

type InfringementIssue = { message: string; attributeNames: string[] }
type InfringementFingerprintEntry = [code: string, message: string, ...other: unknown[]]
const beijingDateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
  hourCycle: 'h23',
})

const enforcementLabels = new Map([
  ['CATALOG_ITEM_REMOVED', { action: '移除商品', applied: '商品已移除' }],
  ['LISTING_SUPPRESSED', { action: '限制该刊登销售', applied: '已限制该刊登销售' }],
  ['SEARCH_SUPPRESSED', { action: '隐藏搜索结果', applied: '商品已从搜索结果隐藏' }],
  ['ATTRIBUTE_SUPPRESSED', { action: '拒绝商品属性值', applied: '商品属性值已被拒绝' }],
])

function infringementEnforcement(fingerprint: InfringementFingerprintEntry[], observedAt: string) {
  const observed = Date.parse(observedAt)
  const statuses = new Set<string>()
  for (const [, , actions, exemption, expiryDate] of fingerprint) {
    if (!Array.isArray(actions)) continue
    for (const code of actions) {
      if (typeof code !== 'string' || !code.trim()) continue
      const label = enforcementLabels.get(code)
      const action = label?.action ?? code
      if (exemption === 'NOT_EXEMPT') statuses.add(label?.applied ?? ('已执行 ' + action))
      else if (exemption === 'EXEMPT') statuses.add(action + '已豁免')
      else if (exemption === 'EXEMPT_UNTIL_EXPIRY_DATE') {
        const expiry = typeof expiryDate === 'string' ? Date.parse(expiryDate) : NaN
        if (!Number.isFinite(expiry)) statuses.add('暂缓' + action + '（豁免截止时间未返回）')
        else if (expiry > observed) statuses.add('暂缓' + action + '（豁免至 ' + beijingDateTime.format(expiry) + '，北京时间）')
        else statuses.add(action + '（豁免已到期，执行结果待确认）')
      } else statuses.add(action + '（执行状态未返回）')
    }
  }
  return [...statuses].join('；') || '未返回处置动作，执行状态未知'
}

const ambiguousTrademarkWords = /\b(?:cyber[ -]*punk|dark[ -]*knight)\b/gi

function infringementIssueLines(fingerprint: InfringementFingerprintEntry[], details: string | null) {
  const issues: InfringementIssue[] = details !== null
    ? JSON.parse(details)
    : fingerprint.map(([, message]) => ({ message, attributeNames: [] }))
  if (!issues.length) return ['亚马逊原文：暂无', '亚马逊位置字段：暂无']
  return issues.flatMap(({ message, attributeNames }) => {
    const attributes = attributeNames.map((name) => {
      const label = issueAttributeLabels.get(name)
      return label ? `${label}（${name}）` : name
    })
    const location = attributes.join('、') || (details === null ? '历史记录未保存' : '未返回（以原文为准）')
    const translation = issueTranslations.get(message.trim().replace(/\.$/, '').toLowerCase())
    return [`亚马逊原文：${message}（${translation ?? '暂无中文对照'}）`, `亚马逊位置字段：${location}`]
  })
}

export function infringementMessage(
  row: {
    sku: string
    asin: string | null
    title: string | null
    image?: string | null
    observed_at: string
    name: string
    fingerprint: string | null
    issue_details: string | null
  },
  inspect: (title: string) => ReturnType<typeof inspectTitle> = inspectTitle,
) {
  const time = beijingDateTime.format(new Date(row.observed_at))
  const title = row.title?.replace(/\s+/g, ' ').trim()
  const hits = title ? inspect(title).hits.filter((hit) => hit.verdict !== '通过' && hit.names.length) : []
  const fingerprint: InfringementFingerprintEntry[] = (JSON.parse(row.fingerprint ?? '[]') as string[])
    .map((entry) => JSON.parse(entry))
  const terms = [...new Set(hits.map((hit) => hit.term))].map((term) => `「${term}」`).join('、')
  const riskyPhrases = title && fingerprint.some(([code]) => code === '18146')
    ? [...title.matchAll(ambiguousTrademarkWords)]
      .filter((match) => !hits.some((hit) => hit.start <= match.index && hit.end >= match.index + match[0].length))
      .map((match) => match[0])
    : []
  const clues = []
  if (terms) clues.push(`标题命中${terms}（ERP 词库）`)
  if (riskyPhrases.length) {
    const phrases = [...new Set(riskyPhrases)].map((phrase) => `「${phrase}」`).join('、')
    clues.push(`标题含${phrases}【高风险，待复核】`)
  }
  const clue = clues.join('。') || (title ? '标题未命中品牌或 IP 词条' : '缺少商品标题')
  return {
    time,
    name: row.name,
    product: [`SKU：${row.sku}`, `ASIN：${row.asin ?? '未返回'}`, `商品标题：${title || '未返回'}`],
    label: `${row.sku} / ${row.asin ?? '未返回'}\n${title || '商品标题未返回'}`,
    image: row.image ?? null,
    facts: [
      infringementIssueLines(fingerprint, row.issue_details).join('\n'),
      '亚马逊处置：' + infringementEnforcement(fingerprint, row.observed_at),
      `ERP 核查：${clue}`,
      row.image ? '主图：见随附图片' : '主图：亚马逊 API 未返回，未提供',
    ],
  }
}

type InfringementMessage = ReturnType<typeof infringementMessage>

function singleInfringementText(message: InfringementMessage) {
  const [sku, asin, title] = message.product
  const [issues, enforcement, clue, image] = message.facts
  return messageText([
    '美国站侵权提醒',
    `时间：${message.time}（北京时间）`,
    sku,
    asin,
    `涉及运营：${message.name}`,
    title,
    ...(message.image ? [] : [image]),
    issues,
    enforcement,
    clue,
  ].join('\n'))
}

export function infringementText(...args: Parameters<typeof infringementMessage>) {
  return singleInfringementText(infringementMessage(...args))
}

function combinedInfringementText(messages: InfringementMessage[]) {
  const [first] = messages
  const shared = first.facts.map((value, index) => messages.every((message) => message.facts[index] === value))
  return [
    `美国站侵权提醒｜${first.name}（${messages.length} 件商品）`,
    `时间：${first.time}（北京时间）`,
    ...first.facts.filter((_, index) => shared[index]),
    ...messages.map(({ label, facts }, index) =>
      ['', `${index + 1}. ${label}`, ...facts.filter((_, fact) => !shared[fact])].join('\n')),
  ].join('\n')
}

export function batchInfringementMessages<T extends { message: InfringementMessage }>(rows: T[]) {
  const batches: { rows: T[]; content: string }[] = []
  const encoder = new TextEncoder()
  let current: T[] = []
  let content = ''
  for (const row of rows) {
    const candidate = [...current, row]
    const combined = current.length ? combinedInfringementText(candidate.map((item) => item.message)) : ''
    if (combined && encoder.encode(combined).length <= wecomTextBytes) {
      current = candidate
      content = combined
      continue
    }
    if (current.length) batches.push({ rows: current, content })
    current = [row]
    content = singleInfringementText(row.message)
  }
  if (current.length) batches.push({ rows: current, content })
  return batches
}

function deliveryImages(images: string | null): string[] {
  return !images ? [] : images.startsWith('[') ? JSON.parse(images) : [images]
}

async function imageMessage(source: string | null) {
  const url = safeImage(source)
  if (!url || new URL(url).port || new URL(url).username || new URL(url).password)
    throw new Error('invalid image')
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const maxBytes = 2 * 1024 * 1024
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (
    !response.ok ||
    !response.body ||
    !['image/jpeg', 'image/png'].includes(contentType ?? '') ||
    Number(response.headers.get('content-length')) > maxBytes
  )
    throw new Error('invalid image response')
  const reader = response.body.getReader()
  const bytes = new Uint8Array(maxBytes)
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > maxBytes) {
      await reader.cancel()
      throw new Error('image too large')
    }
    bytes.set(value, size)
    size += value.length
  }
  const image = bytes.subarray(0, size)
  if (!image.length) throw new Error('empty image')
  const digest = new Uint8Array(await crypto.subtle.digest('MD5', image))
  const md5 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  let base64 = ''
  const blockSize = 24 * 1024 // Whole groups of three bytes can be encoded independently.
  for (let offset = 0; offset < size; offset += blockSize)
    base64 += btoa(String.fromCharCode(...image.subarray(offset, offset + blockSize)))
  return { msgtype: 'image', image: { base64, md5 } }
}

interface PendingDelivery {
  id: string
  service: NotificationService
  group_id: string
  content: string
  image: string | null
  phase: 'text' | 'image'
  trial: number
  attempts: number
  userid: string | null
  webhook_key: string
  webhook_nonce: string | null
  webhook_ciphertext: string | null
}

const eligibleMention = `EXISTS(
  SELECT 1 FROM accounts a JOIN notification_group_members gm ON gm.account_id=a.id
  JOIN weekly_feedback_members m ON m.account_id=a.id
  WHERE a.id=d.account_id AND a.active=1 AND a.role IN ('operator','admin')
  AND gm.group_id=d.group_id AND gm.enabled=1)`
const eligibleRecipient = `(d.service='daily-sales' OR (d.service='infringement' AND d.trial=0) OR ${eligibleMention})`

async function sendPhase(env: GroupNotificationBindings, id: string) {
  const db = env.DB
  const row = await db
    .prepare(`SELECT d.*,g.webhook_key,g.webhook_nonce,g.webhook_ciphertext,
      CASE WHEN ${eligibleMention} THEN m.userid END AS userid FROM notification_deliveries d
    JOIN notification_groups g ON g.id=d.group_id
    LEFT JOIN weekly_feedback_members m ON m.account_id=d.account_id
    WHERE d.id=? AND d.status='queued' AND g.enabled=1
    AND ${eligibleRecipient}
    AND (d.trial=1 OR EXISTS(SELECT 1 FROM notification_routes r WHERE r.service=d.service AND r.group_id=g.id))`)
    .bind(id)
    .first<PendingDelivery>()
  if (!row) return false
  const webhook = await webhookUrl(env, { ...row, id: row.group_id })
  if (!webhook) {
    await db
      .prepare('UPDATE notification_groups SET webhook_hint=NULL WHERE id=?')
      .bind(row.group_id)
      .run()
    if (row.trial)
      await db
        .prepare(
          "UPDATE notification_deliveries SET status='failed',error=? WHERE id=? AND status='queued'",
        )
        .bind('无法读取该群的 Webhook，请检查群的机器人配置。', id)
        .run()
    return false
  }
  let payload: object
  const images = deliveryImages(row.image)
  try {
    const mentioned = row.service === 'daily-sales' ? '@all' : row.userid
    payload =
      row.phase === 'image'
        ? await imageMessage(images[0] ?? null)
        : {
            msgtype: 'text',
            text: {
              content: row.content,
              ...(mentioned && !(row.service === 'daily-sales' && row.id.startsWith('daily-sales-backfill-'))
                ? { mentioned_list: [mentioned] } : {}),
            },
          }
  } catch {
    await db
      .prepare(`UPDATE notification_deliveries SET attempts=attempts+1,
      status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END,error=?,updated_at=?
      WHERE id=? AND phase='image' AND status='queued'`)
      .bind('商品主图读取失败，请检查原图是否可访问。', new Date().toISOString(), id)
      .run()
    return false
  }
  const slot = await db
    .prepare(`INSERT INTO notification_webhook_rate VALUES(?,?,1)
    ON CONFLICT(webhook_key) DO UPDATE SET minute=excluded.minute,
    used=CASE WHEN minute=excluded.minute THEN used+1 ELSE 1 END
    WHERE minute<>excluded.minute OR used<18 RETURNING used`)
    .bind(row.webhook_key, Math.floor(Date.now() / 60000))
    .first()
  if (!slot) return false
  const claimed = await db
    .prepare(`UPDATE notification_deliveries AS d SET status='sending',updated_at=?
    WHERE id=? AND group_id=? AND phase=? AND status='queued'
    AND ${eligibleRecipient}
    AND (d.service='daily-sales' OR (CASE WHEN ${eligibleMention}
      THEN (SELECT m.userid FROM weekly_feedback_members m WHERE m.account_id=d.account_id) END) IS ?)
    AND EXISTS(SELECT 1 FROM notification_groups g
      WHERE g.id=d.group_id AND g.enabled=1
      AND (d.trial=1 OR EXISTS(SELECT 1 FROM notification_routes r WHERE r.service=d.service AND r.group_id=g.id)))
    RETURNING id`)
    .bind(new Date().toISOString(), id, row.group_id, row.phase, row.userid)
    .first()
  if (!claimed) return false
  let status = 'unknown',
    error: string | null = '企业微信未返回明确结果，请在群里核对。'
  let phase = row.phase
  let image = row.image
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify(payload),
    })
    const result = (await response.json()) as { errcode?: unknown }
    if (response.ok && result?.errcode === 0) {
      if (row.phase === 'image' && images.length > 1) image = JSON.stringify(images.slice(1))
      const moreImages = row.phase === 'text' ? images.length > 0 : images.length > 1
      status = moreImages ? 'queued' : 'sent'
      if (moreImages) phase = 'image'
      error = null
    } else if (
      typeof result?.errcode === 'number' &&
      Number.isSafeInteger(result.errcode) &&
      result.errcode !== 0
    ) {
      status = row.phase === 'image' && row.attempts < 2 ? 'queued' : 'failed'
      error = `企业微信拒绝发送（${result.errcode}）。`
    }
  } catch {
    // A timeout after the request was sent has an uncertain outcome.
  }
  const now = new Date().toISOString()
  const writes = [
    db
      .prepare(`UPDATE notification_deliveries SET status=?,phase=?,image=?,error=?,updated_at=?,
      attempts=CASE WHEN phase<>? OR image IS NOT ? THEN 0 ELSE attempts+1 END WHERE id=? AND status='sending'`)
      .bind(status, phase, image, error, now, phase, image, id),
  ]
  if (!error)
    writes.push(
      db
        .prepare('UPDATE notification_groups SET webhook_hint=? WHERE id=?')
        .bind(webhook.hint, row.group_id),
    )
  await db.batch(writes)
  return status === 'queued' && !error
}

export async function sendGroupDelivery(env: GroupNotificationBindings, id: string) {
  while (await sendPhase(env, id)) {
    // Send attachments in the same order as their products, within the Webhook rate limit.
  }
}

export async function drainGroupNotifications(env: GroupNotificationBindings, service?: NotificationService) {
  const db = env.DB
  await db
    .prepare(`UPDATE notification_deliveries SET status='unknown',error='发送过程被中断，请在群里核对。'
    WHERE status='sending' AND updated_at<? AND (? IS NULL OR (service=? AND trial=0))`)
    .bind(new Date(Date.now() - 5 * 60000).toISOString(), service ?? null, service ?? null)
    .run()
  const { results } = await db
    .prepare(`SELECT d.id FROM notification_deliveries d
    JOIN notification_groups g ON g.id=d.group_id AND g.enabled=1
    WHERE d.status='queued' AND (? IS NULL OR (d.service=? AND d.trial=0))
    AND ${eligibleRecipient}
    AND (d.trial=1 OR EXISTS(SELECT 1 FROM notification_routes r
      WHERE r.service=d.service AND r.group_id=g.id)) ORDER BY d.trial DESC,d.updated_at,d.id LIMIT 18`)
    .bind(service ?? null, service ?? null)
    .all<{ id: string }>()
  for (const { id } of results) await sendGroupDelivery(env, id)
}

export function missingRecipient() {
  return new PublicError('INVALID_INPUT', '请先启用该运营并绑定企业微信 UserID。', 409)
}
