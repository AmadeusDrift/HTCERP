import { daysBefore, salesDay, skuIsJit } from './report'

export interface HaulSaleOrder {
  id: string
  items: { id: string; sku: string | null; units: number }[]
}

export const dailySalesTeams = ['a', 'b', 'c'] as const
export type DailySalesGroups = Record<(typeof dailySalesTeams)[number], string[]>
const teamLabels = { a: 'A 组', b: 'B 组', c: 'C 组' } as const
type Counts = { units: number }
type SalesWindow = { start: string; end: string }
export interface DailySalesReport extends Record<keyof DailySalesGroups, Counts | null> {
  date: string
  haul: Counts
  jit: Counts
  teamJit: Record<keyof DailySalesGroups, Counts | null>
  jimei: Counts & { marker?: 'J1T'; includedInJit?: true }
  unassignedUnits: number
  window?: SalesWindow
  previousUnits?: number
  previousJitUnits?: number
  previousYearUnits?: number | null
}

const laOffset = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  timeZoneName: 'shortOffset',
})

function midnight(day: string) {
  const utc = Date.parse(day + 'T00:00:00Z')
  const offset = (time: number) =>
    Number(laOffset.formatToParts(time).find((part) => part.type === 'timeZoneName')?.value.slice(3))
  // Use the offset at local midnight, which may differ from the offset at UTC midnight.
  return new Date(utc - offset(utc - offset(utc) * 3600000) * 3600000).toISOString()
}

export function dailySalesWindow(date: string) {
  return { start: midnight(date), end: midnight(daysBefore(date, -1)) }
}

export const lastSalesDay = (now: number) => daysBefore(salesDay(new Date(now)), 1)
export const skuIsJimei = (sku: string) => /j1t/i.test(sku)

export function scheduledSalesWindow(tick: number) {
  const end = new Date(tick)
  const hour = end.getUTCHours()
  // Beijing 23:00, 07:00, 12:00 and 16:00, all measured from Beijing 16:00.
  const hours = new Map([[15, 7], [23, 15], [4, 20], [8, 24]]).get(hour)
  if (end.getUTCMinutes() !== 0 || hours === undefined) return null
  const cutoff = end.setUTCMinutes(0, 0, 0)
  const start = cutoff - hours * 3600000
  const day = 86400000
  return {
    start: new Date(start).toISOString(),
    end: end.toISOString(),
    includeDaily: hours === 24,
    previous: { start: new Date(start - day).toISOString(), end: new Date(cutoff - day).toISOString() },
  }
}

export function aggregateDailySales(
  date: string,
  orders: Iterable<HaulSaleOrder>,
  ownerOf: (sku: string) => string | null,
  groups: DailySalesGroups,
  fallbackTeam: (sku: string) => keyof DailySalesGroups | undefined = () => undefined,
): DailySalesReport {
  const haul = { units: 0 }
  const jit = { units: 0 }
  const counts = (team: keyof DailySalesGroups) => groups[team].length ? { units: 0 } : null
  const teams = { a: counts('a'), b: counts('b'), c: counts('c') }
  const teamJit = { a: counts('a'), b: counts('b'), c: counts('c') }
  const jimei = { units: 0, marker: 'J1T' as const, includedInJit: true as const }
  const teamByAccount = new Map<string, keyof DailySalesGroups>()
  for (const team of dailySalesTeams) {
    for (const account of groups[team]) teamByAccount.set(account, team)
  }
  const seenLines = new Map<string, Set<string>>()
  let unassignedUnits = 0
  for (const order of orders) {
    const seen = seenLines.get(order.id) ?? new Set<string>()
    seenLines.set(order.id, seen)
    for (const line of order.items) {
      if (seen.has(line.id)) continue
      seen.add(line.id)
      haul.units += line.units
      if (!line.units) continue
      if (line.sku && skuIsJimei(line.sku)) {
        jimei.units += line.units
        jit.units += line.units
        continue
      }
      const isJit = line.sku && skuIsJit(line.sku)
      if (isJit) jit.units += line.units
      const owner = line.sku ? ownerOf(line.sku) : null
      const assignedTeam = owner ? teamByAccount.get(owner) : line.sku ? fallbackTeam(line.sku) : undefined
      const team = assignedTeam ?? (line.sku && /ja/i.test(line.sku) ? 'b' : undefined)
      const total = team && teams[team]
      if (team && total) {
        total.units += line.units
        const jitTotal = teamJit[team]
        if (isJit && jitTotal) jitTotal.units += line.units
      } else unassignedUnits += line.units
    }
  }
  return { date, haul, jit, ...teams, teamJit, jimei, unassignedUnits }
}

export function dailySalesText(report: DailySalesReport, window = report.window) {
  const number = new Intl.NumberFormat('en-US')
  const units = (value: number) => number.format(value) + ' 件'
  const percentage = (value: number, total: number) => {
    if (!total) return '—'
    const percent = value / total * 100
    return percent > 0 && percent < 0.05 ? '<0.1%' : percent.toFixed(1) + '%'
  }
  const share = (value: number) => report.haul.units ? `（${percentage(value, report.haul.units)}）` : ''
  const comparison = (current: number, period: string, baseline?: number) => {
    if (baseline === undefined) return ''
    if (baseline === 0) return `${period} 0 件`
    const change = current - baseline
    return change === 0 ? `与${period}持平` :
      `比${period}${change > 0 ? '增加' : '减少'} ${percentage(Math.abs(change), baseline)}`
  }
  const parentheses = (value: string) => value ? `（${value}）` : ''
  const haulComparison = [
    comparison(report.haul.units, '昨天同期', report.previousUnits),
    report.previousYearUnits === null ? '去年同期暂无数据' : comparison(report.haul.units, '去年同期', report.previousYearUnits),
  ].filter(Boolean).join('，')
  const format = (label: string, metric: Counts | null) =>
    `${label}｜${metric ? units(metric.units) + share(metric.units) : '待配置'}`
  const jimei = format('　　集美', report.jimei)
  const jimeiShare = report.jimei.includedInJit ? `｜占总 JIT ${percentage(report.jimei.units, report.jit.units)}` : ''
  const beijing = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return [
    window
      ? `【美国站 Haul U2 时段销量】\n${beijing.format(new Date(window.start))} 至 ${beijing.format(new Date(window.end))}（北京时间）`
      : `【美国站 Haul U2 销量日报】${report.date}（美西）`,
    `Haul U2 总计｜${units(report.haul.units)}${parentheses(haulComparison)}`,
    format('　└ 其中 JIT', report.jit) + parentheses(comparison(report.jit.units, '昨天同期', report.previousJitUnits)),
    '',
    '　按运营组',
    ...dailySalesTeams.map((team) => {
      const jit = report.teamJit?.[team]
      const total = report[team]
      const group = format('　　' + teamLabels[team], total)
      if (!total || !jit) return group
      const withinGroup = percentage(jit.units, total.units)
      const ofTotalJit = percentage(jit.units, report.jit.units)
      return `${group}｜含 JIT ${units(jit.units)}（组内 ${withinGroup}，占总 JIT ${ofTotalJit}）`
    }),
    jimei + jimeiShare,
    `　　未归类｜${units(report.unassignedUnits)}${share(report.unassignedUnits)}`,
    '',
    '占比按件数计算，分母分别为 Haul U2 总件数、各组总件数、JIT 总件数。',
  ].join('\n')
}
