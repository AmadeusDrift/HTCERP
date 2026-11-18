import type { SortPlan } from './rules'

export type PackConflict = {
  rowIndex: number
  sku: string
  fnsku: string
  transferId: string
  previousUnits: number
  units: number
}
export type PackLabel = {
  rowIndex: number
  sku: string
  fnsku: string
  transferId: string
  units: number
  group: string
  filename: string
  received: boolean
}
export type PackBatch = {
  id: string
  createdAt: number
  filename: string
  date: string
  state: 'LABELS_PENDING' | 'READY' | 'NO_NEW'
  totalRows: number
  newRows: number
  skippedRows: number
  conflicts: PackConflict[]
  plan: SortPlan | null
  templateKey: string
  labels: PackLabel[]
  sourceHash: string
  labelSource?: 'AMAZON_API'
  labelGroups?: { group: string; ready: boolean }[]
  labelError?: string
  pickingGroups?: { group: string; ready: boolean }[]
  pickingError?: string
}
export type PackDevice = { id: string; scope_json: string }
export type PackBatchPage = { batches: PackBatch[]; next: { time: number; id: string } | null }
export type PackImportInput = { requestId: string; filename: string; base64: string; warehouse: 'A1C5' }
export type PackLabelInput = { rowIndex: number; filename: string; base64: string }
