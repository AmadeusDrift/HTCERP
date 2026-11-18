import type { ImageEnvironment } from '../product-images/service'
import { PackApiLabels } from './pack-api-labels'
import { PickingSheets } from './picking-service'
import type { OrderOutputBatch } from './pack-types'

function completed<T extends OrderOutputBatch>(batch: T): T {
  if (!batch.newRows) return { ...batch, state: 'NO_NEW' }
  const ready =
    batch.labelGroups?.length &&
    batch.labelGroups.every((g) => g.ready) &&
    batch.pickingGroups?.length &&
    batch.pickingGroups.every((g) => g.ready)
  return { ...batch, state: ready ? 'READY' : 'LABELS_PENDING' }
}
export async function viewPackOutputs<T extends OrderOutputBatch>(env: ImageEnvironment & { ARCHIVE: R2Bucket }, batch: T) {
  return completed(await new PickingSheets(env).view(await new PackApiLabels(env).view(batch)))
}
export async function preparePackOutputs<T extends OrderOutputBatch>(
  env: ImageEnvironment & { ARCHIVE: R2Bucket },
  batch: T,
) {
  return completed(await new PickingSheets(env).prepare(await new PackApiLabels(env).prepare(batch)))
}
