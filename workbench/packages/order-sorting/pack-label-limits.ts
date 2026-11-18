import { PublicError } from '../contracts/errors'
import type { SortGroup } from './rules'

// Bound work before allocating PDF pages or committing the order deduplication ledger.
export function checkPackLabelQuantity(group: SortGroup) {
  let total = 0
  for (const row of group.raw) {
    total += row[4]
    if (!Number.isSafeInteger(total) || total > 5000)
      throw new PublicError(
        'LABEL_BATCH_TOO_LARGE',
        `分组 ${group.name} 超过单批 5,000 张标签，请减少本次选择的订单。`,
        413,
      )
  }
}
