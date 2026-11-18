import type { CustomTerm } from './catalog'
import { buildInspector, type Hit, type Verdict } from './rules'

export const version = 'US-v0.3-r10'
type AuditVerdict = Verdict | '低优先级'
export type AuditHit = Omit<Hit, 'verdict'> & { verdict: AuditVerdict }

const priority: Record<AuditVerdict, number> = {
  通过: 0,
  低优先级: 1,
  冲突: 2,
  建议改写: 3,
  重点提醒: 4,
}

const graphicProduct =
  /\b(?:t[ -]shirts?|hoodies?|sweatshirts?|key\s?(?:chains?|rings?)|posters?|decals?|stickers?|wall art|signs?|mugs?)\b/i
const accessory =
  /\b(?:floor mats?|liners?|cases?|covers?|decals?|chargers?|cables?|filters?|adapters?|holders?|mounts?|straps?|parts?)\b[^,;]{0,45}\b(?:compatible with|fits|for)\s+(?:the\s+)?$/i
const jeepModels = /^(?:Wrangler|Gladiator|Cherokee|Compass|Renegade|Wagoneer|Liberty|Patriot|Commander)$/i
const sourceClaim = /\b(?:official(?:ly licensed)?|licensed|genuine|authentic|brand)(?:\s*[:=-]\s*|\s+)$/i
const regionName = /^(?:u\.?s\.?a\.?|united states|u\.?k\.?|united kingdom)$/i
const logo = /^\s+(?:(?:brand|car)\s+)?(?:logo|emblem|badge)\b/i
const standaloneLetter = /^[A-Za-zＡ-Ｚａ-ｚ]$/u
const standaloneLetters = /(?<![\p{L}\p{N}\p{M}])[A-Za-zＡ-Ｚａ-ｚ](?![\p{L}\p{N}\p{M}])/gu
const letterLabel = /\b(?:size|letter|initial|monogram)(?:\s*[:#=-]\s*|\s+)$/i
const codeLabel = /\b(?:model|sku|option|variant|version|type|series|grade|class)(?:\s*[:#=-]\s*|\s+)$/i
const themeTerms = /\b(?:Black Panther|Red Bull|Jeep|Cyber[\s\p{Pd}]*Punk|Dark[\s\p{Pd}]*Knight|Jaguar)\b/giu

function describe(hit: AuditHit, verdict: AuditVerdict, reason: string): AuditHit {
  return { ...hit, verdict, reason }
}

function letterUse(term: string, before: string, after: string): 'brand' | 'specification' | 'ambiguous' {
  const letter = term.normalize('NFKC')
  const cut = /^(?:a[- ]line|[uv][- ]neck|t[- ]shirts?)\b/i.test(letter + after)
  if (cut) return 'specification'
  const attributed = /\bby\s+$/i.test(before) && /^\s*(?:$|[,;|)])/u.test(after) &&
    !/\b(?:inspired|divided|multiplied)\s+by\s+$/i.test(before)
  if (sourceClaim.test(before) || /^\s*[®™]/.test(after) || attributed) return 'brand'

  const dimension = /^x$/i.test(letter) && /\d\s*(?:in\.?|cm|mm|ft\.?|["″])?\s*$/i.test(before) && /^\s*\d/.test(after)
  const article = /^a$/i.test(letter) && (/^\s+brand[- ]new\b/i.test(after) ||
    (logo.test(after) && (letter === 'a' || /\b(?:with|has|includes)\s+$/i.test(before))))
  const connector = /^[abc]$/i.test(letter) && /\b(?:usb|type)(?:\s*[-–]\s*|\s+)$/i.test(before)
  if (dimension || article || connector || letterLabel.test(before) || /^\s+(?:size|monogram|initial)\b/i.test(after))
    return 'specification'

  if (logo.test(after) || /\b(?:logo|emblem)(?:\s*:\s*|\s+of\s+)$/i.test(before) || /^\s+brand\b/i.test(after))
    return 'brand'

  const code = codeLabel.test(before) || /^[-_](?:jit[-_])?\d/i.test(after) || /\d[-_]$/.test(before)
  return code ? 'specification' : 'ambiguous'
}

function reviewHit(title: string, hit: Hit): AuditHit {
  const before = title.slice(0, hit.start)
  const after = title.slice(hit.end)
  if (standaloneLetter.test(hit.term)) {
    const use = letterUse(hit.term, before, after)
    if (use === 'brand')
      return describe(hit, '重点提醒', '这个单字母有品牌、来源或标识用词线索，请核对标题用词和授权。')
    const literal = { ...hit, names: [], families: [] }
    return use === 'specification'
      ? describe(literal, '通过', '这个字母在这里属于普通描述或商品规格。')
      : describe(literal, '低优先级', '单字母缺少足够的品牌用词线索。')
  }
  if (hit.configured) return hit
  const theme = hit.term.toLowerCase().replace(/[\s\p{Pd}]+/gu, '')
  const mark = /^\s*[®™]/.test(after)
  const byBrand = hit.names.length > 0 && /\bby\s+$/i.test(before) && !/\binspired\s+by\s+$/i.test(before)
  const source = sourceClaim.test(before) || mark || byBrand
  const jeepModel = jeepModels.test(hit.term) && /\bjeep\s+$/i.test(before)
  const compatibility =
    (theme === 'jeep' && accessory.test(before)) ||
    (jeepModel && accessory.test(before.replace(/jeep\s+$/i, '')))

  if (!mark && !hit.names.length && regionName.test(hit.term) && /\bauthentic\s+$/i.test(before))
    return describe(hit, '低优先级', '这里是地域名称，标题缺少具体品牌或角色线索。')
  if (source) return describe(hit, '重点提醒', '标题把该词用于品牌或授权声明，请核对商品来源。')
  if (compatibility)
    return describe(hit, '通过', '该词在这里是配件的适配对象，请以商品规格核对适配关系。')

  if (theme === 'blackpanther' &&
      (/\b(?:wildlife|animal)\s+$/i.test(before) || /^\s+(?:wildlife|animal)\b/i.test(after)) &&
      !/\b(?:marvel|wakanda|t['’]challa)\b/i.test(title))
    return describe({ ...hit, names: [], families: [] }, '通过', '相邻词表明此处是野生动物题材。')

  if (theme === 'neon' && /^\s+(?:city|lights?|colors?|pink|green)\b/i.test(after) &&
      !/\bvalorant\b/i.test(title))
    return describe({ ...hit, names: [], families: [] }, '低优先级', '相邻词表明此处可能描述灯光或颜色。')

  if ((theme === 'cyberpunk' || theme === 'darkknight') && !hit.names.length) {
    if (theme === 'cyberpunk' && /^\s+(?:style|aesthetic|genre)\b/i.test(after))
      return describe(hit, '低优先级', '标题将该词用于风格描述，标题证据较弱。')
    if (graphicProduct.test(title))
      return describe(hit, '重点提醒', '该短语在标题中用作商品主题，有用词风险。请核对标题用词和授权。')
    return describe(hit, '低优先级', '该短语有多种含义，标题证据较弱。')
  }

  if (theme === 'jaguar' && !hit.names.length && logo.test(after))
    return describe(hit, '重点提醒', '标题把该词与 Logo 或标识一起使用，有品牌用词风险。请核对标题用词和授权。')

  if (graphicProduct.test(title) &&
      (['blackpanther', 'redbull', 'jeep'].includes(theme) ||
       hit.families.some(family => family === 'Cyberpunk' || family === 'DC')))
    return describe(hit, '重点提醒', '标题把该名称用作商品主题，请核对标题用词和授权。')

  if (theme === 'stitch' && hit.names.length && graphicProduct.test(title) && hit.verdict === '冲突')
    return describe(hit, '重点提醒', '标题把 Stitch 用作商品主题，可能涉及角色名称。请核对标题用词和授权。')

  if (!hit.names.length && (hit.verdict === '冲突' || hit.verdict === '建议改写'))
    return describe(hit, '低优先级', '仅有词库命中，标题缺少品牌、角色或来源声明等上下文。')
  return hit
}

function contextualHits(title: string, existing: Hit[]): Hit[] {
  const added: Hit[] = []
  const candidates = [...title.matchAll(themeTerms), ...title.matchAll(standaloneLetters)]
  for (const match of candidates) {
    const term = match[0]
    const start = match.index
    const end = start + term.length
    const key = term.toLowerCase()
    if (standaloneLetter.test(term) && letterUse(term, title.slice(0, start), title.slice(end)) !== 'brand') continue
    if (key === 'jaguar' && !logo.test(title.slice(end))) continue
    if (existing.some(hit => hit.start < end && hit.end > start && hit.names.length)) continue
    const names = key === 'jeep' ? ['Jeep'] : []
    added.push({ term, start, end, names, families: names, verdict: '冲突', reason: '标题包含需结合上下文核对的名称。' })
  }
  if (!added.length) return existing
  return [...existing.filter(hit => !added.some(next => hit.start < next.end && hit.end > next.start)), ...added]
    .sort((a, b) => a.start - b.start)
}

export function buildTitleAuditInspector(custom: CustomTerm[]) {
  const inspect = buildInspector(custom)
  return (title: string) => {
    const base = inspect(title)
    const hits = contextualHits(title, base.hits).map(hit => reviewHit(title, hit))
    const verdict = hits.reduce<AuditVerdict>((highest, hit) =>
      priority[hit.verdict] > priority[highest] ? hit.verdict : highest, '通过')
    return { version, verdict: title.trim() ? verdict : '缺少标题，待补查' as const, hits }
  }
}
