import dictionary from './dictionary.json'
import podSupplement from './pod-supplement.json'
import shirtThemes from './reviewed-shirt-themes.json'
import verifiedAliases from './verified-ip-aliases.json'
import type { CustomTerm } from './catalog'

export const version = 'US-v0.3-r8'
export const verdicts = ['通过', '建议改写', '重点提醒', '冲突'] as const
export type Verdict = (typeof verdicts)[number]
export type Hit = {
  term: string
  families: string[]
  names: string[]
  start: number
  end: number
  verdict: Verdict
  reason: string
  configured?: true
}
const tokens = (s: string) => [...s.matchAll(/[\p{L}\p{N}\p{M}]+|[+#&@%]/gu)]
const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
type TermInfo = {
  families: Set<string>
  names: Set<string>
  priority: boolean
  ambiguous: boolean
  context?: 'vehicle' | 'source' | string[]
  note?: string
}
const index = new Map<string, TermInfo>()
let longest = 1
function add(term: string, name?: string, family?: string, rule?: string, context?: TermInfo['context']) {
  const parts = tokens(normalize(term)).map((m) => m[0])
  if (!parts.length) return
  const key = parts.join(' ')
  const existing = index.get(key)
  const item = existing ?? {
    families: new Set<string>(),
    names: new Set<string>(),
    priority: false,
    ambiguous: false,
  }
  if (family && name) {
    item.families.add(family)
    item.names.add(name)
  }
  item.priority ||= rule === '重点核权'
  item.ambiguous ||= rule === '结合上下文'
  if (context && !existing) item.context = context
  index.set(key, item)
  longest = Math.max(longest, parts.length)
}
function initialize() {
  if (index.size) return
  for (const [term] of dictionary.terms) add(term)
  for (const [alias, name, family, rule] of dictionary.ip) add(alias, name, family, rule)
  for (const { name, category, requiresContext } of podSupplement.terms) {
    const context = requiresContext ? (category === 'car_brand' ? 'vehicle' : 'source') : undefined
    add(name, name, name, requiresContext ? '结合上下文' : '提示复核', context)
  }
  for (const { name, family, aliases, contextTerms } of verifiedAliases) {
    const context = contextTerms?.map((term) => ` ${tokens(normalize(term)).map((m) => m[0]).join(' ')} `)
    for (const alias of [name, ...aliases])
      add(alias, name, family, context ? '结合上下文' : '提示复核', context)
  }
}
const rank: Record<Verdict, number> = { 通过: 0, 冲突: 1, 建议改写: 2, 重点提醒: 3 }
const productWords = new Set(
  'mug cups cup case cover stickers sticker poster stand holder slicer lid adapter cable filter'.split(
    ' ',
  ),
)
// A phrase only explains the tokens inside its span; other brand hits in the title survive.
const descriptions = [
  /\b(?:wall|canvas|diamond|nail|line|metal|abstract|resin) art\b|\bart (?:prints?|paintings?|posters?|decor|supplies|sets?)\b/gi,
  /\b(?:black\s+)?t[-\s]shirts?\b|\bgift ideas?\b|\bideal for\b|\barch support\b|\bheat[- ](?:transfer|resistant|press)\b/gi,
  /\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?(?:\s*(?:inches|inch|cm|mm|ft))?\b/gi,
  /\b(?:new york|authentic style|cross[- ]stitch|stitch count|running stitch)\b/gi,
  /\b(?:black|pink|gold|tan)\b(?=[-., ]+\d|\s+(?:and white|acrylic|leather|cotton|metal|shirt|frame|shoe|background)\b)/gi,
  /\b(?:in the|in your|or other|home or office|indoor or outdoor)\b/gi,
]
// Only explain the matched occurrence. Names elsewhere in the same title are still checked.
const motifs = new Set(('cat ghost daisy coastal fern angel blossom iris tiger eagle lemon reef canyon swan bison bluebird goat owl zebra harvest raven crescent phoenix poppy calf husky hummingbird dove calico retriever crane rocky seashell wave mosaic silhouette willow giraffe bulldog boathouse pumpkin deer jellyfish goldfish white_cat').split(' ').map(x => x.replace('_',' ')))
const decor = /\b(?:coasters?|decor|pattern|printed|magnets?|suncatcher|canvas|posters?|wall art|trivet|doormat|bath mat|tapestry|sign|stickers?|garden stake|planter|sculpture|ornament)\b/i
const usagePhrases = /\b(?:cat silhouette|halloween ghost|rock guitar|rock music|rock formation|coastal crab|tree of life|still life|sea life|surface protection|flat surface|smooth surface|surface of|e[- ]reader|hook (?:&|and) loop|hong kong|frozen (?:lake|pond|river)|apple (?:tea|farm|cup|bread|tree|pie)|tangled (?:green|smoke)|dove of peace|white dove|stay wild|wild flowers?|dragon red wings)\b/gi
const reviewedLamp = '1pc mini genie aladdin lamp incense burner,home decor, idea'
const vehicleContext = /\b(?:automotive|auto parts|car models?|motor vehicles?|(?:car|truck|vehicle|suv) floor mats?|brake pads?|wheel hubs?|engine parts?|headlights?)\b|汽车配件|车型/i
const weakDescriptors = new Set(('art black pink gold tan idea ideal style tin stained_glass soft tapestry classic easy pouch strap gift heat arch flip ' +
  'leaf pumpkin owl hummingbird in or the at be half full extra').split(' ').map(s => s.replace('_', ' ')))
export function buildInspector(custom: CustomTerm[]) {
  initialize()
  const extra = new Map<string, TermInfo>()
  let limit = longest
  for (const row of custom) {
    for (const alias of [row.name, ...(JSON.parse(row.aliases) as string[])]) {
      const words = tokens(normalize(alias))
      limit = Math.max(limit, words.length)
      const key = words.map((m) => m[0]).join(' '),
        previous = extra.get(key) ?? index.get(key)
      extra.set(key, {
        families: new Set([...(previous?.families ?? []), row.family || row.name]),
        names: new Set([...(previous?.names ?? []), row.name]),
        priority: true,
        ambiguous: false,
        note: row.reason,
      })
    }
  }
  return (title: string) => inspectTitle(title, extra, limit)
}
export function inspectTitle(title: string, extra = new Map<string, TermInfo>(), limit?: number) {
  initialize()
  const hasVehicleContext = vehicleContext.test(title)
  const parts = tokens(title),
    keys = parts.map((m) => normalize(m[0])),
    hits: Hit[] = []
  const titleKey = ` ${keys.join(' ')} `
  const spans = [...descriptions, usagePhrases].flatMap(pattern => Array.from(title.matchAll(pattern), m => [m.index!, m.index! + m[0].length]))
  const shirt = /^(Men's Cotton Blend T-Shirt,\s*)([\w -]+?)\s+Crew Neck Short Sleeve Shirt(?: Black)?$/i.exec(title)
  const theme = shirt?.[2].toLowerCase()
  const reviewedTerms = theme && Object.hasOwn(shirtThemes, theme)
    ? shirtThemes[theme as keyof typeof shirtThemes] : []
  let verdict: Verdict = '通过'
  for (let i = 0; i < parts.length; i++) {
    for (let stop = Math.min(parts.length, i + (limit ?? longest)); stop > i; stop--) {
      const key = keys.slice(i, stop).join(' '),
        item = extra.get(key) ?? index.get(key)
      if (!item) continue
      const start = parts[i].index!,
        end = parts[stop - 1].index! + parts[stop - 1][0].length
      const before = normalize(title.slice(0, start)),
        after = normalize(title.slice(end)),
        term = title.slice(start, end)
      const claimed = /\b(?:official|licensed|genuine|authentic)\s+$/.test(before)
      const sourceCue = claimed || /\b(?:by|brand|from)\s*[:=-]?\s*$/.test(before) || /^\s*(?:[®™]|brand\b)/.test(after)
      if (Array.isArray(item.context)) {
        if (!item.context.some((term) => titleKey.includes(term))) continue
      } else if (item.context && !sourceCue && !(item.context === 'vehicle' && hasVehicleContext)) {
        continue
      }
      if (!extra.has(key) && !sourceCue) {
        // "Goat Crew" can cross from the theme "Karate Goat" into the collar specification.
        if (shirt && reviewedTerms.includes(key) && start >= shirt[1].length &&
            (end <= shirt[1].length + shirt[2].length || key === 'goat crew')) {
          i = stop - 1
          break
        }
        const ordinaryPhrase = (key === 'cat' && /\bflower[ -]+$/.exec(before)) ||
          (key === 'up' && /\bnever[ -]+give[ -]+$/.exec(before))
        if (ordinaryPhrase && !/\b(?:official|licensed|genuine|authentic|by|brand|from)\s*[:=-]?\s*$/.test(before.slice(0, ordinaryPhrase.index))) {
          i = stop - 1
          break
        }
        const modelCode = /^[a-z]{1,3}$/.test(key) && (/^[-_](?:jit[-_])?\d/.test(after) || /\d[-_]$/.test(before) && /^[-_]\w/.test(after))
        const motif = motifs.has(key) && !item.priority && decor.test(title) && !/\b(?:boots?|footwear|workwear|tools?|equipment|excavator)\b/i.test(title)
        const compatible = key === 'crocs' && /\bshoe (?:charms?|decorations?)\s+(?:for|compatible with|intended for|that fit)\s+$/.test(before)
        const reviewed = ['aladdin','genie'].includes(key) && normalize(title.trim()) === reviewedLamp
        if (modelCode && !item.priority || motif || compatible || reviewed) {
          i = stop - 1
          break
        }
      }
      const descriptive = spans.some(([a,b]) => a <= start && end <= b)
      if (!extra.has(key) && !item.priority && descriptive && (!claimed || (key === 'style' && /\bauthentic\s+$/.test(before)))) {
        i = stop - 1
        break
      }
      // Suppress descriptive tokens only in context. Explicit operator rules and source claims win.
      if (!extra.has(key) && !/\b(?:official|licensed|genuine|authentic)\s+$/.test(before)) {
        const attribute = !item.priority && (
          (key === 's' && /['’]$/.test(before)) ||
          (/^colou?rs?$/.test(key) && /\d+\s*$/.test(before)) ||
          (key === 'up' && /\bblow[ -]+$/.test(before) && /\bcostumes?\b/i.test(title)) ||
          (key === 'style' && /\bbutton\s+$/.test(before)) ||
          (!item.names.size && /^\d+$/.test(key) && (/[.,-]\s*$/.test(before) || /^[-.,]/.test(after) || /^\s*(?:cm|mm|years?|months?|inch(?:es)?)\b/.test(after)))
        )
        if (attribute) { i = stop - 1; break }
      }
      let v: Verdict = '冲突',
        reason = '名称命中，标题不足以确认其用途。'
      if (item.note) {
        v = '重点提醒'
        reason = item.note
      } else if (
        !item.names.size &&
        productWords.has(key) &&
        !/\b(?:official|licensed|genuine|authentic)\s+$/.test(before) &&
        (start > 0 || !after.trim())
      ) {
        v = '通过'
        reason = '匹配到常见商品名称，未见品牌来源声明。'
      } else if (
        (key === 'apple' && /^\s+(slicer|corer|cutter)\b/.test(after)) ||
        (key === 'cars' && /\btoy\s+$/.test(before))
      ) {
        v = '通过'
        reason = '普通商品描述。'
      } else if (
        !item.priority &&
        /\b(case|cover|charger|cable|filter|strap|band|adapter|mount|holder|protector|lid|part)s?\b[^,;]{0,45}\b(compatible with|fits|for|intended for)\s+$/.test(
          before,
        )
      ) {
        v = '通过'
        reason = '标题已说明配件和适配对象；适配事实仍以商品规格为准。'
      } else if (/\b(?:official|officially licensed|genuine|authentic)\s+$/.test(before)) {
        v = '重点提醒'
        reason = '标题声称官方、授权或原厂来源。'
      } else if (item.families.size > 1 || item.ambiguous) {
        reason = key === 'stitch' ? 'Stitch 可指针法或角色。请核对商品图案是否使用角色形象。' : term + ' 有普通释义或多个品牌／IP 归属，请核对是否用作品牌或角色名。'
      } else if (
        /^\s*(?:[\w.-]+\s+){0,3}(?:case|cover|charger|filter|adapter|protector|replacement band|lid)\b/i.test(
          after,
        ) &&
        !item.priority
      ) {
        v = '建议改写'
        reason = '可能为适配对象，建议明确配件来源和适配关系。'
      } else if (
        item.priority ||
        (item.names.size &&
          /^\s+(?:birthday\s+|graphic\s+)?(?:sticker|poster|plush|t-shirt|hoodie|decal|figure|wall art|mug)/i.test(
            after,
          ))
      ) {
        v = '重点提醒'
        reason = '重点品牌或角色出现在标题中，请核实品牌来源或授权。'
      }
      // A federal word mark alone is weak evidence for common attributes within a longer title.
      // Preserve possible source use at the beginning, explicit brand cues, and curated identities.
      if (v === '冲突' && !extra.has(key) && !item.names.size && start > 0 &&
          !claimed && !/\b(?:brand|by|from)\s*[:=-]?\s*$/.test(before) && !/^\s*(?:[®™]|brand\b)/.test(after) &&
          (weakDescriptors.has(key) || /^[a-z]$|^\d+(?:x\d+)?$/.test(key))) {
        i = stop - 1
        break
      }
      hits.push({
        term,
        families: [...item.families],
        names: [...item.names],
        start,
        end,
        verdict: v,
        reason,
        ...(extra.has(key) && { configured: true }),
      })
      if (rank[v] > rank[verdict]) verdict = v
      i = stop - 1
      break
    }
  }
  if (!title.trim()) return { version, verdict: '缺少标题，待补查' as const, hits }
  return { version, verdict, hits }
}
