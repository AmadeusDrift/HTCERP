import { PublicError } from '../contracts/errors'
import { pdfHash } from '../product-labels/cache'

export type FileEnvironment = { DB: D1Database; ARCHIVE: Pick<R2Bucket, 'get' | 'put'> }
export type CachedFile = { bytes: Uint8Array; metadata: Record<string, string | number> }
type Row = { object_key: string | null; content_sha256: string | null; metadata_json: string | null }
const limit = 32 * 1024 * 1024
const busy = () => new PublicError('IMAGE_CACHE_BUSY', '图片或备货单正在生成，请稍后重试。', 503)
export const fileKey = async (kind: string, parts: unknown) =>
  `product-images/v1/${kind}/${await pdfHash(new TextEncoder().encode(JSON.stringify(parts)))}`

/** Private immutable blobs with a fenced D1 publication, shared by all devices. */
export class PrivateFileCache {
  constructor(private readonly env: FileEnvironment) {}
  async read(key: string): Promise<CachedFile | null> {
    const row = await this.env.DB.prepare(
      'SELECT object_key,content_sha256,metadata_json FROM product_image_cache WHERE cache_key=?',
    )
      .bind(key)
      .first<Row>()
    if (!row?.object_key || !row.content_sha256 || !row.metadata_json) return null
    const object = await this.env.ARCHIVE.get(row.object_key)
    if (object && object.size <= limit) {
      const bytes = new Uint8Array(await object.arrayBuffer())
      if ((await pdfHash(bytes)) === row.content_sha256)
        return { bytes, metadata: JSON.parse(row.metadata_json) }
    }
    await this.env.DB.prepare(
      'UPDATE product_image_cache SET object_key=NULL,content_sha256=NULL,metadata_json=NULL WHERE cache_key=? AND object_key=?',
    )
      .bind(key, row.object_key)
      .run()
    return null
  }
  async getOrCreate(key: string, create: () => Promise<CachedFile>): Promise<CachedFile> {
    const owner = crypto.randomUUID(),
      deadline = Date.now() + 25_000
    for (;;) {
      const existing = await this.read(key)
      if (existing) return existing
      const now = Date.now()
      const claim =
        await this.env.DB.prepare(`INSERT INTO product_image_cache(cache_key,lease_owner,lease_until,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until
        WHERE product_image_cache.object_key IS NULL AND product_image_cache.lease_until<=?`)
          .bind(key, owner, now + 120_000, now, now)
          .run()
      if (claim.meta.changes) {
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let heartbeatWork = Promise.resolve(),
          lost = false
        try {
          heartbeat = setInterval(() => {
            heartbeatWork = heartbeatWork
              .then(async () => {
                const time = Date.now()
                const renewed = await this.env.DB.prepare(
                  'UPDATE product_image_cache SET lease_until=? WHERE cache_key=? AND lease_owner=? AND lease_until>?',
                )
                  .bind(time + 120_000, key, owner, time)
                  .run()
                if (!renewed.meta.changes) lost = true
              })
              .catch(() => {
                lost = true
              })
          }, 30_000)
          const file = await create()
          if (file.bytes.byteLength > limit)
            throw new PublicError('PICKING_TOO_LARGE', '备货单图片较多，请拆分订单批次。', 413)
          const hash = await pdfHash(file.bytes),
            objectKey = `${key}/${owner}`
          await this.env.ARCHIVE.put(objectKey, file.bytes, {
            httpMetadata: { contentType: String(file.metadata.type ?? 'application/octet-stream') },
          })
          if (lost) throw busy()
          const published =
            await this.env.DB.prepare(`UPDATE product_image_cache SET object_key=?,content_sha256=?,metadata_json=?,lease_owner=NULL,lease_until=0,updated_at=?
            WHERE cache_key=? AND lease_owner=? AND lease_until>?`)
              .bind(objectKey, hash, JSON.stringify(file.metadata), Date.now(), key, owner, Date.now())
              .run()
          if (!published.meta.changes) throw busy()
          return file
        } finally {
          if (heartbeat) clearInterval(heartbeat)
          await heartbeatWork
          await this.env.DB.prepare(
            'UPDATE product_image_cache SET lease_owner=NULL,lease_until=0 WHERE cache_key=? AND lease_owner=?',
          )
            .bind(key, owner)
            .run()
        }
      }
      if (Date.now() > deadline) throw busy()
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}
