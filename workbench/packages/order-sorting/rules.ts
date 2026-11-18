export type Cell = string | number | boolean | null
export type AttributeRow = Cell[]
export type OrderRow = [Cell, string, string, string, number]
export type OrderInput = { date: string; rows: OrderRow[] }
export type SortGroup = {
  name: string
  filename: string
  raw: OrderRow[]
  detail: Cell[][]
  units: number
}
export type SortPlan = {
  date: string
  groups: SortGroup[]
  attributes: AttributeRow[]
  additions: { code: string; sku: string; group: string | null }[]
  filled: number
  totalRows: number
  totalUnits: number
}

const specificGroups: [string[], string][] = [
  [['JA', 'HX'], 'HUJA-SS'],
  [['HUNI-HX'], 'HUNI-SS'],
  [['TLB'], 'HUNI-YW'],
  [['NI', 'ZB'], 'HUNI-YW'],
  [['LQB'], 'HUAB-LQB'],
  [['HUVT.MP'], 'HUVT-WZ'],
  [['VT', 'YKL'], 'HUVT-WZ'],
  [['ZT'], 'HUVT-YW'],
  [['FBB'], 'HUVT-YW'],
  [['LP'], 'HUNI-GL'],
]
const prefixes = ['HUVT', 'HUNI', 'HUAB', 'HUC', 'HUJM']
const text = (value: Cell | undefined): string =>
  value == null ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value)
const category = (value: Cell | undefined): string => (value ? text(value).trim() : '')

export function specificGroup(sku: Cell): string | null {
  const key = text(sku || '').toUpperCase()
  return specificGroups.find(([tokens]) => tokens.every((token) => key.includes(token)))?.[1] ?? null
}

export function productCode(sku: string): string {
  const code = sku.replace(/\.JA(?:-.*)?$/i, '').replace(/-J[1I]T-[^-]+$/i, '')
  return code === sku && /-(?:\d+|[A-Z])$/i.test(code) ? code.slice(0, code.lastIndexOf('-')) : code
}

export function matchAttribute(sku: string, attributes: AttributeRow[]): AttributeRow | null {
  const key = sku.toUpperCase()
  let bestExact = -1
  let bestLength = -1
  let matches: AttributeRow[] = []
  for (const row of attributes) {
    if (!row[2]) continue
    const code = text(row[2]).trim().toUpperCase()
    const exact = Number(key === text(row[3]).trim().toUpperCase())
    if (!(exact || key === code || key.startsWith(`${code}-`) || key.startsWith(`${code}.JA-`))) continue
    if (exact > bestExact || (exact === bestExact && code.length > bestLength)) {
      bestExact = exact
      bestLength = code.length
      matches = [row]
    } else if (exact === bestExact && code.length === bestLength) matches.push(row)
  }
  if (new Set(matches.filter((row) => row[0]).map((row) => row[0])).size > 1)
    throw new Error(`属性清单有冲突分类：${sku}`)
  return matches.find((row) => row[0]) ?? matches[0] ?? null
}

export function sortOrders(order: OrderInput, attributes: AttributeRow[]): SortPlan {
  const suggestions = new Map<AttributeRow | string, Set<string>>()
  const suggest = (key: AttributeRow | string, group: string | null) => {
    if (group) {
      const values = suggestions.get(key) ?? new Set<string>()
      values.add(group)
      suggestions.set(key, values)
    }
  }
  const single = (key: AttributeRow | string): string | null => {
    const values = suggestions.get(key)
    return values?.size === 1 ? [...values][0] : null
  }
  for (const row of attributes) {
    if (row[2] && !category(row[0])) {
      suggest(row, specificGroup(row[2]))
      suggest(row, specificGroup(row[3]))
    }
  }
  const additions = new Map<string, { code: string; sku: string; group: string | null }>()
  const groups = new Map<
    string,
    {
      raw: OrderRow[]
      totals: Map<string, { sku: string; fnsku: string; units: number; attr: AttributeRow | null }>
    }
  >()
  for (const row of order.rows) {
    const sku = row[1].trim()
    const attr = matchAttribute(sku, attributes)
    const recognized = specificGroup(sku)
    if (!attr) {
      const code = productCode(sku)
      const key = code.toUpperCase()
      if (!additions.has(key)) additions.set(key, { code, sku, group: null })
      suggest(key, recognized)
    } else if (!category(attr[0])) suggest(attr, recognized)
    const upper = sku.toUpperCase()
    const name =
      category(attr?.[0]) ||
      recognized ||
      (attr && single(attr)) ||
      (upper.includes('JA') ? 'HUJA' : (prefixes.find((prefix) => upper.startsWith(prefix)) ?? '待确认'))
    if (
      name === '.' ||
      name === '..' ||
      /[<>:"/\\|?*]/.test(name) ||
      [...name].some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error(`分类不能用作文件名：${name}`)
    const group = groups.get(name) ?? {
      raw: [] as OrderRow[],
      totals: new Map<
        string,
        { sku: string; fnsku: string; units: number; attr: AttributeRow | null }
      >(),
    }
    group.raw.push([...row])
    // Aggregate on the original SKU and FNSKU, including original whitespace/case.
    const key = JSON.stringify([row[1], row[2]])
    const total = group.totals.get(key) ?? { sku: row[1], fnsku: row[2], units: 0, attr }
    total.units += row[4]
    group.totals.set(key, total)
    groups.set(name, group)
  }
  const updated = attributes.map((row) => [...row])
  let filled = 0
  attributes.forEach((row, index) => {
    const group = row[2] ? single(row) : null
    if (group) {
      updated[index][0] = group
      filled += 1
    }
  })
  let last = updated.length - 1
  while (last >= 0 && updated[last].every((value) => value === null)) last -= 1
  for (const [key, addition] of additions) {
    addition.group = single(key)
    const row: AttributeRow = Array(11).fill(null)
    row[0] = addition.group
    row[2] = addition.code
    row[3] = addition.sku
    updated[++last] = row
    if (addition.group) filled += 1
  }
  const result: SortGroup[] = [...groups.keys()].sort().map((name) => {
    const group = groups.get(name)!
    const detail = [...group.totals.values()].map(({ sku, fnsku, units, attr }, index): Cell[] => {
      const fields = Array.from({ length: 7 }, (_, i) => attr?.[i + 4] ?? null)
      const r = index + 4
      return [
        index + 1,
        ...fields.slice(0, 3),
        null,
        sku,
        fnsku,
        units,
        fields[3],
        `=IF(I${r}="","",H${r}*I${r})`,
        ...fields.slice(4),
        order.date.replaceAll('-', '/'),
      ]
    })
    return {
      name,
      filename: `${name}-${order.date.slice(2).replaceAll('-', '')}.xlsx`,
      raw: group.raw,
      detail,
      units: group.raw.reduce((sum, row) => sum + row[4], 0),
    }
  })
  return {
    date: order.date,
    groups: result,
    attributes: updated,
    additions: [...additions.values()],
    filled,
    totalRows: order.rows.length,
    totalUnits: order.rows.reduce((sum, row) => sum + row[4], 0),
  }
}
