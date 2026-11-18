import type { Feedback } from './model'
import { reasonFor, safeImage } from './model'
import type { ProductNames } from './product-names'

export type FeedbackRun = {
  id: string
  seller: string
  marketplace: string
  week: string
  started: string
  finished: string | null
  status: string
  error: string | null
  reported: number
  incomplete: number
}
type Item = {
  asin: string
  data: string | null
  image: string | null
  status: string
  error: string | null
  image_error: string | null
}
type Listing = {
  asin: string
  sku: string
  title: string
  image: string | null
  operator_id: string | null
  operator_name: string | null
  userid: string | null
}
type Action = {
  asin: string
  topic: string
  state: string
  note: string
  updated_by: string
  updated_at: string
}
export async function feedbackRows(
  db: D1Database,
  run: FeedbackRun,
  options: { q?: string; status?: string; page?: number; owner?: string } = {},
) {
  const q = (options.q ?? '').slice(0, 150)
  const where = ['i.run=?'],
    args: (string | number)[] = [run.id]
  if (q) {
    where.push(
      "(instr(lower(i.asin),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(i.data,'$.topics') t WHERE instr(lower(json_extract(t.value,'$.name')),lower(?))>0) OR EXISTS(SELECT 1 FROM weekly_feedback_listings l WHERE l.run=i.run AND l.asin=i.asin AND instr(lower(l.sku||' '||l.title),lower(?))>0))",
    )
    args.push(q, q, q)
  }
  if (options.status && ['available', 'no_data', 'failed'].includes(options.status)) {
    where.push('i.status=?')
    args.push(options.status)
  }
  if (options.owner) {
    where.push(
      "EXISTS(SELECT 1 FROM weekly_feedback_listings l LEFT JOIN weekly_feedback_owners o ON o.seller=? AND o.marketplace=? AND o.sku=l.sku LEFT JOIN accounts a ON a.id=o.account_id AND a.active=1 AND a.role IN ('operator','admin') WHERE l.run=i.run AND l.asin=i.asin AND l.role IN ('child','standalone') AND (?='unassigned' AND a.id IS NULL OR a.id=?))",
    )
    args.push(run.seller, run.marketplace, options.owner, options.owner)
  }
  const filter = where.join(' AND ')
  const total = await db
    .prepare('SELECT count(*) n FROM weekly_feedback_items i WHERE ' + filter)
    .bind(...args)
    .first<number>('n')
  const items = await db
    .prepare(
      'SELECT i.* FROM weekly_feedback_items i WHERE ' +
        filter +
        " ORDER BY CASE i.status WHEN 'available' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,i.asin LIMIT 30 OFFSET ?",
    )
    .bind(...args, (options.page ?? 0) * 30)
    .all<Item>()
  const rows = []
  const asins = JSON.stringify(items.results.map((item) => item.asin))
  const listings = await db
    .prepare(
      "SELECT l.asin,l.sku,l.title,l.image,a.id operator_id,a.username operator_name,m.userid FROM weekly_feedback_listings l LEFT JOIN weekly_feedback_owners o ON o.seller=? AND o.marketplace=? AND o.sku=l.sku LEFT JOIN accounts a ON a.id=o.account_id AND a.active=1 AND a.role IN ('operator','admin') LEFT JOIN weekly_feedback_members m ON m.account_id=a.id WHERE l.run=? AND l.asin IN (SELECT value FROM json_each(?)) AND l.role IN ('child','standalone') ORDER BY l.sku",
    )
    .bind(run.seller, run.marketplace, run.id, asins)
    .all<Listing>()
  const actions = await db
    .prepare(
      'SELECT asin,topic,state,note,updated_by,updated_at FROM weekly_feedback_actions WHERE seller=? AND marketplace=? AND asin IN (SELECT value FROM json_each(?))',
    )
    .bind(run.seller, run.marketplace, asins)
    .all<Action>()
  for (const item of items.results) {
    const linked = listings.results.filter((row) => row.asin === item.asin)
    const data: Feedback | null = item.data ? JSON.parse(item.data) : null
    rows.push({
      asin: item.asin,
      status: item.status,
      error: item.error,
      title: linked[0]?.title || item.asin,
      skus: linked.map((row) => row.sku),
      image: safeImage(linked.find((row) => row.image)?.image ?? item.image),
      imageError: item.image_error,
      assignments: linked.map((row) => ({
        sku: row.sku,
        title: row.title,
        accountId: row.operator_id,
        name: row.operator_name,
      })),
      operatorName: [...new Set(linked.map((row) => row.operator_name ?? '待分配'))].join(' / '),
      period: data?.period ?? null,
      lowRatingCount: data?.lowRatingCount ?? null,
      topics: (data?.topics ?? []).map((topic) => ({
        ...topic,
        ...reasonFor(topic.name),
        handling: actions.results.find((row) => row.asin === item.asin && row.topic === topic.name) ?? {
          state: 'pending',
          note: '',
          updated_by: null,
          updated_at: null,
        },
      })),
    })
  }
  return { total: total ?? 0, rows }
}
export type FeedbackRow = Awaited<ReturnType<typeof feedbackRows>>['rows'][number]

const groupTopicNames = new Map([
  ['advertised vs actual product', '描述与实物不符'],
  ['material quality', '材质质量'],
  ['quality-overall', '整体质量'],
  ['size-overall', '尺寸'],
  ['flatness', '平整度'],
  ['thickness', '厚度'],
  ['stretchability/expandability/elasticity', '伸缩性'],
  ['value for money', '性价比'],
])

const productThemes: [RegExp, string][] = [
  [/\bgreen fairy\b/i, '绿仙子'],
  [/\bgirl and dragon\b/i, '女孩与龙'],
  [/\bchristmas house\b/i, '圣诞小屋'],
  [/\bfairy strawberry house\b/i, '草莓仙子屋'],
  [/\broosters? welcome sign\b/i, '公鸡迎宾'],
  [/\brainbow flower\b/i, '彩虹花'],
  [/\bmushroom shaped house\b/i, '蘑菇屋'],
  [/\babstract tree mosaic\b/i, '马赛克树'],
  [/\btropical beach sunset\b/i, '热带海滩日落'],
  [/\bsunset beach\b/i, '海滩日落'],
  [/\bhalloween witches\b/i, '万圣节女巫'],
  [/\bhalloween bat\b/i, '万圣节蝙蝠'],
  [/\bcat among leaves\b/i, '叶间小猫'],
  [/\bhighland cow\b/i, '高地牛'],
  [/\bhummingbird\b/i, '蜂鸟'],
  [/\bfairy butterfly wings\b/i, '仙子蝶翼'],
  [/\bglass flower tree\b/i, '玻璃花树'],
]

const productTypes: [RegExp, string][] = [
  [/\b(?:charging port )?dust plugs?\b/i, '防尘塞'],
  [/\bgarden stakes?\b/i, '地插'],
  [/\bcanvas (?:wall art|prints?)\b/i, '帆布画'],
  [/\bdesktop decoration\b/i, '桌面摆件'],
  [/\bshaking spring\b/i, '摇摆摆件'],
  [/\b(?:ceramic )?hanging ornaments?\b/i, '挂件'],
  [/\bcoasters?\b/i, '杯垫'],
  [/\bmugs?\b/i, '马克杯'],
]

function shortProductName(title: string) {
  const lead = (title.split(/[,，;；]|\s+[–—-]\s+/u, 1)[0] ?? '').trim()
  const chinese = lead.match(/^\p{Script=Han}+/u)?.[0]
  if (chinese) return [...chinese].slice(0, 10).join('')
  const theme = productThemes.find(([pattern]) => pattern.test(lead))?.[1] ?? ''
  const type = productTypes.find(([pattern]) => pattern.test(lead))?.[1] ?? ''
  return theme + type || '商品名见周报'
}

function groupMessage(
  run: FeedbackRun,
  owner: { accountId: string; name: string },
  result: { rows: FeedbackRow[]; total: number },
  link: string,
  translatedNames: ReadonlyMap<string, string>,
) {
  const lines = result.rows.flatMap((row) => {
    const topics = [...row.topics].sort((a, b) => (b.mentions ?? -1) - (a.mentions ?? -1))
    const reasons = [...new Set(topics.map((topic) => {
      const name = topic.name.trim().replace(/\s+/g, ' ')
      return groupTopicNames.get(name.toLowerCase()) ??
        (topic.label === '待人工归类' ? [...name].slice(0, 32).join('') : topic.label)
    }).filter(Boolean))].slice(0, 3)
    const low = row.lowRatingCount === null ? '未统计' : `${row.lowRatingCount} 条`
    return row.assignments
      .filter((assignment) => assignment.accountId === owner.accountId)
      .map(({ sku, title }) => {
        const name = translatedNames.get(title) ?? shortProductName(title)
        const fields = [name, sku, row.asin, low, reasons.join('、') || '暂无主题']
        return { sku, text: fields.join('｜') }
      })
  }).sort((a, b) => a.sku.localeCompare(b.sku))
  const complete = result.total === result.rows.length
  const header = [`商品差评周报｜${run.week}｜${owner.name}`]
  if (complete) {
    const low = result.rows.reduce((sum, row) => sum + (row.lowRatingCount ?? 0), 0)
    const count = result.rows.every((row) => row.lowRatingCount !== null)
      ? `｜上周新增低星 ${low} 条`
      : ''
    header.push(`${lines.length} 个 SKU${count}`)
  }
  header.push('主要原因来自 Amazon 历史评价主题统计。')
  if (run.status === 'partial') header.push('本期部分完成，详见 ERP。')
  const suffix = '\n\n查看周报：' + link
  const omitted = '\n其余商品见完整周报。'
  const encoder = new TextEncoder()
  let body = header.join('\n')
  for (const [index, line] of lines.entries()) {
    const next = body + `\n\n${index + 1}. ${line.text}`
    const tail = !complete || index < lines.length - 1 ? omitted + suffix : suffix
    if (encoder.encode(next + tail).length > 2000) return body.trimEnd() + omitted + suffix
    body = next
  }
  return body.trimEnd() + (complete ? '' : omitted) + suffix
}

export async function notificationDraft(
  db: D1Database,
  run: FeedbackRun,
  options: { names?: ProductNames; recipients?: ReadonlySet<string> } = {},
) {
  const owners = await db
    .prepare(
      "SELECT DISTINCT a.id accountId,a.username name,m.userid FROM weekly_feedback_listings l JOIN weekly_feedback_owners o ON o.sku=l.sku AND o.seller=? AND o.marketplace=? JOIN accounts a ON a.id=o.account_id AND a.active=1 AND a.role IN ('operator','admin') LEFT JOIN weekly_feedback_members m ON m.account_id=a.id JOIN weekly_feedback_items i ON i.run=l.run AND i.asin=l.asin AND i.status='available' WHERE l.run=? AND l.role IN ('child','standalone') ORDER BY a.username",
    )
    .bind(run.seller, run.marketplace, run.id)
    .all<{ accountId: string; name: string; userid: string | null }>()
  const unassigned = await feedbackRows(db, run, { status: 'available', owner: 'unassigned' })
  const groups = []
  for (const owner of owners.results) {
    if (options.recipients && !options.recipients.has(owner.accountId)) continue
    const result = await feedbackRows(db, run, { status: 'available', owner: owner.accountId })
    const titles = result.rows.flatMap((row) => row.assignments
      .filter((assignment) => assignment.accountId === owner.accountId)
      .map((assignment) => assignment.title))
    const translatedNames = await options.names?.(titles) ?? new Map<string, string>()
    const lines = [
      `商品差评原因周报｜${run.week}`,
      '负责运营：' + owner.name,
      '数据为 Amazon 统计区间内负面主题，非本周新增差评。',
    ]
    if (run.status === 'partial') lines.push('本期部分完成，请在专区查看未核齐及读取失败记录。')
    for (const row of result.rows) {
      lines.push(
        '',
        row.title,
        'SKU：' +
          row.assignments
            .filter((assignment) => assignment.accountId === owner.accountId)
            .map((assignment) => assignment.sku)
            .join(' / '),
        'ASIN：' + row.asin,
      )
      if (row.period) lines.push('统计区间：' + row.period.startDate + ' 至 ' + row.period.endDate)
      if (row.lowRatingCount !== null) lines.push('上周新增低星评价：' + row.lowRatingCount + ' 条')
      for (const topic of row.topics)
        lines.push(
          `• ${topic.label}（${topic.name}）：提及 ${topic.mentions ?? '未知'} 次；${topic.action}`,
        )
    }
    if (result.total > result.rows.length)
      lines.push(`另有 ${result.total - result.rows.length} 个商品，请在差评专区查看。`)
    const link =
      'https://htcerp.app/feedback?run=' +
      encodeURIComponent(run.id) +
      '&owner=' +
      encodeURIComponent(owner.accountId)
    groups.push({
      ...owner,
      total: result.total,
      text: lines.join('\n') + '\n\n查看周报：' + link,
      groupText: groupMessage(run, owner, result, link, translatedNames),
      link,
    })
  }
  const pending = unassigned.rows
    .map(
      (row) =>
        'SKU：' +
        row.assignments
          .filter((a) => !a.accountId)
          .map((a) => a.sku)
          .join(' / ') +
        '\nASIN：' +
        row.asin,
    )
    .join('\n')
  return {
    ready: groups.some((group) => !!group.userid),
    sent: false,
    unassigned: unassigned.total,
    groups,
    text:
      groups.map((group) => group.groupText).join('\n\n────────\n\n') +
      (unassigned.total ? '\n\n待分配商品：' + unassigned.total + '\n' + pending : ''),
    reason: '通知按运营归属分别生成；未分配或未绑定企业微信成员的记录不会发送。',
  }
}
