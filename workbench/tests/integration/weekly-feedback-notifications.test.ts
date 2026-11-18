import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionBindings } from '../../packages/connections/credentials'
import { providerCredentials, replaceCredentials } from '../../packages/connections/credentials'
import type { FeedbackRun } from '../../packages/weekly-feedback/report'
import { notificationDraft } from '../../packages/weekly-feedback/report'
import { sendWeeklyNotifications } from '../../packages/weekly-feedback/wecom'
import { investigationFixture } from './assistant-run-fixture'

afterEach(() => vi.unstubAllGlobals())
it('saves enterprise app credentials encrypted in the existing vault', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec("UPDATE accounts SET role='admin' WHERE id='bob'")
    const bindings = { ...env, CONNECTIONS_KEY: 'ab'.repeat(32) }
    const credentials = {
      WECOM_CORP_ID: 'wwtest',
      WECOM_AGENT_ID: '10001',
      WECOM_SECRET: 'private-secret',
    }
    await replaceCredentials(bindings, 'wecom', credentials, { id: 'bob', local: false })
    expect((await providerCredentials(bindings, 'wecom')).credentials).toEqual(credentials)
    expect(
      JSON.stringify(db.prepare("SELECT * FROM connection_credentials WHERE provider='wecom'").get()),
    ).not.toContain('private-secret')
  } finally {
    db.close()
  }
})
it('groups an ASIN by assigned operator without giving another operator their SKU', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0); INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('r','SELLERA','ATVPDKIKX0DER','2026-11-02','2026-11-04','done');
      INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('carol','运营丙','operator','','');
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES('r','SKU-A','B000000001','Mug','child'),('r','SKU-B','B000000001','Mug','child');
      INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','SKU-A','bob','manual','bob','now'),('SELLERA','ATVPDKIKX0DER','SKU-B','carol','manual','bob','now');
      INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now'),('carol','wecom_carol','bob','now');`)
    db.prepare(
      "INSERT INTO weekly_feedback_items(run,asin,data,status) VALUES('r','B000000001',?,'available')",
    ).run(
      JSON.stringify({
        asin: 'B000000001',
        period: null,
        topics: [{ name: 'Print Quality', mentions: 12, snippets: ['Blurry print'] }],
      }),
    )
    const run = db.prepare("SELECT * FROM weekly_feedback_runs WHERE id='r'").get()!
    const draft = await notificationDraft(env.DB, run as unknown as FeedbackRun)
    expect(draft).toMatchObject({
      unassigned: 0,
      groups: [
        { accountId: 'bob', text: expect.stringContaining('SKU：SKU-A') },
        { accountId: 'carol', text: expect.stringContaining('SKU：SKU-B') },
      ],
    })
    expect(draft.groups[0].text).not.toContain('SKU-B')
    const send = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/gettoken')
        ? Response.json({ access_token: 'private-token', expires_in: 7200, errcode: 0 })
        : Response.json({ errcode: 0, errmsg: 'ok' }),
    )
    vi.stubGlobal('fetch', send)
    const bindings: ConnectionBindings = {
      ...env,
      WECOM_CORP_ID: 'wwtest',
      WECOM_AGENT_ID: '10001',
      WECOM_SECRET: 'private-secret',
    }
    await sendWeeklyNotifications(bindings, 'r')
    await sendWeeklyNotifications(bindings, 'r', true)
    expect(send.mock.calls.filter(([input]) => String(input).includes('/message/send'))).toHaveLength(2)
    expect(
      db.prepare("SELECT count(*) n FROM weekly_feedback_deliveries WHERE status='sent'").get()?.n,
    ).toBe(2)
    db.exec(
      "DELETE FROM weekly_feedback_deliveries; INSERT INTO weekly_feedback_deliveries(run,account_id,status,created_at,updated_at) VALUES('r','bob','preparing','2000-01-01','2000-01-01'),('r','carol','sending','2000-01-01','2000-01-01')",
    )
    await sendWeeklyNotifications(bindings, 'r', true)
    expect(send.mock.calls.filter(([input]) => String(input).includes('/message/send'))).toHaveLength(3)
    expect(
      db.prepare("SELECT status FROM weekly_feedback_deliveries WHERE account_id='carol'").get()?.status,
    ).toBe('unknown')
  } finally {
    db.close()
  }
})

it('does not retry an uncertain send and never exposes token or secret errors', async () => {
  const { db, env } = investigationFixture()
  try {
    db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',0); INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('r','SELLERA','ATVPDKIKX0DER','2026-11-02','now','done');
      INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES('r','SKU-A','B000000001','Mug','child');
      INSERT INTO weekly_feedback_owners VALUES('SELLERA','ATVPDKIKX0DER','SKU-A','bob','manual','bob','now');
      INSERT INTO weekly_feedback_members VALUES('bob','wecom_bob','bob','now');`)
    db.prepare(
      "INSERT INTO weekly_feedback_items(run,asin,data,status) VALUES('r','B000000001',?,'available')",
    ).run(
      JSON.stringify({
        asin: 'B000000001',
        period: null,
        topics: [{ name: 'Print Quality', mentions: 12, snippets: [] }],
      }),
    )
    const send = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/gettoken'))
        return Response.json({ access_token: 'private-token', errcode: 0 })
      throw new Error('private-token private-secret')
    })
    vi.stubGlobal('fetch', send)
    const bindings = {
      ...env,
      WECOM_CORP_ID: 'wwtest',
      WECOM_AGENT_ID: '10001',
      WECOM_SECRET: 'private-secret',
    }
    await sendWeeklyNotifications(bindings, 'r')
    await sendWeeklyNotifications(bindings, 'r', true)
    expect(send.mock.calls.filter(([input]) => String(input).includes('/message/send'))).toHaveLength(1)
    expect(db.prepare('SELECT status,error FROM weekly_feedback_deliveries').get()).toMatchObject({
      status: 'unknown',
      error: '企业微信未返回明确发送结果，请人工核对，系统不会自动重发。',
    })
  } finally {
    db.close()
  }
})
