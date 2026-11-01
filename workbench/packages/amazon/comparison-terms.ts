const vocabulary = (s: string) => new Set(s.split(' '))
const unique = (list: string[]) => [...new Set(list)]
const noise = vocabulary(
  'a an the and or of by at is as your this that new best top home product item amazon temu keyword keywords search us goods quality premium perfect deal sale popular hot fashion set pack pcs pc piece pieces count pair kit gift gifts use sizes size style design model suitable multipurpose multifunctional adjustable durable reusable portable included includes bulk ounce ounces oz fl ml mm cm g kg lb lbs large small medium',
)
const materials = vocabulary(
  'plastic silicone steel stainless metal wooden wood bamboo glass ceramic cotton',
)
const decoration = vocabulary(
  'red blue black white pink clear green grey gray gold silver round square decorative classic practical',
)
const general = vocabulary(
  'measuring measurement kitchen bathroom tool accessory accessories multi purpose',
)
const nouns = vocabulary(
  'scoop spoon spatula whisk cup bowl tray mug dish bottle bag backpack rack shelf organizer holder stand bin basket box hook mat rug board lamp light brush toothbrush cover case glove towel pillow mirror clock toy hanger clip clamp cutter pan pot strainer funnel scale dispenser scraper sponge coaster blanket apron mold scissors knife',
)
const accessories = vocabulary(
  'replacement refill lid cap handle attachment holder stand cover case sleeve mount bracket',
)
const families = [
  ['scoop', 'spoon', 'cup'],
  ['bin', 'box', 'basket'],
  ['rack', 'shelf'],
  ['lamp', 'light'],
]
const family = (word: string) => families.find((group) => group.includes(word)) ?? [word]
const synonyms = [
  ['dog', 'pet', 'canine', 'puppy', 'kibble'],
  ['cat', 'pet', 'feline', 'kitten', 'kibble'],
  ['pet', 'dog', 'cat', 'canine', 'feline', 'kibble'],
  ['food', 'kibble', 'feed', 'feeding'],
  ['shoe', 'footwear', 'boot', 'sneaker'],
  ['desk', 'desktop'],
  ['powder', 'powdered'],
]
const purposeHit = (word: string, text: string[]) =>
  (synonyms.find((group) => group[0] === word) ?? [word]).some((alternative) =>
    text.includes(alternative),
  )
const cnTypes: [RegExp, string][] = [
  [/狗粮勺|犬粮勺/, 'dog food scoop'],
  [/猫粮勺/, 'cat food scoop'],
  [/宠物(?:粮|喂食|食物)勺/, 'pet food scoop'],
  [/咖啡[量豆]?勺/, 'coffee scoop'],
  [/奶粉勺/, 'milk powder scoop'],
  [/量[匙勺]|计量勺/, 'measuring spoon'],
  [/奶瓶刷/, 'baby bottle brush'],
  [/牙刷架/, 'toothbrush holder'],
  [/杯刷|瓶刷/, 'bottle brush'],
  [/锅铲|刮刀/, 'spatula'],
  [/打蛋器/, 'whisk'],
  [/量杯/, 'measuring cup'],
  [/收纳盒|储物盒/, 'storage box'],
  [/收纳篮|储物篮/, 'storage basket'],
  [/鞋架/, 'shoe rack'],
  [/置物架|收纳架/, 'storage rack'],
  [/台灯|桌灯/, 'desk lamp'],
  [/衣架/, 'clothes hanger'],
  [/挂钩/, 'wall hook'],
  [/水瓶|水壶/, 'water bottle'],
  [/砧板|菜板/, 'cutting board'],
  [/漏斗/, 'funnel'],
  [/杯垫/, 'coaster'],
  [/烤盘/, 'baking tray'],
  [/牙刷/, 'toothbrush'],
  [/厨房秤/, 'kitchen scale'],
]
const cnMaterials: [RegExp, string][] = [
  [/塑料/, 'plastic'],
  [/硅胶/, 'silicone'],
  [/不锈钢/, 'stainless steel'],
  [/竹制/, 'bamboo'],
  [/玻璃/, 'glass'],
]
const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 1000) : '')
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
function singular(word: string) {
  if (word === 'shelves') return 'shelf'
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (/(?:brush|box)es$/.test(word)) return word.slice(0, -2)
  return /[^s]s$/.test(word) && word.length > 3 && word !== 'scissors' ? word.slice(0, -1) : word
}
function words(s: string) {
  return unique(
    (s.toLowerCase().match(/[a-z]{2,}/g) ?? [])
      .filter((w) => !noise.has(w))
      .map(singular)
      .filter((w) => !noise.has(w)),
  )
}
const clauses = (s: string) => s.split(/[,;|，；]|\s+[-–—]\s+/)
const usage = /\b(?:suitable\s+for|designed\s+for|for)\b/i
const concrete = (w: string) => !materials.has(w) && !general.has(w) && !decoration.has(w)
const units: Record<string, string> = {
  盎司: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  液量盎司: 'fl oz',
  液体盎司: 'fl oz',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  毫升: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  cc: 'ml',
  厘米: 'cm',
  毫米: 'mm',
  英寸: 'inch',
  inches: 'inch',
  cups: 'cup',
}
const measurement =
  /(\d+(?:\.\d+)?(?:\/\d+)?)\s*[- ]?\s*(fluid ounces?|fl\.?\s*oz|液量盎司|液体盎司|ounces?|oz|盎司|milliliters?|ml|cc|毫升|cm|厘米|mm|毫米|inches|inch|英寸|cups?)(?![a-z])/gi
function measures(s: string) {
  return unique(
    [...s.toLowerCase().matchAll(measurement)].map(
      (m) => m[1] + ' ' + (units[m[2]] ?? (/^fl\.?\s*oz$/.test(m[2]) ? 'fl oz' : m[2])),
    ),
  )
}
function packSizes(s: string) {
  const quantities = (pattern: RegExp) => unique([...s.matchAll(pattern)].map((m) => m[1] ?? m[2]))
  // "6-piece set (Pack of 1)" contains six pieces. The outer retail package count is only a fallback.
  const pieces = quantities(
    /\bset\s+of\s+(\d{1,4})\b|(?:^|[^\d.])(\d{1,4})\s*[-‐‑– ]?\s*(?:pcs?\b|pieces?\b|count\b|件(?:装|套)?)/gi,
  )
  return pieces.length
    ? pieces
    : quantities(/\bpack\s+of\s+(\d{1,4})\b|(?:^|[^\d.])(\d{1,4})\s*[-‐‑– ]?\s*packs?\b/gi)
}
function skuSpecs(variants: unknown[]) {
  return unique(
    variants
      .slice(0, 3)
      .map((v) => {
        const props = record(v).specs
        if (!Array.isArray(props)) return ''
        return props
          .slice(0, 4)
          .flatMap((entry) => {
            const spec = record(entry),
              value = str(spec.value ?? spec.specValue).slice(0, 80),
              key = str(spec.key ?? spec.specKey).slice(0, 40)
            return value ? [(key ? key + '：' : '') + value] : []
          })
          .join(' / ')
      })
      .filter(Boolean),
  )
}
function identify(text: string) {
  const phrases = clauses(text.replace(measurement, ' ')).flatMap((clause) => {
    // A "bottle brush with stand" sells brushes; a "stand for bottle brushes" sells stands.
    const [main, use] = clause.split(/\bwith\b/i)[0].split(usage)
    const core = words(main)
    const head = core.findLast((w) => nouns.has(w) || accessories.has(w)) ?? core.findLast(concrete)
    if (!head) return []
    const modifiers = core.filter((w) => w !== head && !materials.has(w) && !decoration.has(w))
    const direct = modifiers.filter(concrete).slice(-3)
    const intendedUse = words(use ?? '')
      .filter(concrete)
      .slice(0, 2)
    const purpose = direct.length ? direct : intendedUse.length ? intendedUse : modifiers.slice(-2)
    return [
      {
        head,
        purpose,
        modifiers: unique([...modifiers.slice(-3), ...(!direct.length ? intendedUse : [])]),
        specificity: Math.min(2, direct.length) * 2 + Number(intendedUse.length > 0),
      },
    ]
  })
  const first = phrases.find((p) => nouns.has(p.head) || accessories.has(p.head)) ?? phrases[0]
  if (!first) return null
  return phrases
    .filter((p) => family(first.head).includes(p.head))
    .sort((a, b) => b.specificity - a.specificity)[0]
}
function rawChineseTerms(s: string) {
  // Retain a concrete original name when the pinned evidence has no translation. Never issue a
  // generic placeholder search, and only qualify a result if its title supports the source terms.
  for (const clause of clauses(s)) {
    const text = clause
      .replace(measurement, ' ')
      .replace(/\d+\s*[件个只](?:装|套)?/g, ' ')
      .replace(/适用于.*|未知商品|某未知|商品|产品|热卖|新品|促销|多功能|高品质/g, '')
      .trim()
    const terms = text.match(/[\u3400-\u9fff]{2,}/g) ?? []
    if (terms.length) return terms.join(' ').slice(0, 48)
  }
  return ''
}
export function comparisonTerms(
  product: Record<string, unknown>,
  variants: unknown[],
  proposed?: string,
) {
  const sourceTitle = str(product.title) || str(product.title_cn) || str(product.title_en)
  const english = str(product.title_en) || sourceTitle
  const source = [english, sourceTitle, str(product.title_cn)].join(' · ')
  const cn = cnTypes.find(([re]) => re.test(source))?.[1]
  const en = identify(english)
  const translated = cn ? identify(cn) : null
  const suggested = identify(str(proposed))
  const target =
    translated &&
    (!en ||
      !nouns.has(en.head) ||
      (family(en.head).includes(translated.head) && translated.specificity > en.specificity))
      ? translated
      : (en ?? suggested)
  const specs = skuSpecs(variants)
  const detail = [source, ...specs].join(' · ')
  const sourceMaterials = unique([
    ...words(english).filter((w) => materials.has(w)),
    ...words(cnMaterials.find(([re]) => re.test(source))?.[1] ?? ''),
  ])
  const packs = packSizes(detail),
    dimensions = measures(detail)
  const sourceSpecs =
    [...specs, ...dimensions, ...(packs.length ? [packs.join('/') + ' 件装'] : [])]
      .join('；')
      .slice(0, 550) || null
  const raw = target ? '' : rawChineseTerms(sourceTitle)
  const material =
    sourceMaterials.length === 1 || sourceMaterials.join(' ') === 'stainless steel'
      ? sourceMaterials
      : []
  const base = target ? unique([...material, ...target.modifiers, target.head]).join(' ') : raw
  const capacity =
    target && ['scoop', 'spoon', 'cup', 'bottle', 'mug', 'bowl'].includes(target.head)
      ? dimensions.filter((d) => / (?:oz|ml|cup)$/.test(d))
      : []
  // Use one stated capacity, never a conversion or an unlabelled number, in an upstream query.
  const exact = capacity.length === 1 ? capacity[0] : ''
  return {
    query: base && exact ? base + ' ' + exact : base,
    fallbackQuery: base && exact ? base : '',
    sourceTitle,
    sourceSpecs,
    packs,
    dimensions,
    sourceMaterials,
    head: target?.head,
    purpose: target?.purpose ?? [],
    raw,
  }
}
function volumeMl(dimension: string) {
  const [number, ...rest] = dimension.split(' '),
    [top, bottom] = number.split('/').map(Number),
    unit = rest.join(' ')
  const factor: Record<string, number> = { ml: 1, 'fl oz': 29.57353, cup: 236.588 }
  return (top / (bottom ?? 1)) * (factor[unit] ?? NaN)
}
export function qualify(
  item: { title: string | null; specs: string | null },
  terms: ReturnType<typeof comparisonTerms>,
) {
  if (!item.title) return null
  const text = [item.title, item.specs].filter(Boolean).join(' · '),
    tokens = words(text)
  const reasons: string[] = []
  let score = 0
  if (!terms.head) {
    if (!terms.raw || !item.title.includes(terms.raw)) return null
    reasons.push('原文品名相符：' + terms.raw)
  } else {
    const core = words(item.title.split(usage)[0])
    const matched = family(terms.head).find((w) => core.includes(w))
    const leaf = words(
      clauses(item.title)[0]
        .split(usage)[0]
        .split(/\bwith\b/i)[0],
    ).findLast((w) => nouns.has(w) || accessories.has(w))
    if (!matched || (leaf && accessories.has(leaf) && leaf !== terms.head)) return null
    const titleTokens = words(item.title)
    const uses = terms.purpose.filter((w) => purposeHit(w, titleTokens))
    if (uses.length < Math.min(terms.purpose.length, 2)) return null
    reasons.push('品类：' + matched, ...(uses.length ? ['用途：' + uses.join(' ')] : []))
    score += uses.length * 2 + Number(matched === terms.head)
  }
  const candidateMaterials = tokens.filter((w) => materials.has(w))
  if (terms.sourceMaterials.length && candidateMaterials.length) {
    const same = candidateMaterials.some((w) => terms.sourceMaterials.includes(w))
    score += same ? 2 : -2
    reasons.push(
      (same ? '材质描述：' : '材质描述不同：来源 ' + terms.sourceMaterials.join('/') + '，Amazon ') +
        candidateMaterials.join('/'),
    )
  }
  const candidatePacks = packSizes(text)
  if (terms.packs.length && candidatePacks.length) {
    const overlap = candidatePacks.some((p) => terms.packs.includes(p))
    reasons.push(
      '来源 ' +
        terms.packs.join('/') +
        ' 件装，Amazon ' +
        candidatePacks.join('/') +
        ' 件装' +
        (overlap ? '' : '（包装数量不同）'),
    )
    score += overlap ? 2 : -3
  } else if (terms.packs.length) reasons.push('Amazon 件数待核')
  const candidateMeasures = measures(text),
    specMatches = terms.dimensions.filter((m) => candidateMeasures.includes(m))
  if (specMatches.length) {
    score += 3
    reasons.push('规格交集：' + specMatches.join('、'))
  } else if (terms.dimensions.length && candidateMeasures.length) {
    const pair = terms.dimensions
      .flatMap((a) => candidateMeasures.map((b) => [a, b]))
      .find(([a, b]) => Math.abs(volumeMl(a) / volumeMl(b) - 1) < 0.015)
    if (pair) {
      reasons.push(pair.join(' 与 ') + ' 折算容量接近')
      score += 3
    } else {
      reasons.push(
        '规格需核实：来源 ' + terms.dimensions.join('/') + '，Amazon ' + candidateMeasures.join('/'),
      )
      score -= 2
    }
  } else if (terms.dimensions.length) reasons.push('Amazon 尺寸或容量待核')
  return { score, basis: reasons.join('；') }
}
