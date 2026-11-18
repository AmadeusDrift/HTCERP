import type { ImageEnvironment } from '../product-images/service'
import { PackApiLabels } from './pack-api-labels'
import { PickingSheets } from './picking-service'
import type { PackBatch } from './pack-types'

function completed(batch: PackBatch): PackBatch {
  if (!batch.newRows) return { ...batch, state: 'NO_NEW' }
  const ready =
    batch.labelGroups?.length &&
    batch.labelGroups.every((g) => g.ready) &&
    batch.pickingGroups?.length &&
    batch.pickingGroups.every((g) => g.ready)
  return { ...batch, state: ready ? 'READY' : 'LABELS_PENDING' }
}
export async function viewPackOutputs(env: ImageEnvironment & { ARCHIVE: R2Bucket }, batch: PackBatch) {
  return completed(await new PickingSheets(env).view(await new PackApiLabels(env).view(batch)))
}
export async function preparePackOutputs(
  env: ImageEnvironment & { ARCHIVE: R2Bucket },
  batch: PackBatch,
) {
  return completed(await new PickingSheets(env).prepare(await new PackApiLabels(env).prepare(batch)))
}
