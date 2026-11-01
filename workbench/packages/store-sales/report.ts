export const salesDay = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

export function daysBefore(day: string, count: number) {
  const date = new Date(day + 'T12:00:00Z')
  date.setUTCDate(date.getUTCDate() - count)
  return date.toISOString().slice(0, 10)
}

export interface SaleLine {
  title: string
  sku: string | null
  operator: string | null
  units: number
  // Per-unit price after discounts. Shipping is the allocation to this line, in USD cents.
  unitCents: number | null
  shippingCents: number | null
}
export interface Listing {
  sku: string
  operator: string | null
  relation: 'child' | 'standalone' | 'parent' | 'unknown'
}
interface Counts {
  units: number
  cents: number
}
export interface SalesSummary extends Counts {
  jit: Counts
  standard: Counts
  review: Counts & { lines: number; missingAmount: number }
  newListings: number
  unknownListings: number
}

export const skuIsJit = (sku: string) => /jit/i.test(sku)
export const saleCents = (line: SaleLine) =>
  line.unitCents === null || line.shippingCents === null
    ? null
    : line.unitCents * line.units + line.shippingCents

export function summarize(lines: SaleLine[], listings: Listing[]): SalesSummary {
  const summary = {
    units: 0,
    cents: 0,
    jit: { units: 0, cents: 0 },
    standard: { units: 0, cents: 0 },
    review: { units: 0, cents: 0, lines: 0, missingAmount: 0 },
    newListings: 0,
    unknownListings: 0,
  }
  for (const line of lines) {
    const cents = saleCents(line)
    summary.units += line.units
    summary.cents += cents ?? 0
    const sku = line.sku?.trim()
    if (!sku || cents === null) {
      summary.review.lines++
      summary.review.units += line.units
      summary.review.cents += cents ?? 0
      if (cents === null) summary.review.missingAmount++
    } else {
      const group = skuIsJit(sku) ? summary.jit : summary.standard
      group.units += line.units
      group.cents += cents
    }
  }
  const uniqueListings = new Map(listings.map((listing) => [listing.sku, listing]))
  for (const listing of uniqueListings.values()) {
    if (listing.relation === 'child' || listing.relation === 'standalone') summary.newListings++
    else if (listing.relation === 'unknown') summary.unknownListings++
  }
  return summary
}

export interface SalesDay {
  date: string
  team: SalesSummary
  operators: { name: string | null; summary: SalesSummary }[]
  products: {
    sku: string | null
    title: string
    operator: string | null
    units: number
    cents: number | null
  }[]
}
export interface StoreSales {
  source: 'pending' | 'simulation'
  yesterday: string
  days: SalesDay[]
}
