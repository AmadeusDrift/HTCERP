import type { WorkflowStep } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { AmazonUS } from '../../packages/amazon/adapter'
import { batchInfringementMessages, drainGroupNotifications, enqueueDelivery, infringementMessage, infringementText, queueWeeklyGroup } from '../../packages/group-notifications/delivery'
import { archiveInfringementHistory, previewInfringement, queueInfringements, recordInfringements, scanInfringements } from '../../packages/group-notifications/infringement'
import { groupNotificationRoutes } from '../../packages/group-notifications/routes'
import { auditPage } from '../../packages/title-audit/listings'
import { weeklyProductNames } from '../../packages/weekly-feedback/product-names'
import { investigationFixture } from './assistant-run-fixture'

afterEach(() => vi.unstubAllGlobals())

it('translates an unfamiliar product title once and reuses its Chinese name in previews', async () => {
  const { db, env, fetch } = investigationFixture()
  const title = 'Little Raccoon Night Light, Birthday Gift'
  try {
    fetch.mockResolvedValue(Response.json({
      choices: [{ message: { content: '{"0":"小浣熊夜灯"}' } }],
      usage: { cost: 0.00001 },
    }))
    expect((await weeklyProductNames(env)([title])).has(title)).toBe(false)
    expect((await weeklyProductNames(env, true)([title, title])).get(title)).toBe('小浣熊夜灯')
    expect((await weeklyProductNames(env)([title])).get(title)).toBe('小浣熊夜灯')
    expect((await weeklyProductNames(env, true)([title])).get(title)).toBe('小浣熊夜灯')
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = await fetch.mock.calls[0][0].json() as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1].content)).toEqual([{ id: 0, title }])
  } finally {
    db.close()
  }
})

it('advances the infringement scan after one split retry when Amazon exhausts pagination below its reported total', async () => {
  const { db, env } = investigationFixture()
  const tick = Date.parse('2026-11-12T12:00:00Z')
  const through = tick - 120000
  db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
    INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('test','测试群','trial',1);`)
  db.prepare('INSERT INTO notification_infringement_scan(seller,through_ms) VALUES(?,?)')
    .run('SELLERA', through - 3600000)
  const step = {
    do: async (_name: string, task: () => Promise<unknown>) => task(),
  } as unknown as WorkflowStep
  const flagged = (sku: string) => ({ sku, issues: [{ code: '18146', message: 'Trademark misuse' }] })
  const shortPage = { numberOfResults: 8, items: ['A', 'B', 'C', 'D'].map(flagged) }
  const api = vi.spyOn(AmazonUS.prototype, 'recentlyUpdatedListings')
    .mockResolvedValue(shortPage)
    .mockResolvedValueOnce(shortPage)
    .mockResolvedValueOnce(shortPage)
    .mockResolvedValueOnce({ numberOfResults: 2, items: [flagged('E')], pagination: { nextToken: 'next' } })
    .mockResolvedValueOnce({ numberOfResults: 2, items: [flagged('F')] })
  try {
    await scanInfringements(env, step, tick, 'test-lease')
    expect(db.prepare('SELECT through_ms, lease, error FROM notification_infringement_scan').get())
      .toMatchObject({ through_ms: through, lease: null, error: expect.stringContaining('1 个时间段') })
    expect(api).toHaveBeenCalledTimes(4)
    expect(api.mock.calls[3][3]).toBe('next')
    expect(db.prepare('SELECT sku FROM notification_infringements ORDER BY sku').all().map((r) => r.sku))
      .toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(db.prepare('SELECT count(*) AS n FROM notification_infringement_events').get()?.n).toBe(6)
    expect(db.prepare('SELECT count(*) AS n FROM notification_deliveries').get()?.n).toBe(0)
  } finally {
    api.mockRestore()
    db.close()
  }
})

it('keeps the infringement scan inside the configured start date even with an old cursor', async () => {
  const { db, env } = investigationFixture()
  const start = '2026-11-13T00:00:00+08:00'
  const earliest = Date.parse(start)
  const bindings = { ...env, INFRINGEMENT_SCAN_START: start }
  db.exec("INSERT INTO title_audit_store VALUES(1,'SELLERA',0); INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('test','测试群','trial',1)")
  db.prepare('INSERT INTO notification_infringement_scan(seller,through_ms) VALUES(?,?)')
    .run('SELLERA', earliest - 7 * 86400000)
  const step = { do: async (_name: string, task: () => Promise<unknown>) => task() } as unknown as WorkflowStep
  const api = vi.spyOn(AmazonUS.prototype, 'recentlyUpdatedListings').mockResolvedValue({ numberOfResults: 0, items: [] })
  try {
    await scanInfringements(bindings, step, earliest, 'before')
    expect(api).not.toHaveBeenCalled()
    await scanInfringements(bindings, step, earliest + 1800000, 'first')
    expect(api).toHaveBeenLastCalledWith('SELLERA', earliest, earliest + 1680000, undefined)
    await scanInfringements(bindings, step, earliest + 3600000, 'next')
    expect(api).toHaveBeenLastCalledWith('SELLERA', earliest + 1380000, earliest + 3480000, undefined)
  } finally {
    api.mockRestore()
    db.close()
  }
})

it('archives historical Amazon issues without overwriting current records or adding deliveries', async () => {
  const { db, env } = investigationFixture()
  const cutoff = '2026-11-13T00:00:00+08:00'
  const now = '2026-11-13T02:00:00.000Z'
  const old = '2026-11-12T15:59:59.999Z'
  const scope = { ...env, INFRINGEMENT_SCAN_START: cutoff }
  const step = { do: async (_key: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)() } as unknown as WorkflowStep
  db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
    INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('test','测试群','trial',1);
    INSERT INTO notification_routes VALUES('infringement','test','2026-11-12T16:00:00.000Z');
    INSERT INTO notification_group_members VALUES('test','bob',1);
    INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');
    INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','OLD','bob','manual','bob','now');`)
  const flagged = (sku: string, message: string) => ({ sku, issues: [{ code: '18146', message }] })
  const api = vi.spyOn(AmazonUS.prototype, 'recentlyUpdatedListings')
    .mockResolvedValueOnce({ numberOfResults: 2, items: [flagged('OLD', 'Trademark misuse'), flagged('CURRENT', 'Trademark misuse')] })
    .mockResolvedValueOnce({ numberOfResults: 0, items: [] })
  try {
    await recordInfringements(env.DB, 'SELLERA', [flagged('CURRENT', 'Updated trademark misuse')], now)
    const report = await archiveInfringementHistory(scope, step, 'test-history')
    expect(report).toMatchObject({ to: old, pages: 2, inserted: 1, gaps: 0 })
    expect(db.prepare('SELECT sku,changed_at,issue_details FROM notification_infringements ORDER BY sku').all()).toEqual([
      expect.objectContaining({ sku: 'CURRENT', changed_at: now, issue_details: expect.stringContaining('Updated trademark misuse') }),
      expect.objectContaining({ sku: 'OLD', changed_at: report.observed }),
    ])
    await queueInfringements(scope)
    expect(db.prepare('SELECT content FROM notification_deliveries').all()).toEqual([
      expect.objectContaining({ content: expect.stringContaining('SKU：CURRENT') }),
    ])
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_scan').get()?.n).toBe(0)
  } finally {
    api.mockRestore()
    db.close()
  }
})

it('isolates test groups from scheduled traffic and switches a service without replaying a weekly report', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
      INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('r','SELLERA','ATVPDKIKX0DER','2026-11-09','now','done');
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES('r','SKU-A','B000000001','Mug','child');
      INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','SKU-A','bob','manual','bob','now');
      INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');
      INSERT INTO weekly_feedback_items(run,asin,data,status) VALUES('r','B000000001','{"asin":"B000000001","period":null,"topics":[]}','available');`)
    db.exec(`UPDATE weekly_feedback_items SET data='{"asin":"B000000001","period":{"startDate":"2026-05-01","endDate":"2026-11-01"},"lowRatingCount":2,"topics":[{"name":"Material Quality","mentions":3,"snippets":[]}]}' WHERE asin='B000000001';
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES('r','SKU-B','B000000002','Christmas House Acrylic Garden Stake, Long product title','child');
      INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','SKU-B','bob','manual','bob','now');
      INSERT INTO weekly_feedback_items(run,asin,data,status) VALUES('r','B000000002','{"asin":"B000000002","period":null,"lowRatingCount":1,"topics":[{"name":"Size-Overall","mentions":1,"snippets":[]}]}','available');`)
    const hooks = {
      trial: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-1111',
      haul: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-2222',
    }
    const bindings = {
      ...env,
      CONNECTIONS_KEY: '12'.repeat(32),
      WECOM_GROUP_WEBHOOKS: JSON.stringify({ trial: hooks.trial }),
    }
    const request = (path: string, body: unknown) =>
      groupNotificationRoutes.request(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        bindings,
      )
    const trial = (await (
      await request('/groups', { name: '测试群', webhookKey: 'trial', enabled: true })
    ).json()) as { id: string }
    const created = await request('/groups', { name: 'HAUL 精英群', webhookUrl: hooks.haul, enabled: true })
    expect(created.status).toBe(201)
    const haul = await created.json() as { id: string }
    const stored = db.prepare('SELECT * FROM notification_groups WHERE id=?').get(haul.id)
    expect(stored?.webhook_ciphertext).toEqual(expect.any(String))
    expect(JSON.stringify(stored)).not.toContain('test-2222')
    for (const group of [trial, haul])
      expect(
        (await request(`/groups/${group.id}/members`, { accountId: 'bob', enabled: true })).ok,
      ).toBe(true)
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ errcode: 0 }),
    )
    vi.stubGlobal('fetch', send)
    await queueWeeklyGroup(bindings.DB, 'r')
    await drainGroupNotifications(bindings)
    expect(send).not.toHaveBeenCalled()
    expect((await request('/services/feedback', { groupId: haul.id })).ok).toBe(true)
    await queueWeeklyGroup(bindings.DB, 'r')
    await drainGroupNotifications(bindings)
    expect(
      send.mock.calls.map(([url, init]) => [
        String(url),
        JSON.parse(String(init?.body)).text.mentioned_list,
      ]),
    ).toEqual([[hooks.haul, ['wecom_bob']]])
    const content = JSON.parse(String(send.mock.calls[0]?.[1]?.body)).text.content as string
    expect(content).toContain('\n1. 马克杯｜SKU-A｜B000000001｜2 条｜材质质量\n\n2. 圣诞小屋地插｜SKU-B｜B000000002｜1 条｜尺寸\n')
    expect(content).not.toMatch(/Long product title|Christmas House|统计区间|2026-05-01/)
    expect((await request('/services/feedback', { groupId: trial.id })).ok).toBe(true)
    await queueWeeklyGroup(bindings.DB, 'r')
    await drainGroupNotifications(bindings)
    expect(send).toHaveBeenCalledTimes(1)
    await enqueueDelivery(bindings.DB, {
      id: 'legacy-trial',
      service: 'infringement',
      groupId: trial.id,
      accountId: 'bob',
      content: 'fixture',
      image: null,
      trial: true,
    }).run()
    await drainGroupNotifications(bindings)
    expect(String(send.mock.calls.at(-1)?.[0])).toBe(hooks.trial)
    const list = await (await groupNotificationRoutes.request('/', {}, bindings)).text()
    for (const value of ['test-2222', 'test-1111', String(stored?.webhook_ciphertext)])
      expect(list).not.toContain(value)
  } finally {
    db.close()
  }
})

it('includes the listing title in the reminder and only creates events for newly appearing Amazon issues', async () => {
  const { db, env } = investigationFixture()
  try {
    const listing = {
      sku: 'SKU-A',
      summaries: [
        { marketplaceId: 'ATVPDKIKX0DER', asin: 'B0HQPCP2JX', itemName: 'Black Panther T-Shirt', lastUpdatedDate: '2026-11-07T00:00:00Z' },
      ],
      issues: [
        {
          code: '18146',
          message: 'Trademark misuse',
          enforcements: {
            actions: [{ action: 'CATALOG_ITEM_REMOVED' }],
            exemption: { status: 'EXEMPT_UNTIL_EXPIRY_DATE' },
          },
        },
      ],
    }
    const at = '2026-11-12T08:00:00Z'
    await recordInfringements(env.DB, 'SELLERA', auditPage.parse({ numberOfResults: 1, items: [listing] }).items, at)
    listing.summaries[0].itemName = 'Black Panther Crew Neck T-Shirt'
    await recordInfringements(env.DB, 'SELLERA', [listing], at)
    await recordInfringements(
      env.DB,
      'SELLERA',
      [{ ...listing, sku: 'OTHER', issues: [{ code: '2', message: 'Image quality' }] }],
      at,
    )
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_events').get()?.n).toBe(1)
    db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
      INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('test','测试群','trial',1);
      INSERT INTO notification_routes VALUES('infringement','test','2026-11-12T00:00:00Z');
      INSERT INTO notification_group_members VALUES('test','bob',1);
      INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','SKU-A','bob','manual','bob','now');
      INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');`)
    await queueInfringements(env)
    const messages = db.prepare('SELECT content FROM notification_deliveries').all()
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('商品标题：Black Panther Crew Neck T-Shirt')
    expect(messages[0].content).toContain('主图：亚马逊 API 未返回，未提供')
    expect(messages[0].content).toContain('亚马逊原文：Trademark misuse（滥用商标）')
    expect(messages[0].content).toContain('亚马逊位置字段：未返回')
    expect(messages[0].content).toContain('时间：2026/11/12 16:00（北京时间）')
    expect(messages[0].content).toContain('ERP 核查：标题命中「Black Panther」')
    const later = '2026-11-12T08:30:00Z'
    listing.issues[0].enforcements.exemption.status = 'NOT_EXEMPT'
    await recordInfringements(env.DB, 'SELLERA', [listing], later)
    await queueInfringements(env)
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_events').get()?.n).toBe(1)
    expect(db.prepare('SELECT count(*) n FROM notification_deliveries').get()?.n).toBe(1)
    const newIssue = { code: '3', message: 'Copyright infringement' }
    await recordInfringements(env.DB, 'SELLERA', [{ ...listing, issues: [...listing.issues, newIssue] }], later)
    await queueInfringements(env)
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_events').get()?.n).toBe(2)
    expect(db.prepare('SELECT count(*) n FROM notification_deliveries').get()?.n).toBe(2)
  } finally {
    db.close()
  }
})

it('uses the existing SKU rule and shares SKU title and ASIN image lookups between preview and delivery', async () => {
  const { db, env } = investigationFixture()
  const sku = 'HUNI-YLPH2020-JIT-882'
  const asin = 'B0HN8915WB'
  const image = 'https://m.media-amazon.com/images/I/sample.jpg'
  const bySku = vi.spyOn(AmazonUS.prototype, 'listingTitleBySku')
    .mockResolvedValue({ asin, title: 'Black Panther Graphic T-Shirt' })
  const byAsin = vi.spyOn(AmazonUS.prototype, 'mainImageByAsin').mockResolvedValue(image)
  try {
    db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
      INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('test','测试群','trial',1);
      INSERT INTO notification_group_members VALUES('test','bob',1);
      INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');
      INSERT INTO weekly_feedback_owner_rules VALUES('SELLERA','ATVPDKIKX0DER','prefix','HUNI',1,'bob','bob');`)
    await recordInfringements(env.DB, 'SELLERA', [{
      sku,
      summaries: [{ marketplaceId: 'ATVPDKIKX0DER', asin }],
      issues: [{ code: '18146', message: 'Trademark misuse' }],
    }], '2026-11-12T12:05:00Z')
    const preview = await previewInfringement(env, sku)
    expect(preview).toMatchObject({ sku, owner: 'bob', asin, image })
    expect(preview?.content).toContain('商品标题：Black Panther Graphic T-Shirt')
    expect(preview?.content).not.toContain('主图：亚马逊 API 未返回，未提供')
    expect(bySku).toHaveBeenCalledWith('SELLERA', sku)
    expect(byAsin).toHaveBeenCalledWith(asin)
    expect(db.prepare('SELECT count(*) AS n FROM notification_deliveries').get()?.n).toBe(0)
    await queueInfringements(env)
    expect(db.prepare('SELECT count(*) AS n FROM notification_deliveries').get()?.n).toBe(0)
    db.exec("INSERT INTO notification_routes VALUES('infringement','test','2026-11-12T00:00:00Z')")
    await queueInfringements(env)
    expect(db.prepare('SELECT account_id,content,image FROM notification_deliveries').all())
      .toEqual([{ account_id: 'bob', content: preview?.content, image }])
  } finally {
    bySku.mockRestore()
    byAsin.mockRestore()
    db.close()
  }
})

it('keeps Amazon location fields and reads previously stored issue messages', async () => {
  const { db, env } = investigationFixture()
  const at = '2026-11-12T08:00:00Z'
  try {
    const listing = {
      sku: 'SKU-A',
      issues: [{ code: '18146', message: 'Trademark misuse', attributeNames: ['item_name', 'brand'] }],
    }
    await recordInfringements(env.DB, 'SELLERA', [{ ...listing, issues: [{ code: '18146', message: 'Trademark misuse' }] }], at)
    const parsed = auditPage.parse({ numberOfResults: 1, items: [listing] })
    await recordInfringements(env.DB, 'SELLERA', parsed.items, at)
    const row = db.prepare('SELECT * FROM notification_infringements').get()!
    const sample = {
      sku: listing.sku,
      asin: null,
      title: 'Metal Keychain for Keys and Bags, Cyber Punk Dog Tag Key Ring',
      observed_at: at,
      name: 'bob',
      fingerprint: String(row.fingerprint),
      issue_details: String(row.issue_details),
    }
    const message = infringementText(sample)
    expect(message).toContain('亚马逊处置：未返回处置动作，执行状态未知')
    expect(message).toContain('亚马逊位置字段：品牌（brand）、商品标题（item_name）')
    expect(message).toContain('ERP 核查：标题含「Cyber Punk」【高风险，待复核】')
    expect(message).not.toContain('标题命中「Tag」')
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_events').get()?.n).toBe(1)
    const removal = ['18146', 'Trademark misuse', ['CATALOG_ITEM_REMOVED']]
    const suppression = ['other', 'Copyright infringement', ['LISTING_SUPPRESSED']]
    const withEnforcements = (...entries: unknown[][]) => infringementText({
      ...sample,
      fingerprint: JSON.stringify(entries.map((entry) => JSON.stringify(entry))),
    })
    expect(withEnforcements([...removal, 'NOT_EXEMPT'])).toContain('亚马逊处置：商品已移除')
    expect(withEnforcements([...removal, 'EXEMPT_UNTIL_EXPIRY_DATE', '2026-11-15T00:30:00Z'], [...suppression, 'NOT_EXEMPT']))
      .toContain('亚马逊处置：暂缓移除商品（豁免至 2026/11/15 08:30，北京时间）；已限制该刊登销售')
    expect(withEnforcements([...removal, 'EXEMPT'])).toContain('亚马逊处置：移除商品已豁免')
    expect(withEnforcements(removal)).toContain('亚马逊处置：移除商品（执行状态未返回）')
    expect(withEnforcements([...removal, 'EXEMPT_UNTIL_EXPIRY_DATE', '2026-11-11T00:30:00Z']))
      .toContain('亚马逊处置：移除商品（豁免已到期，执行结果待确认）')
    const legacy = infringementText({ ...sample, issue_details: null })
    expect(legacy).toContain('亚马逊原文：Trademark misuse（滥用商标）')
    expect(legacy).toContain('亚马逊位置字段：历史记录未保存')
    expect(infringementText({ ...sample, title: 'Dark Knight Dog Tag Key Ring', issue_details: null }))
      .toContain('ERP 核查：标题含「Dark Knight」【高风险，待复核】')
    expect(infringementText({ ...sample, title: 'Cyber-Punk 2077 Poster' }))
      .toContain('ERP 核查：标题命中「Cyber-Punk 2077」（ERP 词库）')
    expect(infringementText({ ...sample, fingerprint: null, issue_details: null }))
      .toContain('ERP 核查：标题未命中品牌或 IP 词条')
  } finally {
    db.close()
  }
})

it('sends official infringements without an available mention, including Jimei listings', async () => {
  const { db, env } = investigationFixture()
  const group = 'official'
  const bindings = {
    ...env,
    WECOM_GROUP_WEBHOOKS: JSON.stringify({ official: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-3333' }),
  }
  db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
    INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('official','精英群','official',1);
    INSERT INTO notification_routes VALUES('infringement','official','2026-11-12T00:00:00Z');
    INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');
    INSERT INTO weekly_feedback_owner_rules VALUES('SELLERA','ATVPDKIKX0DER','prefix','ASSIGNED-',1,'bob','bob');`)
  const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ errcode: 0 }))
  vi.stubGlobal('fetch', send)
  try {
    const listing = (sku: string) => ({
      sku,
      summaries: [{ marketplaceId: 'ATVPDKIKX0DER', itemName: 'Printed Shirt' }],
      issues: [{ code: '18146', message: 'Trademark misuse' }],
    })
    const at = '2026-11-13T08:00:00.000Z'
    await recordInfringements(env.DB, 'SELLERA', ['HUJM.TEST', 'HUJM.SECOND', 'UNKNOWN', 'ASSIGNED-OUTSIDE'].map(listing), at)
    await queueInfringements(bindings)
    await drainGroupNotifications(bindings, 'infringement')
    const messages = () => send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text)
    const jimei = messages().filter(({ content }) => content.includes('HUJM.'))
    expect(jimei).toEqual([{ content: expect.stringContaining('美国站侵权提醒｜集美（2 件商品）') }])
    expect(jimei[0].content).toContain('HUJM.TEST')
    expect(jimei[0].content).toContain('HUJM.SECOND')
    expect(jimei[0].content.match(/Trademark misuse/g)).toHaveLength(1)
    for (const [sku, owner] of [['UNKNOWN', '未匹配'], ['ASSIGNED-OUTSIDE', 'bob']]) {
      const message = messages().find(({ content }) => content.includes('SKU：' + sku))
      expect(message?.content).toContain('涉及运营：' + owner)
      expect(message).not.toHaveProperty('mentioned_list')
    }

    db.prepare('INSERT INTO notification_group_members VALUES(?,?,1)').run(group, 'bob')
    await recordInfringements(env.DB, 'SELLERA', ['ASSIGNED-INSIDE', 'ASSIGNED-REMOVED'].map(listing), at)
    await queueInfringements(bindings)
    await drainGroupNotifications(bindings, 'infringement')
    const bob = messages().filter(({ content }) => content.includes('ASSIGNED-INSIDE'))
    expect(bob).toEqual([{ content: expect.stringContaining('ASSIGNED-REMOVED'), mentioned_list: ['wecom_bob'] }])

    await recordInfringements(env.DB, 'SELLERA', [listing('ASSIGNED-REMOVED-LATER')], at)
    await queueInfringements(bindings)
    db.exec("UPDATE notification_group_members SET enabled=0 WHERE account_id='bob'")
    await drainGroupNotifications(bindings, 'infringement')
    expect(messages().find(({ content }) => content.includes('SKU：ASSIGNED-REMOVED-LATER'))).toEqual({
      content: expect.stringContaining('涉及运营：bob'),
    })
    const later = '2026-11-13T08:30:00.000Z'
    await recordInfringements(env.DB, 'SELLERA', ['HUJM.LATER', 'HUJM.LEGACY', 'HUJM.AFTER'].map(listing), later)
    const legacy = db.prepare("SELECT id FROM notification_infringement_events WHERE sku='HUJM.LEGACY'").get()
    await enqueueDelivery(env.DB, {
      id: 'infringement:' + legacy?.id,
      service: 'infringement', groupId: group, accountId: null, content: 'already delivered',
    }).run()
    db.exec("UPDATE notification_deliveries SET status='sent' WHERE content='already delivered'")
    await recordInfringements(env.DB, 'SELLERA', [listing('HUJM.NEXT-TICK')], '2026-11-13T09:00:00.000Z')
    await queueInfringements(bindings)
    await drainGroupNotifications(bindings, 'infringement')
    const followups = messages().filter(({ content }) => /HUJM\.(?:NEXT-TICK|LATER|AFTER|LEGACY)/.test(content))
    expect(followups).toHaveLength(2)
    expect(followups.find(({ content }) => content.includes('HUJM.LATER'))?.content).toContain('HUJM.AFTER')
    expect(followups.some(({ content }) => content.includes('HUJM.LEGACY'))).toBe(false)
    await queueInfringements(bindings)
    await drainGroupNotifications(bindings, 'infringement')
    expect(send).toHaveBeenCalledTimes(7)
    expect(db.prepare('SELECT count(*) n FROM notification_infringement_deliveries').get()?.n).toBe(10)
  } finally {
    db.close()
  }
})

it('splits oversized infringement batches without dropping products or their individual actions', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    message: infringementMessage({
      sku: 'HUJM.' + index,
      asin: null,
      title: '测试'.repeat(150),
      name: '集美',
      observed_at: '2026-11-13T08:00:00.000Z',
      fingerprint: JSON.stringify([JSON.stringify([
        '18146', 'Trademark misuse', [index === 0 ? 'CATALOG_ITEM_REMOVED' : 'SEARCH_SUPPRESSED'], 'NOT_EXEMPT',
      ])]),
      issue_details: null,
    }),
  }))
  const batches = batchInfringementMessages(rows)
  expect(batches.length).toBeGreaterThan(1)
  expect(batches.flatMap((batch) => batch.rows)).toEqual(rows)
  for (const { content } of batches) expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(2000)
  expect(batches[0].content).toContain('商品已移除')
  expect(batches.at(-1)?.content).toContain('商品已从搜索结果隐藏')
})

it('sends one infringement text followed by all available images in product order', async () => {
  const { db, env } = investigationFixture()
  const bindings = {
    ...env,
    WECOM_GROUP_WEBHOOKS: JSON.stringify({ official: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-3333' }),
  }
  db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0);
    INSERT INTO notification_groups(id,name,webhook_key,enabled) VALUES('official','精英群','official',1);
    INSERT INTO notification_routes VALUES('infringement','official','2026-11-12T00:00:00Z');`)
  const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(16).buffer)
  const send = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).startsWith('https://m.media-amazon.com/'))
      return new Response(String(url).endsWith('A.jpg') ? 'A' : 'B', {
        headers: { 'content-type': 'image/jpeg' },
      })
    return Response.json({ errcode: 0 })
  })
  vi.stubGlobal('fetch', send)
  try {
    await recordInfringements(env.DB, 'SELLERA', ['B', 'A'].map((sku) => ({
      sku: 'HUJM.' + sku,
      summaries: [{
        marketplaceId: 'ATVPDKIKX0DER', itemName: 'Printed Shirt',
        mainImage: { link: `https://m.media-amazon.com/${sku}.jpg` },
      }],
      issues: [{ code: '18146', message: 'Trademark misuse' }],
    })), '2026-11-13T08:00:00.000Z')
    await queueInfringements(bindings)
    await drainGroupNotifications(bindings, 'infringement')
    await drainGroupNotifications(bindings, 'infringement')
    const payloads = send.mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(payloads).toEqual([
      { msgtype: 'text', text: { content: expect.stringMatching(/HUJM\.A[\s\S]+HUJM\.B/) } },
      { msgtype: 'image', image: { base64: 'QQ==', md5: '0'.repeat(32) } },
      { msgtype: 'image', image: { base64: 'Qg==', md5: '0'.repeat(32) } },
    ])
    expect(db.prepare('SELECT status FROM notification_deliveries').get()?.status).toBe('sent')
  } finally {
    digest.mockRestore()
    db.close()
  }
})
