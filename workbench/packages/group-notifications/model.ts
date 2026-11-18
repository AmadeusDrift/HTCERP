import { openCredential, sealCredential } from '../connections/credentials'
import { PublicError } from '../contracts/errors'

export type NotificationService = keyof typeof labels
export interface GroupNotificationBindings {
  DB: D1Database
  CONNECTIONS_KEY?: string
  WECOM_GROUP_WEBHOOKS?: string
  INFRINGEMENT_SCAN_START?: string
}
export interface NotificationGroup {
  id: string
  name: string
  webhook_key: string
  enabled: number
  webhook_hint: string | null
  webhook_nonce: string | null
  webhook_ciphertext: string | null
}
export const labels = { feedback: '差评周报', infringement: '侵权提醒', 'daily-sales': '销量日报' }

export async function groupById(db: D1Database, id: string) {
  const group = await db
    .prepare('SELECT * FROM notification_groups WHERE id=?')
    .bind(id)
    .first<NotificationGroup>()
  if (!group) throw new PublicError('NOT_FOUND', '找不到这个企业微信群。', 404)
  return group
}

export function serviceGroup(db: D1Database, service: NotificationService) {
  return db
    .prepare(`SELECT g.*,r.activated_at FROM notification_routes r
    JOIN notification_groups g ON g.id=r.group_id WHERE r.service=?`)
    .bind(service)
    .first<NotificationGroup & { activated_at: string }>()
}

export function groupMembers(db: D1Database, groupId: string) {
  return db
    .prepare(`SELECT a.id accountId,a.username name,m.userid,coalesce(g.enabled,0) enabled
    FROM accounts a LEFT JOIN weekly_feedback_members m ON m.account_id=a.id
    LEFT JOIN notification_group_members g ON g.account_id=a.id AND g.group_id=?
    WHERE a.active=1 AND a.role IN ('operator','admin') ORDER BY a.username`)
    .bind(groupId)
    .all<{ accountId: string; name: string; userid: string | null; enabled: number }>()
}

function parseWebhook(value: unknown) {
  try {
    if (typeof value !== 'string') return null
    const url = new URL(value)
    const token = url.searchParams.get('key')
    if (
      url.origin !== 'https://qyapi.weixin.qq.com' ||
      url.pathname !== '/cgi-bin/webhook/send' ||
      url.username ||
      url.password ||
      url.hash ||
      !token ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(token) ||
      [...url.searchParams.keys()].length !== 1
    )
      return null
    return { url, token, hint: token.slice(-4) }
  } catch {
    return null
  }
}

const webhookScope = (groupId: string) => 'wecom-group/' + groupId

export async function encryptGroupWebhook(env: GroupNotificationBindings, groupId: string, value: string) {
  const webhook = parseWebhook(value)
  if (!webhook)
    throw new PublicError('INVALID_INPUT', '请粘贴完整的企业微信群机器人 Webhook 链接。', 400)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(webhook.token))
  const fingerprint = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const encrypted = await sealCredential(env, webhookScope(groupId), webhook.url.href)
  return { ...encrypted, key: 'erp-' + fingerprint, hint: webhook.hint }
}

export async function webhookUrl(
  env: GroupNotificationBindings,
  group: Pick<NotificationGroup, 'id' | 'webhook_key' | 'webhook_nonce' | 'webhook_ciphertext'>,
) {
  try {
    if (group.webhook_ciphertext !== null) {
      if (!group.webhook_nonce) return null
      return parseWebhook(await openCredential(env, webhookScope(group.id), {
        nonce: group.webhook_nonce,
        ciphertext: group.webhook_ciphertext,
      }))
    }
    const webhooks: unknown = JSON.parse(env.WECOM_GROUP_WEBHOOKS ?? '{}')
    if (!webhooks || typeof webhooks !== 'object' || !Object.hasOwn(webhooks, group.webhook_key)) return null
    return parseWebhook((webhooks as Record<string, unknown>)[group.webhook_key])
  } catch {
    return null
  }
}
