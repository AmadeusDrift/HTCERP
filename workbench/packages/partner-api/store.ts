import { PublicError } from '../contracts/errors'
import type { SourceIdentity } from '../inventory-sync/source'
import {
  conflict,
  forbidden,
  marketplace,
  missing,
  type Permission,
  permissions,
  type WriteInput,
  type WritePermission,
} from './permissions'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export async function hash(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}
const newToken = () => 'htc_' + hex(crypto.getRandomValues(new Uint8Array(32)))
const currentSeller = '(SELECT seller FROM title_audit_store WHERE singleton=1)'
const publicClientFields = 'id,name,seller,marketplace,active,revision,expires_at,created_at'
const clientFields = publicClientFields + ',amazon_revision'
const unauthorized = () => new PublicError('UNAUTHORIZED', '接入凭据无效、过期或已停用。', 401)
export type Client = {
  id: string
  name: string
  seller: string
  marketplace: typeof marketplace
  active: number
  revision: number
  expires_at: number
  created_at: number
  amazon_revision: string
}
export type PartnerRequest = {
  id: string
  client_id: string
  operation: WritePermission
  input_json: string
  status:
    | 'PENDING'
    | 'APPROVED'
    | 'SENDING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'UNKNOWN'
    | 'CANCELLED'
    | 'CONFIRMED'
  created_at: number
  reviewed_at: number | null
  reviewer: string | null
  reference: string | null
  outcome: string | null
}
const requestFields =
  'id,client_id,operation,input_json,status,created_at,reviewed_at,reviewer,reference,outcome'
export const requestView = (r: PartnerRequest) => ({
  id: r.id,
  operation: r.operation,
  status: r.status,
  createdAt: r.created_at,
  reviewedAt: r.reviewed_at,
  reference: r.reference,
  outcome: r.outcome,
})

export class PartnerStore {
  constructor(readonly db: D1Database) {}

  async create(name: string, days: number, identity: SourceIdentity) {
    const { seller, revision } = identity
    const id = crypto.randomUUID(),
      token = newToken(),
      now = Date.now()
    const grants = (Object.keys(permissions) as Permission[]).filter((p) => permissions[p].default)
    const expiresAt = now + days * 86400000
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO partner_clients(id,name,seller,marketplace,token_hash,amazon_revision,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(id, name, seller, marketplace, await hash(token), revision, expiresAt, now),
      this.db.prepare('INSERT OR IGNORE INTO partner_seller_keys VALUES(?,?)').bind(seller, newToken()),
      ...grants.map((p) =>
        this.db
          .prepare('INSERT INTO partner_permissions VALUES(?,?,?)')
          .bind(id, p, crypto.randomUUID()),
      ),
    ])
    return { id, token, seller, marketplace, expiresAt, permissions: grants }
  }

  async settings() {
    return this.db
      .prepare('SELECT writes,revision FROM partner_settings WHERE singleton=1')
      .first<{ writes: number; revision: number }>()
  }

  async overview(currentRevision: string | undefined, clientId?: string, before?: number) {
    const [settings, clients, grants, requests, audit] = await Promise.all([
      this.settings(),
      this.db
        .prepare('SELECT ' + clientFields + ' FROM partner_clients ORDER BY created_at DESC')
        .all<Client>(),
      this.db
        .prepare('SELECT client_id,permission FROM partner_permissions')
        .all<{ client_id: string; permission: Permission }>(),
      this.db
        .prepare(
          'SELECT ' +
            requestFields +
            ` FROM partner_requests
        ORDER BY status NOT IN ('PENDING','SENDING','ACCEPTED','UNKNOWN'),created_at DESC,id DESC LIMIT 100`,
        )
        .all<PartnerRequest>(),
      this.db
        .prepare(
          'SELECT * FROM partner_audit WHERE (? IS NULL OR client_id=?) AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 100',
        )
        .bind(clientId ?? null, clientId ?? null, before ?? Number.MAX_SAFE_INTEGER)
        .all<{ created_at: number }>(),
    ])
    return {
      writesEnabled: settings?.writes === 1,
      permissions,
      clients: clients.results.map(({ amazon_revision, ...client }) => ({
        ...client,
        linked: amazon_revision === currentRevision,
        permissions: grants.results.filter((g) => g.client_id === client.id).map((g) => g.permission),
      })),
      requests: requests.results.map((r) => ({
        ...requestView(r),
        clientId: r.client_id,
        input: JSON.parse(r.input_json),
        reviewer: r.reviewer,
      })),
      audit: audit.results,
      auditBefore: audit.results.length === 100 ? audit.results[99].created_at : null,
    }
  }

  async authenticate(request: Request) {
    const token = /^Bearer (htc_[a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token || new URL(request.url).protocol !== 'https:') throw unauthorized()
    const client = await this.db
      .prepare('SELECT ' + clientFields + ' FROM partner_clients WHERE token_hash=?')
      .bind(await hash(token))
      .first<Client>()
    if (!client) throw unauthorized()
    return client
  }

  async active(client: Client) {
    return !!(await this.db
      .prepare(`SELECT 1 FROM partner_clients WHERE id=? AND active=1
      AND seller=${currentSeller} AND revision=? AND expires_at>?`)
      .bind(client.id, client.revision, Date.now())
      .first())
  }

  async allowed(client: Client, permission: Permission) {
    if (!(await this.active(client))) throw unauthorized()
    const grant = await this.db
      .prepare(`SELECT 1 FROM partner_permissions p, partner_settings s
      WHERE p.client_id=? AND p.permission=? AND (?=0 OR s.writes=1)`)
      .bind(client.id, permission, Number(permissions[permission].mode === 'write'))
      .first()
    if (!grant) throw forbidden()
  }

  async quota(id: string, bucket: 'requests' | 'writes', limit: number) {
    const now = Math.floor(Date.now() / 60000)
    const row = await this.db
      .prepare(`INSERT INTO partner_quota VALUES(?,?,?,1)
      ON CONFLICT(client_id,bucket) DO UPDATE SET window=excluded.window,
      used=CASE WHEN partner_quota.window=excluded.window THEN partner_quota.used+1 ELSE 1 END
      WHERE partner_quota.window<>excluded.window OR partner_quota.used<? RETURNING used`)
      .bind(id, bucket, now, limit)
      .first()
    if (!row) throw new PublicError('RATE_LIMIT', '此接入方请求过于频繁。', 429, 'workbench', true)
  }

  async audit(
    id: string,
    clientId: string | null,
    actor: string | null,
    operation: string,
    scope: string | null,
    status: number,
    count: number | null,
  ) {
    await this.db
      .prepare(`INSERT INTO partner_audit VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,row_count=excluded.row_count`)
      .bind(
        id,
        clientId,
        actor,
        operation,
        scope?.replace(/htc_[a-f0-9]{64}|(?:Atzr|Atza|Aztr)\|[^\s"]+/gi, '[redacted]').slice(0, 250) ??
          null,
        status,
        count,
        Date.now(),
      )
      .run()
  }

  async setWrites(enabled: boolean) {
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE partner_settings SET writes=?,revision=revision+1 WHERE singleton=1 AND writes<>?',
        )
        .bind(+enabled, +enabled),
      this.db
        .prepare(
          "UPDATE partner_requests SET status='CANCELLED',outcome='WRITE_DISABLED' WHERE status='PENDING' AND ?=0",
        )
        .bind(+enabled),
    ])
  }

  async requireClient(id: string) {
    const client = await this.db
      .prepare('SELECT ' + clientFields + ' FROM partner_clients WHERE id=?')
      .bind(id)
      .first<Client>()
    if (!client) throw missing()
    return client
  }

  async setPermission(id: string, permission: Permission, enabled: boolean) {
    await this.requireClient(id)
    const change = enabled
      ? this.db
          .prepare('INSERT OR IGNORE INTO partner_permissions VALUES(?,?,?)')
          .bind(id, permission, crypto.randomUUID())
      : this.db
          .prepare('DELETE FROM partner_permissions WHERE client_id=? AND permission=?')
          .bind(id, permission)
    await this.db.batch([
      change,
      this.db
        .prepare(`UPDATE partner_requests SET status='CANCELLED',outcome='PERMISSION_CHANGED'
        WHERE client_id=? AND operation=? AND status='PENDING' AND ?=0`)
        .bind(id, permission, +enabled),
    ])
  }

  async setActive(id: string, enabled: boolean) {
    await this.requireClient(id)
    await this.db.batch([
      this.db
        .prepare('UPDATE partner_clients SET active=?,revision=revision+1 WHERE id=? AND active<>?')
        .bind(+enabled, id, +enabled),
      this.db
        .prepare(
          "UPDATE partner_requests SET status='CANCELLED',outcome='CLIENT_PAUSED' WHERE client_id=? AND status='PENDING' AND ?=0",
        )
        .bind(id, +enabled),
    ])
  }

  async rotate(id: string, days: number, identity: SourceIdentity) {
    const client = await this.requireClient(id)
    if (client.seller !== identity.seller) throw conflict()
    const token = newToken(),
      expiresAt = Date.now() + days * 86400000
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE partner_clients SET token_hash=?,amazon_revision=?,expires_at=?,revision=revision+1 WHERE id=?',
        )
        .bind(await hash(token), identity.revision, expiresAt, id),
      this.db
        .prepare(
          "UPDATE partner_requests SET status='CANCELLED',outcome='TOKEN_ROTATED' WHERE client_id=? AND status='PENDING'",
        )
        .bind(id),
    ])
    return { token, expiresAt }
  }

  async submit(client: Client, operation: WritePermission, key: string, data: WriteInput) {
    const json = JSON.stringify(data)
    const stored = await this.db
      .prepare(`INSERT INTO partner_requests
      (id,client_id,operation,idempotency_key,input_json,client_revision,write_revision,permission_revision,created_at)
      SELECT ?,c.id,?,?,?,c.revision,s.revision,p.revision,? FROM partner_clients c
      JOIN partner_permissions p ON p.client_id=c.id CROSS JOIN partner_settings s
      WHERE c.id=? AND c.active=1 AND c.revision=? AND c.expires_at>? AND c.seller=${currentSeller}
        AND s.writes=1 AND p.permission=?
      ON CONFLICT(client_id,idempotency_key) DO NOTHING RETURNING ${requestFields}`)
      .bind(
        crypto.randomUUID(),
        operation,
        key,
        json,
        Date.now(),
        client.id,
        client.revision,
        Date.now(),
        operation,
      )
      .first<PartnerRequest>()
    if (stored) return requestView(stored)
    await this.allowed(client, operation)
    const original = await this.db
      .prepare(
        'SELECT ' + requestFields + ' FROM partner_requests WHERE client_id=? AND idempotency_key=?',
      )
      .bind(client.id, key)
      .first<PartnerRequest>()
    if (!original || original.operation !== operation || original.input_json !== json) throw conflict()
    return requestView(original)
  }

  async request(id: string) {
    const row = await this.db
      .prepare('SELECT ' + requestFields + ' FROM partner_requests WHERE id=?')
      .bind(id)
      .first<PartnerRequest>()
    if (!row) throw missing()
    return row
  }

  async claim(id: string, reviewer: string, next: 'APPROVED' | 'SENDING') {
    const now = Date.now()
    const row = await this.db
      .prepare(`UPDATE OR IGNORE partner_requests AS r SET status=?,reviewer=?,reviewed_at=?
      WHERE r.id=? AND r.status='PENDING' AND EXISTS(SELECT 1
        FROM partner_clients c JOIN partner_permissions p ON p.client_id=c.id CROSS JOIN partner_settings s
        WHERE c.id=r.client_id AND c.revision=r.client_revision AND s.revision=r.write_revision
          AND c.active=1 AND c.expires_at>? AND c.seller=${currentSeller} AND s.writes=1 AND p.permission=r.operation
          AND p.revision=r.permission_revision)
      RETURNING ${requestFields}`)
      .bind(next, reviewer, now, id, now)
      .first<PartnerRequest>()
    if (!row) throw conflict()
    return row
  }

  async canSend(id: string) {
    return !!(await this.db
      .prepare(`SELECT 1 FROM partner_requests r
      JOIN partner_clients c ON c.id=r.client_id JOIN partner_permissions p ON p.client_id=c.id AND p.permission=r.operation
      CROSS JOIN partner_settings s WHERE r.id=? AND r.status='SENDING'
      AND c.active=1 AND c.revision=r.client_revision AND c.expires_at>? AND c.seller=${currentSeller}
      AND s.writes=1 AND s.revision=r.write_revision AND p.revision=r.permission_revision`)
      .bind(id, Date.now())
      .first())
  }

  async finish(
    id: string,
    from: PartnerRequest['status'],
    status: PartnerRequest['status'],
    outcome: string,
    reference: string | null = null,
  ) {
    const row = await this.db
      .prepare(`UPDATE partner_requests SET status=?,outcome=?,reference=coalesce(?,reference)
      WHERE id=? AND status=? RETURNING ${requestFields}`)
      .bind(status, outcome, reference, id, from)
      .first<PartnerRequest>()
    if (!row) throw conflict()
    return row
  }

  async reject(id: string, reviewer: string) {
    const row = await this.db
      .prepare(`UPDATE partner_requests SET status='REJECTED',outcome='ADMIN_REJECTED',reviewer=?,reviewed_at=?
      WHERE id=? AND status='PENDING' RETURNING ${requestFields}`)
      .bind(reviewer, Date.now(), id)
      .first<PartnerRequest>()
    if (!row) throw conflict()
    return row
  }

  async readCursor(id: string | undefined, client: Client, operation: Permission, scope: string) {
    if (!id) return undefined
    const value = await this.db
      .prepare(`SELECT upstream FROM partner_cursors WHERE id=? AND client_id=? AND revision=?
      AND operation=? AND scope=? AND expires_at>?`)
      .bind(id, client.id, client.revision, operation, scope, Date.now())
      .first<string>('upstream')
    if (!value) throw new PublicError('CURSOR_EXPIRED', '分页已失效，请从该时间段第一页重新读取。', 409)
    return value
  }

  async saveCursor(
    upstream: string | undefined | null,
    client: Client,
    operation: Permission,
    scope: string,
  ) {
    if (!upstream) return null
    const now = Date.now(),
      id = crypto.randomUUID()
    await this.db.batch([
      this.db.prepare('DELETE FROM partner_cursors WHERE expires_at<?').bind(now),
      this.db
        .prepare('INSERT INTO partner_cursors VALUES(?,?,?,?,?,?,?)')
        .bind(id, client.id, client.revision, operation, scope, upstream, now + 1800000),
    ])
    return id
  }
}
