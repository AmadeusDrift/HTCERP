import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { type ReceiveRow, receiveFile } from './receive-file'

const unauthorized = () => new PublicError('UNAUTHORIZED', '设备凭据无效或已失效。', 401)
const conflict = () => new PublicError('CONFLICT', '联调任务或文件校验不一致。', 409)
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}
type Scope = { sellerAccountId: string; marketplaceId: string; warehouseCode: string }
type Device = { id: string; scope_json: string }
type TestJob = { id: string; nonce: string; rows_json: string; expected_hash: string; state: string }
const jobView = (job: TestJob) => ({
  id: job.id,
  nonce: job.nonce,
  mode: 'SIMULATION' as const,
  rows: JSON.parse(job.rows_json) as ReceiveRow[],
})

/** Transport intentionally exposes no operation against real replenishment jobs. */
export class InventoryDevices {
  constructor(private readonly db: D1Database) {}

  private async scope(): Promise<Scope> {
    const store = await this.db
      .prepare('SELECT seller FROM title_audit_store WHERE singleton=1')
      .first<{ seller: string }>()
    if (!store?.seller)
      throw new PublicError('NOT_CONFIGURED', '请先在现有 Amazon 连接中设置店铺。', 409)
    // Current interface confirmed in the handoff; pairing never accepts arbitrary client scope.
    return { sellerAccountId: store.seller, marketplaceId: 'ATVPDKIKX0DER', warehouseCode: 'A1C5' }
  }

  async createPair(actor: string, now: number) {
    const code = random(),
      expiresAt = now + 600_000
    await this.db
      .prepare(
        'INSERT INTO inventory_device_pairs(code_hash,scope_json,expires_at,actor) VALUES(?,?,?,?)',
      )
      .bind(await digest(code), JSON.stringify(await this.scope()), expiresAt, actor)
      .run()
    return { code, expiresAt, mode: 'SIMULATION' as const }
  }

  async pair(input: unknown, now: number) {
    const data = z
      .object({ code: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(input)
    const scope = JSON.stringify(await this.scope())
    const token = random()
    // Single SQL statement atomically consumes a code through the device id: the token_hash is
    // secret-derived and this uniqueness gate prevents races, including across Worker instances.
    const paired = await this.db
      .prepare(`INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at)
      SELECT code_hash,?,?,scope_json,? FROM inventory_device_pairs
      WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL AND scope_json=?
      ON CONFLICT(id) DO NOTHING RETURNING id,scope_json`)
      .bind(await digest(token), data.name, now, await digest(data.code), now, scope)
      .first<Device>()
    if (!paired) throw unauthorized()
    await this.db
      .prepare('UPDATE inventory_device_pairs SET consumed_at=? WHERE code_hash=?')
      .bind(now, paired.id)
      .run()
    // Pair-code hash is an opaque stable identifier, never the code itself.
    return {
      deviceId: paired.id,
      token,
      mode: 'SIMULATION' as const,
      scope: JSON.parse(paired.scope_json) as Scope,
      pollSeconds: 60,
    }
  }

  async authenticate(token: string, now: number) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw unauthorized()
    const device = await this.db
      .prepare('SELECT id,scope_json FROM inventory_devices WHERE token_hash=? AND revoked_at IS NULL')
      .bind(await digest(token))
      .first<Device>()
    if (!device || device.scope_json !== JSON.stringify(await this.scope())) throw unauthorized()
    await this.db
      .prepare('UPDATE inventory_devices SET last_seen=? WHERE id=? AND revoked_at IS NULL')
      .bind(now, device.id)
      .run()
    return device
  }

  async list() {
    const scope = JSON.stringify(await this.scope())
    const devices = await this.db
      .prepare(`SELECT id,name,paired_at,last_seen,revoked_at,
      (SELECT MAX(completed_at) FROM inventory_device_tests WHERE device_id=inventory_devices.id AND state='PASSED') AS last_test_passed
      FROM inventory_devices WHERE scope_json=? ORDER BY paired_at DESC LIMIT 100`)
      .bind(scope)
      .all()
    return devices.results
  }

  async revoke(id: string, now: number) {
    const changed = await this.db
      .prepare(`UPDATE inventory_devices SET revoked_at=? WHERE id=? AND scope_json=?
        AND NOT EXISTS(SELECT 1 FROM inventory_live_trials WHERE device_id=inventory_devices.id AND ended_at IS NULL) RETURNING id`)
      .bind(now, id, JSON.stringify(await this.scope()))
      .first()
    if (!changed)
      throw new PublicError('CONFLICT', '请先将当前任务切换到另一台执行设备，再撤销连接。', 409)
    return { revoked: true }
  }

  async createTest(id: string, now: number) {
    const rows: ReceiveRow[] = [
      {
        rowId: 'simulation-jit',
        sku: 'SIMULATION-JIT-ONLY',
        binCode: 'Default',
        quantity: 2,
        disposition: 'GOOD',
      },
      {
        rowId: 'simulation-j1t',
        sku: 'SIMULATION-J1T-ONLY',
        binCode: 'Default',
        quantity: 5,
        disposition: 'GOOD',
      },
    ]
    const file = await receiveFile(rows)
    const scope = JSON.stringify(await this.scope())
    await this.db
      .prepare(`INSERT INTO inventory_device_tests(id,device_id,nonce,rows_json,expected_hash,state,created_at)
      SELECT ?,id,?,?,?,'PENDING',? FROM inventory_devices WHERE id=? AND revoked_at IS NULL AND scope_json=?
      ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), JSON.stringify(rows), file.sha256, now, id, scope)
      .run()
    const job = await this.db
      .prepare(`SELECT t.* FROM inventory_device_tests t JOIN inventory_devices d ON d.id=t.device_id
      WHERE t.device_id=? AND t.state='PENDING' AND d.revoked_at IS NULL AND d.scope_json=?`)
      .bind(id, scope)
      .first<TestJob>()
    if (!job) throw conflict()
    return jobView(job)
  }

  async work(device: Device) {
    const job = await this.db
      .prepare(
        "SELECT * FROM inventory_device_tests WHERE device_id=? AND state='PENDING' ORDER BY created_at LIMIT 1",
      )
      .bind(device.id)
      .first<TestJob>()
    return { job: job ? jobView(job) : null, mode: 'SIMULATION' as const }
  }

  async result(device: Device, input: unknown, now: number) {
    const result = z
      .object({
        jobId: z.uuid(),
        nonce: z.uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        rowCount: z.number().int().min(1).max(3000),
        mode: z.literal('SIMULATION'),
      })
      .strict()
      .parse(input)
    const job = await this.db
      .prepare('SELECT * FROM inventory_device_tests WHERE id=? AND device_id=?')
      .bind(result.jobId, device.id)
      .first<TestJob>()
    if (
      !job ||
      job.nonce !== result.nonce ||
      job.expected_hash !== result.sha256 ||
      JSON.parse(job.rows_json).length !== result.rowCount
    )
      throw conflict()
    await this.db
      .prepare(
        "UPDATE inventory_device_tests SET state='PASSED',completed_at=?,result_json=? WHERE id=? AND state='PENDING'",
      )
      .bind(now, JSON.stringify(result), job.id)
      .run()
    return { state: 'PASSED', mode: 'SIMULATION' }
  }
}
