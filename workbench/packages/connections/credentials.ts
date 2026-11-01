import { PublicError } from '../contracts/errors'

const fields = {
  geekbi: ['GB_APP_KEY', 'GB_APP_SECRET'],
  openrouter: ['OPENROUTER_API_KEY'],
  amazon: ['SP_CLIENT_ID', 'SP_CLIENT_SECRET', 'SP_REFRESH_TOKEN'],
} as const
export type Provider = keyof typeof fields
type Field = (typeof fields)[Provider][number]
type Credentials = Partial<Record<Field, string>>
export const geekSlots = [1, 2, 3, 4, 5] as const
type SlotBinding = `GB_APP_${'KEY' | 'SECRET'}_${2 | 3 | 4 | 5}`
export interface ConnectionBindings extends Credentials, Partial<Record<SlotBinding, string>> {
  OPENROUTER_US?: { fetch(request: Request): Promise<Response> }
  DB: D1Database
  CONNECTIONS_KEY?: string
  GEEKBI_CONFIGURED?: string
  OPENROUTER_CONFIGURED?: string
}
export const isProvider = (name: string): name is Provider => Object.hasOwn(fields, name)
export const credentialEditing = (env: ConnectionBindings) =>
  typeof env.CONNECTIONS_KEY === 'string' && /^[0-9a-f]{64}$/i.test(env.CONNECTIONS_KEY)
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
function recordId(provider: Provider, slot: number) {
  if (!Number.isInteger(slot) || slot < 1 || slot > (provider === 'geekbi' ? 5 : 1))
    throw new PublicError('INVALID_INPUT', '凭据组编号无效。', 400)
  return slot === 1 ? provider : provider + '-' + slot
}
function geekBindings(env: ConnectionBindings, slot: number) {
  if (slot === 1) return { GB_APP_KEY: env.GB_APP_KEY, GB_APP_SECRET: env.GB_APP_SECRET }
  return {
    GB_APP_KEY: env[`GB_APP_KEY_${slot}` as SlotBinding],
    GB_APP_SECRET: env[`GB_APP_SECRET_${slot}` as SlotBinding],
  }
}
const aad = (provider: string) => encoder.encode('workbench/connection-credentials/v1/' + provider)

async function vaultKey(env: ConnectionBindings) {
  if (!credentialEditing(env))
    throw new PublicError('CREDENTIAL_STORE_UNAVAILABLE', '服务端尚未配置有效的凭证加密密钥。', 503)
  const bytes = Uint8Array.from(env.CONNECTIONS_KEY!.match(/../g)!, (pair) => Number.parseInt(pair, 16))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
function checked(provider: Provider, value: unknown): Credentials {
  const keys = fields[provider]
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => {
      const v = (value as Credentials)[k]
      return (
        Object.hasOwn(value, k) && typeof v === 'string' && /^[ -~]{1,4096}$/.test(v) && v.trim() === v
      )
    })
  )
    throw new PublicError('INVALID_INPUT', '请完整填写该服务的所有凭证字段，检查长度、空白及字符。', 400)
  return value as Credentials
}
export async function replaceCredentials(
  env: ConnectionBindings,
  provider: Provider,
  value: unknown,
  actor: { id: string; local: boolean },
  slot = 1,
) {
  const id = recordId(provider, slot)
  const credentials = checked(provider, value)
  const key = await vaultKey(env)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(id) },
    key,
    encoder.encode(JSON.stringify(credentials)),
  )
  // Recheck the administrator at the write, including the account-free local development session.
  const saved =
    await env.DB.prepare(`INSERT OR REPLACE INTO connection_credentials(provider,version,nonce,ciphertext)
    SELECT ?,1,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND role='admin' AND active=1)
      OR (?=1 AND NOT EXISTS(SELECT 1 FROM accounts))`)
      .bind(id, base64(nonce), base64(new Uint8Array(encrypted)), actor.id, Number(actor.local))
      .run()
  if (!saved.meta.changes) throw new PublicError('FORBIDDEN', '仅启用的管理员可更新服务凭证。', 403)
}
export async function providerCredentials(env: ConnectionBindings, provider: Provider, slot = 1) {
  const id = recordId(provider, slot)
  const row = await env.DB.prepare(
    'SELECT version,nonce,ciphertext FROM connection_credentials WHERE provider=?',
  )
    .bind(id)
    .first<{ version: number; nonce: string; ciphertext: string }>()
  if (!row) {
    if (provider === 'geekbi')
      return { credentials: geekBindings(env, slot) as Credentials, revision: '' }
    const credentials: Credentials = {}
    for (const field of fields[provider]) credentials[field] = env[field]
    return { credentials, revision: '' }
  }
  const key = await vaultKey(env)
  try {
    if (row.version !== 1) throw new Error()
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(row.nonce), additionalData: aad(id) },
      key,
      fromBase64(row.ciphertext),
    )
    return {
      credentials: checked(provider, JSON.parse(new TextDecoder().decode(data))),
      revision: row.nonce,
    }
  } catch {
    throw new PublicError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      '无法读取该服务的已保存凭证，请管理员检查加密配置。',
      503,
    )
  }
}
export async function connectionStatus(env: ConnectionBindings) {
  const status = {
    openrouter: !!env.OPENROUTER_API_KEY || env.OPENROUTER_CONFIGURED === 'true',
    amazon: !!(env.SP_CLIENT_ID && env.SP_CLIENT_SECRET && env.SP_REFRESH_TOKEN),
  }
  const managed = await env.DB.prepare('SELECT provider FROM connection_credentials').all<{
    provider: Provider
  }>()
  const managedIds = new Set<string>(managed.results.map((row) => row.provider))
  const slots = geekSlots.map((slot) => {
    const pair = geekBindings(env, slot)
    const saved = managedIds.has(recordId('geekbi', slot))
    const configured = saved ? credentialEditing(env) : !!(pair.GB_APP_KEY && pair.GB_APP_SECRET)
    const binding = configured
      ? 'bound'
      : saved
        ? 'locked'
        : pair.GB_APP_KEY || pair.GB_APP_SECRET
          ? 'incomplete'
          : 'empty'
    return { slot, configured, binding }
  })
  for (const provider of ['amazon', 'openrouter'] as const)
    if (managedIds.has(provider)) status[provider] = credentialEditing(env)
  return { ...status, geekbi: slots.some((s) => s.configured), slots }
}

// Vendors may echo submitted tokens in error bodies or even successful catalog/model results.
export function redactJson(value: unknown, secrets: (string | undefined)[]): unknown {
  const tokens = secrets.filter((s): s is string => !!s).sort((a, b) => b.length - a.length)
  const redact = (s: string) => {
    for (const token of tokens) s = s.replaceAll(token, '[redacted]')
    return s
  }
  function visit(v: unknown): unknown {
    if (typeof v === 'string') return redact(v)
    if (Array.isArray(v)) return v.map(visit)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [redact(k), visit(item)]))
    return v
  }
  return visit(value)
}
