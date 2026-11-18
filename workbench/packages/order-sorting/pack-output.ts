import type { SortPlan } from './rules'
import { exportGroup } from './workbook'

type Label = { rowIndex: number; group: string; received: boolean }
type OutputBatch = {
  id: string
  state: string
  date: string
  plan: SortPlan | null
  labels: Label[]
  conflicts: unknown[]
  labelSource?: 'AMAZON_API'
  labelGroups?: { group: string; ready: boolean }[]
  pickingGroups?: { group: string; ready: boolean }[]
  exportScope?: 'ALL_ORDERS'
  attributeRevision?: number
}
type ReadLabel = (group: string) => Promise<Uint8Array>

export async function mergePackLabels(
  batch: OutputBatch,
  group: string,
  readLabel: ReadLabel,
): Promise<Uint8Array> {
  if (batch.labelSource !== 'AMAZON_API')
    throw new Error('旧版 Flex 标签不能使用，请刷新 ERP 生成 API 标签。')
  const status = batch.labelGroups?.find((item) => item.group === group)
  if (!status) throw new Error('该分组没有可打印的标签。')
  if (!status.ready) throw new Error('该分组 API 标签尚未生成，请重试生成标签。')
  const bytes = await readLabel(group)
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('标签 PDF 无效。')
  return bytes
}

export async function exportPackBundle(
  batch: OutputBatch,
  template: Uint8Array,
  source: Uint8Array,
  readLabel: ReadLabel,
  readPicking?: (group: string) => Promise<Uint8Array>,
  writeGroup: typeof exportGroup = exportGroup,
): Promise<Uint8Array> {
  if (batch.state !== 'READY' || !batch.plan) throw new Error('本批标签尚未收齐，不能生成完整交付包。')
  if (readPicking && (!batch.pickingGroups?.length || batch.pickingGroups.some(g => !g.ready))) throw new Error('带图备货单尚未完成，请先重试取图。')
  const JSZip = (await import('jszip')).default,
    zip = new JSZip()
  zip.file('原始订单.xlsx', source)
  for (const group of batch.plan.groups) {
    zip.file(`分拣表/${group.filename}`, await writeGroup(template, group, batch.date))
    if (readPicking) zip.file(`带图备货单/${group.filename.replace(/\.xlsx$/i, '-带图备货单.xlsx')}`, await readPicking(group.name))
    zip.file(
      `SKU标签/${group.filename.replace(/\.xlsx$/i, '.pdf')}`,
      await mergePackLabels(batch, group.name, readLabel),
    )
  }
  zip.file(
    '批次说明.json',
    JSON.stringify(
      {
        batchId: batch.id,
        date: batch.date,
        conflicts: batch.conflicts,
        labels: batch.labels,
        exportScope: batch.exportScope ?? 'NEW_ORDERS',
        attributeRevision: batch.attributeRevision,
        rowCount: batch.plan.totalRows,
        units: batch.plan.totalUnits,
        notes:
          (batch.exportScope === 'ALL_ORDERS' ? '包含本次原始文件全部唯一订单项（含历史已导入项），仅合并导出，不重复入账。商品属性取生成时 ERP 清单并保留版本。' : '仅包含本次新增订单。重复项跳过，数量变化项待核对。商品属性取本批分拣清单。') + '带图备货单使用 API 商品主图，图片与备货单缓存于 ERP。标签由 Amazon API 原版与固定欧代模板合成，每件一页 80×80 mm，按实际大小打印。',
      },
      null,
      2,
    ),
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
