import dictionary from './dictionary.json'
import podSupplement from './pod-supplement.json'
import verifiedAliases from './verified-ip-aliases.json'
export type CustomTerm = { id: number; name: string; family: string; aliases: string; reason: string }
export async function customTerms(db: D1Database, revision?: number) {
  const rows = await db
    .prepare('SELECT id,name,family,aliases,reason FROM title_audit_terms WHERE id<=? ORDER BY id')
    .bind(revision ?? Number.MAX_SAFE_INTEGER)
    .all<CustomTerm>()
  return rows.results
}
type Entry = {
  name: string
  family: string
  aliases: string[]
  policy: string
  source: string
  url?: string
}
let catalog: Entry[] | undefined
function entries() {
  if (catalog) return catalog
  const groups = new Map<string, Entry>()
  for (const [alias, name, family, policy, url] of dictionary.ip) {
    const k = name + '\n' + family
    const e = groups.get(k) ?? { name, family, aliases: [], policy, source: '品牌与 IP', url }
    if (alias.toLowerCase() !== name.toLowerCase() && !e.aliases.includes(alias)) e.aliases.push(alias)
    groups.set(k, e)
  }
  catalog = [
    ...groups.values(),
    ...verifiedAliases.map(({ name, family, aliases, contextTerms, url }) => ({
      name,
      family,
      aliases,
      policy: contextTerms ? '结合上下文' : '提示复核',
      source: '品牌与 IP',
      url,
    })),
    ...podSupplement.terms.map(({ name, requiresContext }) => ({
      name,
      family: name,
      aliases: [],
      policy: requiresContext ? '结合上下文' : '提示复核',
      source: '品牌与 IP',
    })),
    ...dictionary.terms.map(([name, serial]) => ({
      name,
      family: '',
      aliases: [],
      policy: '按语境判断',
      source: '美国商标',
      url: 'https://tsdr.uspto.gov/statusview/sn' + serial,
    })),
  ]
  return catalog
}
export function searchTerms(
  q: string,
  scope: string,
  page: number,
  custom: CustomTerm[],
  family: string,
) {
  const needle = q.normalize('NFKC').toLowerCase().trim()
  const rows: Entry[] = custom.map((t) => ({
    name: t.name,
    family: t.family,
    aliases: JSON.parse(t.aliases),
    policy: '重点核权',
    source: '运营新增',
  }))
  const filtered = [...rows, ...entries()].filter(
    (e) =>
      (!scope || scope === e.source) &&
      (!family || family === e.family) &&
      (!needle ||
        [e.name, e.family, ...e.aliases].some((s) =>
          s.normalize('NFKC').toLowerCase().includes(needle),
        )),
  )
  if (needle)
    filtered.sort(
      (a, b) =>
        Number([b.name, ...b.aliases].some((n) => n.toLowerCase() === needle)) -
        Number([a.name, ...a.aliases].some((n) => n.toLowerCase() === needle)),
    )
  return {
    total: filtered.length,
    rows: filtered.slice(page * 40, page * 40 + 40),
    customCount: custom.length,
    version: 'v0.3',
  }
}
