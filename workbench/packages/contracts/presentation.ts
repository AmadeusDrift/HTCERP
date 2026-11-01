// Apply only to system messages and generated research text, never to a member's notes or inputs.
export function memberDiagnostic(text: string) {
  return text
    .replace(
      /(?:https?:\/\/)?(?:[\w-]+\.)*geekbi\.com\b(?:[/?#][^\s，。；、）)<>"]*)?/gi,
      '商品数据服务',
    )
    .replace(
      /\b(?:GB_APP_(?:KEY|SECRET)|GEEKBI_CONFIGURED|X-GB-[\w-]+|OPENROUTER_API_KEY|SP_(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)|CONNECTIONS_KEY)\b/gi,
      '连接配置',
    )
    .replace(/极鲸云|geekbi/gi, '商品数据服务')
}

export function marketplaceLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/(?:^|\.)(?:amazon\.com|temu\.com|temu\.to|shein\.com|shein\.us|shein\.top|tiktok\.com|aliexpress\.com|aliexpress\.us)$/i.test(
        url.hostname,
      )
    )
      return null
    for (const [key, val] of [...url.searchParams])
      if (/geekbi|极鲸云/i.test(key + ' ' + val)) url.searchParams.delete(key)
    if (/geekbi|极鲸云/i.test(decodeURIComponent(url.hash))) url.hash = ''
    return url.href
  } catch {
    return null
  }
}

// Stored steps span report versions. Keep business data and remove request/response internals by name.
const internalFields = new Set(
  (
    'source datasource provider credentials evidenceref variantevidenceref totalsoldfield ' +
    'params request requestheaders requestbody response responseheaders responsebody headers ' +
    'raw rawdata rawpayload rawresponse providerresponse supplierresponse'
  ).split(' '),
)
const literalFields = new Set([
  'goal',
  'title',
  'keyword',
  'query',
  'note',
  'comparisonNote',
  'specs',
  'key',
  'value',
])
export function memberStepResult(value: unknown, includeModelSettings = false): Record<string, unknown> {
  function display(v: unknown, name: string): unknown {
    if (name === 'source_url' || name === 'sourceUrl') return marketplaceLink(v)
    if (typeof v === 'string') return literalFields.has(name) ? v : memberDiagnostic(v)
    if (Array.isArray(v)) return v.map((item) => display(item, name))
    if (v && typeof v === 'object') return project(v)
    return v
  }
  function project(obj: object) {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(
          ([key]) =>
            !internalFields.has(key.replace(/[_-]/g, '').toLowerCase()) && memberDiagnostic(key) === key,
        )
        .map(([key, v]) => [key, display(v, key)]),
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = project(value)
  if (!includeModelSettings) {
    for (const key of ['model', 'models', 'researchModel', 'decisionModel', 'promptVersion'])
      delete result[key]
  }
  return result
}
