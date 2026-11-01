import { type ConnectionBindings, geekSlots, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { businessClock } from './model'

export const geekDay = () => businessClock().slice(0, 10)

export async function geekCredential(env: ConnectionBindings, slot: number) {
  const { credentials, revision } = await providerCredentials(env, 'geekbi', slot)
  if (!credentials.GB_APP_KEY || !credentials.GB_APP_SECRET) return null
  if (revision) return { slot, credentials, revision }
  // Worker secrets have no vault nonce. Rotating either half creates a new revision.
  const digest = async (s: string) =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
      ),
    )
  const current =
    'binding-' + (await digest(JSON.stringify([credentials.GB_APP_KEY, credentials.GB_APP_SECRET])))
  // Old Worker bindings recorded only the App Key hash. Associate a legacy refusal with the
  // first observed pair once, preserving the historic identifier and later secret-only rotations.
  const legacy = await env.DB.prepare(
    'SELECT 1 FROM usage_reservations WHERE balance_refused=1 AND business_date=? AND credential_slot=? AND length(credential_revision)=44 AND legacy_binding_match IS NULL LIMIT 1',
  )
    .bind(geekDay(), slot)
    .first()
  if (legacy)
    await env.DB.prepare(
      'UPDATE usage_reservations SET legacy_binding_match=? WHERE balance_refused=1 AND business_date=? AND credential_slot=? AND credential_revision=? AND legacy_binding_match IS NULL',
    )
      .bind(current, geekDay(), slot, await digest(credentials.GB_APP_KEY))
      .run()
  return { slot, credentials, revision: current }
}

export async function isGeekSlotRefused(db: D1Database, slot: number, revision: string) {
  return !!(await db
    .prepare(
      'SELECT 1 FROM usage_reservations WHERE balance_refused=1 AND business_date=? AND credential_slot=? AND ? IN (credential_revision,legacy_binding_match) LIMIT 1',
    )
    .bind(geekDay(), slot, revision)
    .first())
}

export async function nextGeekSlot(env: ConnectionBindings, from: number, sawRefusal: boolean) {
  for (const slot of geekSlots) {
    if (slot < from) continue
    const selected = await geekCredential(env, slot)
    if (!selected) continue
    if (!(await isGeekSlotRefused(env.DB, slot, selected.revision))) return selected
    sawRefusal = true
  }
  throw new PublicError(
    sawRefusal ? 'NO_CREDITS' : 'GEEKBI_UNCONFIGURED',
    sawRefusal ? '已配置的极鲸云凭据组余额不足' : '极鲸云密钥待配置',
    409,
  )
}

export async function geekbiSlotHealth(env: ConnectionBindings, slot: number) {
  const selected = await geekCredential(env, slot)
  if (!selected) return { balanceRefused: false, lastTestedAt: null, testStatus: null }
  const [balanceRefused, test] = await Promise.all([
    isGeekSlotRefused(env.DB, slot, selected.revision),
    env.DB.prepare(
      'SELECT created_at,test_status FROM usage_reservations WHERE credential_slot=? AND credential_revision=? AND test_status IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1',
    )
      .bind(slot, selected.revision)
      .first<{ created_at: string; test_status: 'verified' | 'failed' }>(),
  ])
  return {
    balanceRefused,
    lastTestedAt: test?.created_at ?? null,
    testStatus: test?.test_status ?? null,
  }
}

export async function geekbiSlotUsage(db: D1Database, date = geekDay()) {
  const rows = await db
    .prepare(
      `SELECT credential_slot AS slot,
       SUM(CASE WHEN state='confirmed' THEN actual ELSE 0 END) AS confirmedPoints,
       SUM(CASE WHEN state='confirmed' THEN 0 ELSE reserved END) AS pendingPoints
     FROM usage_reservations WHERE unit='points' AND business_date=? GROUP BY credential_slot`,
    )
    .bind(date)
    .all<{ slot: number; confirmedPoints: number; pendingPoints: number }>()
  return geekSlots.map(
    (slot) =>
      rows.results.find((r) => r.slot === slot) ?? { slot, confirmedPoints: 0, pendingPoints: 0 },
  )
}
