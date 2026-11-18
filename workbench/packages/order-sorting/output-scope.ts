import { PublicError } from '../contracts/errors'
import { connectionDigest, inventoryDeviceScope } from '../inventory-sync/connection'
import type { OrderOutputBatch } from './pack-types'

export async function orderOutputScope(db: D1Database, batch: OrderOutputBatch) {
  const scope = await inventoryDeviceScope(db)
  const digest = await connectionDigest(
    JSON.stringify([scope.sellerAccountId, scope.marketplaceId, scope.warehouseCode]),
  )
  if (batch.origin === 'MANUAL_EXCEL') {
    if (batch.id.startsWith(`manual-${digest}-`)) return scope
  } else {
    const record = await db.prepare('SELECT scope_key FROM pack_order_batches WHERE id=?')
      .bind(batch.id)
      .first<{ scope_key: string }>()
    if (record?.scope_key === digest) return scope
  }
  throw new PublicError('FORBIDDEN', '本批次不属于当前 Amazon 店铺，不能获取或生成文件。', 403)
}
