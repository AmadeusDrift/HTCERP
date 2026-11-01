import type { SubtleCrypto as WorkersSubtleCrypto } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Position } from '../../../packages/contracts/accounts'
import { PublicError } from '../../../packages/contracts/errors'
import { type Actor, isLocalDevelopment, type Role, unauthorized } from './access'
import type { AppEnv } from './bindings'

type Ctx = Context<AppEnv>
export type AccountRow = {
  id: string
  username: string
  role: Role
  active: number
  position: Position | null
}
type CredentialRow = AccountRow & { salt: string; password_hash: string; auth_version: number }
export const accountFields = 'id, username, role, active, position'
export const publicAccount = (row: AccountRow) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  position: row.position,
  active: !!row.active,
})
const actor = (row: Pick<AccountRow, 'id' | 'username' | 'role' | 'position'>): Actor => ({
  id: row.id,
  username: row.username,
  role: row.role,
  position: row.position,
  email: row.username,
  local: false,
})

const hex = (bytes: Uint8Array) => Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('')
const randomHex = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)))
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
const encoder = new TextEncoder()
const digest = async (value: string) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
const now = () => Math.floor(Date.now() / 1000)
const sessionSeconds = 12 * 60 * 60

async function derivePassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  // The production Workers PBKDF2 limit is 100,000 iterations per invocation.
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-512', salt: unhex(salt), iterations: 100_000 },
      key,
      256,
    ),
  )
}

export async function newCredentials(password: string) {
  const salt = randomHex(16)
  return { salt, hash: hex(await derivePassword(password, salt)) }
}

function equalHash(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false
  const subtle = crypto.subtle as SubtleCrypto & Partial<Pick<WorkersSubtleCrypto, 'timingSafeEqual'>>
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(actual, expected)
  // Standards-only runtimes (including Node's WebCrypto) lack the Workers extension.
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i]
  return difference === 0
}

function cookieName(c: Ctx) {
  if (new URL(c.req.url).protocol === 'https:') return '__Host-workbench_session'
  if (isLocalDevelopment(new URL(c.req.url), c.env)) return 'workbench_dev_session'
  throw unauthorized()
}
function writeCookie(c: Ctx, token: string, maxAge: number) {
  const name = cookieName(c)
  setCookie(c, name, token, {
    path: '/',
    httpOnly: true,
    secure: name.startsWith('__Host-'),
    sameSite: 'Strict',
    maxAge,
  })
}
async function sessionHash(c: Ctx) {
  const raw = getCookie(c, cookieName(c))
  return raw && /^[0-9a-f]{64}$/.test(raw) ? await digest(raw) : null
}
export async function sessionActor(c: Ctx): Promise<Actor> {
  const hash = await sessionHash(c)
  if (hash) {
    const row =
      await c.env.DB.prepare(`SELECT a.id,a.username,a.role,a.position FROM accounts a JOIN account_sessions s
      ON a.id=s.account_id AND a.auth_version=s.auth_version
      WHERE s.token_hash=? AND s.expires_at>? AND a.active=1`)
        .bind(hash, now())
        .first<AccountRow>()
    if (row) return actor(row)
  }
  if (
    isLocalDevelopment(new URL(c.req.url), c.env) &&
    !(await c.env.DB.prepare('SELECT id FROM accounts LIMIT 1').first())
  ) {
    return {
      id: 'local',
      username: 'local',
      email: 'local@workbench',
      role: 'admin',
      position: null,
      local: true,
    }
  }
  throw unauthorized()
}

async function reserveGuess(db: D1Database, bucket: string, window: number, limit: number) {
  const reserved = await db
    .prepare(`INSERT INTO login_attempts(bucket,window,used) VALUES(?,?,1)
    ON CONFLICT(bucket) DO UPDATE SET window=excluded.window,
      used=CASE WHEN window=excluded.window THEN used+1 ELSE 1 END
    WHERE window<>excluded.window OR used<? RETURNING used`)
    .bind(bucket, window, limit)
    .first()
  if (!reserved)
    throw new PublicError('RATE_LIMIT', '登录尝试过于频繁，请在十分钟后重试。', 429, 'workbench', true)
}

export async function signIn(c: Ctx, username: string, password: string) {
  cookieName(c)
  const db = c.env.DB
  const window = Math.floor(now() / 600)
  const userBucket = 'user:' + username
  // Only the edge-injected client address is used. Never trust X-Forwarded-For.
  const source = c.req.header('CF-Connecting-IP') || 'unknown'
  await reserveGuess(db, 'ip:' + (await digest(source)), window, 40)
  await reserveGuess(db, userBucket, window, 10)
  await db.prepare('DELETE FROM login_attempts WHERE window<?').bind(window).run()
  const row = await db
    .prepare(
      'SELECT ' + accountFields + ', salt, password_hash, auth_version FROM accounts WHERE username=?',
    )
    .bind(username)
    .first<CredentialRow>()
  const candidate = await derivePassword(password, row?.salt ?? '00'.repeat(16))
  const valid = equalHash(candidate, unhex(row?.password_hash ?? '00'.repeat(32)))
  const denied = () => new PublicError('UNAUTHORIZED', '用户名或密码不正确。', 401)
  if (!valid || !row?.active) throw denied()
  const token = randomHex(32)
  // A password reset racing verification must not mint a session for the old credential.
  const session = await db
    .prepare(`INSERT INTO account_sessions(token_hash, account_id, auth_version, expires_at)
    SELECT ?,id,auth_version,? FROM accounts WHERE id=? AND active=1 AND auth_version=? RETURNING account_id`)
    .bind(await digest(token), now() + sessionSeconds, row.id, row.auth_version)
    .first()
  if (!session) throw denied()
  await db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').bind(now()).run()
  await db
    .prepare('DELETE FROM login_attempts WHERE bucket=? AND window=?')
    .bind(userBucket, window)
    .run()
  writeCookie(c, token, sessionSeconds)
  return actor(row)
}

export async function signOut(c: Ctx) {
  const hash = await sessionHash(c)
  if (hash) await c.env.DB.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(hash).run()
  writeCookie(c, '', 0)
}
