import { z } from 'zod'
import { PublicError } from '../contracts/errors'

export const connectionDigest = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('')
const denied = () => new PublicError('UNAUTHORIZED', '登录授权已失效，请重新连接。', 401)
export async function inventoryDeviceScope(db: D1Database) {
  const seller = (
    await db
      .prepare('SELECT seller FROM title_audit_store WHERE singleton=1')
      .first<{ seller: string }>()
  )?.seller
  if (!seller) throw new PublicError('NOT_CONFIGURED', '请先设置 Amazon 店铺。', 409)
  return { sellerAccountId: seller, marketplaceId: 'ATVPDKIKX0DER', warehouseCode: 'A1C5' }
}
type ConnectionActor = { id: string; username: string; role: string }
export class InventoryConnection {
  constructor(private readonly db: D1Database) {}
  async session(actor: ConnectionActor) {
    if (actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可以连接设备。', 403)
    return {
      actor: { id: actor.id, displayName: actor.username, role: actor.role },
      scope: await inventoryDeviceScope(this.db),
    }
  }
  async authorize(actor: ConnectionActor, sessionHash: string | null, input: unknown, now: number) {
    const { scope } = await this.session(actor)
    if (!sessionHash) throw denied()
    const data = z
      .object({
        requestId: z.uuid(),
        challenge: z.string().regex(/^[a-f0-9]{64}$/),
        name: z.string().trim().min(1).max(80),
      })
      .strict()
      .parse(input)
    const grantId = crypto.randomUUID()
    const deviceId = await connectionDigest('inventory-device-id:v1:' + grantId)
    await this.db
      .prepare(`INSERT INTO inventory_connection_grants(id,request_id,actor_id,session_hash,scope_json,challenge,name,created_at,expires_at,device_id)
      SELECT ?,?,a.id,s.token_hash,?,?,?,?,?,? FROM accounts a JOIN account_sessions s ON s.account_id=a.id AND s.auth_version=a.auth_version
      WHERE a.id=? AND a.role='admin' AND a.active=1 AND s.token_hash=? AND s.expires_at>?
      AND EXISTS(SELECT 1 FROM title_audit_store WHERE singleton=1 AND seller=?)
      ON CONFLICT(request_id) DO NOTHING`)
      .bind(
        grantId,
        data.requestId,
        JSON.stringify(scope),
        data.challenge,
        data.name,
        now,
        now + 120000,
        deviceId,
        actor.id,
        sessionHash,
        Math.floor(now / 1000),
        scope.sellerAccountId,
      )
      .run()
    const saved = await this.db
      .prepare(`SELECT g.* FROM inventory_connection_grants g
      JOIN accounts a ON a.id=g.actor_id JOIN account_sessions s ON s.token_hash=g.session_hash AND s.account_id=a.id AND s.auth_version=a.auth_version
      WHERE g.request_id=? AND g.actor_id=? AND g.session_hash=? AND g.scope_json=? AND g.challenge=? AND g.name=? AND g.expires_at>?
      AND s.expires_at>? AND a.active=1 AND a.role='admin'`)
      .bind(
        data.requestId,
        actor.id,
        sessionHash,
        JSON.stringify(scope),
        data.challenge,
        data.name,
        now,
        Math.floor(now / 1000),
      )
      .first<{ id: string; expires_at: number }>()
    if (!saved) throw denied()
    return { grantId: saved.id, expiresAt: saved.expires_at, scope }
  }
  async connect(input: unknown, now: number) {
    const data = z
      .object({ grantId: z.uuid(), verifier: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(input)
    const challenge = await connectionDigest(data.verifier)
    const token = await connectionDigest(
      'inventory-device-token:v1:' + data.grantId + ':' + data.verifier,
    )
    const tokenHash = await connectionDigest(token)
    const scope = await inventoryDeviceScope(this.db)
    const validGrant = `FROM inventory_connection_grants g JOIN accounts a ON a.id=g.actor_id
      JOIN account_sessions s ON s.token_hash=g.session_hash AND s.account_id=a.id AND s.auth_version=a.auth_version
      WHERE g.id=? AND g.challenge=? AND g.scope_json=? AND g.expires_at>?
      AND a.role='admin' AND a.active=1 AND s.expires_at>?
      AND EXISTS(SELECT 1 FROM title_audit_store WHERE singleton=1 AND seller=?)`
    const args = [
      data.grantId,
      challenge,
      JSON.stringify(scope),
      now,
      Math.floor(now / 1000),
      scope.sellerAccountId,
    ]
    await this.db
      .prepare(`INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at)
      SELECT g.device_id,?,g.name,g.scope_json,? ${validGrant} ON CONFLICT(id) DO NOTHING`)
      .bind(tokenHash, now, ...args)
      .run()
    // Stable proof-derived token allows response-loss retry; revoked rows are never replaced.
    const saved = await this.db
      .prepare(`SELECT g.device_id ${validGrant}
      AND EXISTS(SELECT 1 FROM inventory_devices d WHERE d.id=g.device_id AND d.token_hash=? AND d.scope_json=g.scope_json AND d.revoked_at IS NULL)`)
      .bind(...args, tokenHash)
      .first<{ device_id: string }>()
    if (!saved) throw denied()
    return { deviceId: saved.device_id, token, mode: 'SIMULATION' as const, scope, pollSeconds: 60 }
  }
}
