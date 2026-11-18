import type { Bindings } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { connectionDigest, inventoryDeviceScope } from '../inventory-sync/connection'
import { PackApiLabels } from './pack-api-labels'
import { preparePackOutputs, viewPackOutputs } from './pack-prepare'
import type { OrderOutputBatch } from './pack-types'
import { PickingSheets } from './picking-service'
import { OrderSorting } from './service'

export type ManualFactoryStatus = Pick<
  OrderOutputBatch,
  'state' | 'labelGroups' | 'pickingGroups' | 'labelError' | 'pickingError'
>

export class ManualFactory {
  constructor(private readonly env: Bindings) {}

  private async load(id: string) {
    const run = await new OrderSorting(this.env).getRun(id)
    const scope = await inventoryDeviceScope(this.env.DB)
    const digest = await connectionDigest(
      JSON.stringify([scope.sellerAccountId, scope.marketplaceId, scope.warehouseCode]),
    )
    const batch: OrderOutputBatch = {
      id: `manual-${digest}-${run.id}`,
      origin: 'MANUAL_EXCEL',
      date: run.plan.date,
      plan: run.plan,
      newRows: run.plan.totalRows,
      state: 'LABELS_PENDING',
    }
    return { batch, plan: run.plan }
  }

  async status(id: string): Promise<ManualFactoryStatus> {
    const { batch } = await this.load(id)
    return fileStatus(await viewPackOutputs(this.env, batch))
  }

  async prepareGroup(id: string, name: string, kind?: 'picking' | 'labels') {
    const { batch, plan } = await this.load(id)
    const group = plan.groups.find((item) => item.name === name)
    if (!group) throw new PublicError('NOT_FOUND', '没有找到该分拣组。', 404)
    batch.plan = { ...plan, groups: [group], totalRows: group.raw.length, totalUnits: group.units }
    batch.newRows = group.raw.length
    return async () => {
      if (kind === 'picking') return fileStatus(await new PickingSheets(this.env).prepare(batch))
      if (kind === 'labels') return fileStatus(await new PackApiLabels(this.env).prepare(batch))
      return fileStatus(await preparePackOutputs(this.env, batch))
    }
  }

  async groupFile(id: string, group: string, kind: 'picking' | 'labels') {
    const { batch } = await this.load(id)
    return kind === 'picking'
      ? new PickingSheets(this.env).download(batch, group, true)
      : new PackApiLabels(this.env).download(batch, group, true)
  }
}

function fileStatus({
  state, labelGroups, pickingGroups, labelError, pickingError,
}: OrderOutputBatch): ManualFactoryStatus {
  return { state, labelGroups, pickingGroups, labelError, pickingError }
}
