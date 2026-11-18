import { PublicError } from '../contracts/errors'

export type LabelCacheEnvironment = {
  DB: D1Database
  ARCHIVE: Pick<R2Bucket, 'get' | 'put'>
}

type CacheRow = { r2_key: string | null; content_sha256: string | null }
const leaseMs = 90_000
const waitMs = 60_000
const maxCacheBytes = 32 * 1024 * 1024
const busy = () =>
  new PublicError('PRODUCT_LABEL_CACHE_BUSY', '商品标签正在生成，请稍后重新下载。', 503, 'amazon', true)

export async function pdfHash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function labelCacheKey(kind: 'original' | 'merged', value: unknown) {
  return `product-labels/cache/v1/${kind}/${await pdfHash(new TextEncoder().encode(JSON.stringify(value)))}`
}

/** D1 leases coordinate Workers; immutable R2 blobs are exposed only by a fenced D1 publish. */
export class LabelCache {
  private readonly owner = crypto.randomUUID()
  private heartbeat?: ReturnType<typeof setInterval>
  private heartbeatWork: Promise<void> = Promise.resolve()
  private heartbeatFailed = false

  constructor(private readonly env: LabelCacheEnvironment) {}

  async read(key: string): Promise<Uint8Array | null> {
    const row = await this.env.DB.prepare(
      'SELECT r2_key,content_sha256 FROM product_label_cache WHERE cache_key=?',
    )
      .bind(key)
      .first<CacheRow>()
    if (!row?.r2_key || !row.content_sha256) return null
    const object = await this.env.ARCHIVE.get(row.r2_key)
    if (object && object.size <= maxCacheBytes) {
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (bytes.byteLength <= maxCacheBytes && (await pdfHash(bytes)) === row.content_sha256)
        return bytes
    }
    // Missing or damaged objects must never be served or keep a stale cache entry pinned.
    await this.env.DB.prepare(`UPDATE product_label_cache SET r2_key=NULL,content_sha256=NULL
      WHERE cache_key=? AND r2_key=?`)
      .bind(key, row.r2_key)
      .run()
    return null
  }

  async claim(key: string) {
    if (this.heartbeatFailed) throw busy()
    const now = Date.now()
    const result = await this.env.DB.prepare(`INSERT INTO product_label_cache
      (cache_key,r2_key,content_sha256,lease_owner,lease_until,updated_at) VALUES (?,NULL,NULL,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET lease_owner=excluded.lease_owner,
        lease_until=excluded.lease_until,updated_at=excluded.updated_at
      WHERE product_label_cache.r2_key IS NULL AND product_label_cache.lease_until<=?`)
      .bind(key, this.owner, now + leaseMs, now, now)
      .run()
    if (!result.meta.changes) return false
    if (!this.heartbeat)
      this.heartbeat = setInterval(() => {
        this.heartbeatWork = this.heartbeatWork
          .then(async () => {
            const time = Date.now()
            await this.env.DB.prepare(`UPDATE product_label_cache SET lease_until=?,updated_at=?
          WHERE lease_owner=? AND lease_until>?`)
              .bind(time + leaseMs, time, this.owner, time)
              .run()
          })
          .catch(() => {
            this.heartbeatFailed = true
          })
      }, 20_000)
    return true
  }

  async publish(key: string, bytes: Uint8Array) {
    if (this.heartbeatFailed) throw busy()
    if (bytes.byteLength > maxCacheBytes)
      throw new PublicError('PRODUCT_LABEL_PDF_TOO_LARGE', '标签文件过大，请减少单次下载件数。', 413)
    const sha = await pdfHash(bytes)
    const r2Key = `${key}/${this.owner}.pdf`
    await this.env.ARCHIVE.put(r2Key, bytes, { httpMetadata: { contentType: 'application/pdf' } })
    const now = Date.now()
    const result = await this.env.DB.prepare(`UPDATE product_label_cache SET r2_key=?,content_sha256=?,
      lease_owner=NULL,lease_until=0,updated_at=? WHERE cache_key=? AND lease_owner=? AND lease_until>?`)
      .bind(r2Key, sha, now, key, this.owner, now)
      .run()
    if (!result.meta.changes) throw busy()
    return bytes
  }

  async getOrCreate(key: string, create: () => Promise<Uint8Array>) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const cached = await this.read(key)
      if (cached) return cached
      if (await this.claim(key)) return this.publish(key, await create())
      if (Date.now() >= deadline) throw busy()
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    await this.heartbeatWork
    // Failed producers release immediately. Completed rows have already cleared their owner.
    await this.env.DB.prepare(`UPDATE product_label_cache SET lease_owner=NULL,lease_until=0
      WHERE lease_owner=?`)
      .bind(this.owner)
      .run()
  }
}
