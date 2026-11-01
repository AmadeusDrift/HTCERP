export const pageSizes = [10, 20, 50, 100] as const
export type Preferences = { view: 'table' | 'grid'; pageSize: (typeof pageSizes)[number] }
export type Preset = { id: string; name: string; filters: Record<string, string> }
export type Personal = Preferences & { presets: Preset[] }
export const initialPreferences: Preferences = { view: 'table', pageSize: 50 }
export const presetLimit = 20
export const filterKeys = [
  'q',
  'platform',
  'market',
  'category',
  'minPrice',
  'maxPrice',
  'minSold',
  'maxSold',
  'minDaySold',
  'maxDaySold',
  'minWeekSold',
  'maxWeekSold',
  'minMonthSold',
  'maxMonthSold',
  'tier',
  'updatedFrom',
  'updatedTo',
  'completeness',
  'stage',
  'line',
  'sort',
  'order',
] as const

export function catalogFilters(params: URLSearchParams) {
  const filters: Preset['filters'] = {}
  for (const key of filterKeys) {
    const value = params.get(key)
    if (value) filters[key] = value
  }
  return filters
}
