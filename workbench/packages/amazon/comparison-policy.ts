export const amazonComparisonVersion = 2

// First-generation checks searched the broad product category without its intended use.
export function needsAmazonLookup(result?: { methodVersion?: number; status: string } | null) {
  return (
    !result || (result.methodVersion ?? 1) < amazonComparisonVersion || result.status === 'unavailable'
  )
}
