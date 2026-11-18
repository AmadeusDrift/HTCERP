import { z } from 'zod'
import { type ConnectionBindings, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { type FeedbackRun, notificationDraft } from './report'

async function wecomToken(env: ConnectionBindings) {
  const { credentials } = await providerCredentials(env, 'wecom')
  const { WECOM_CORP_ID, WECOM_AGENT_ID, WECOM_SECRET } = credentials
  if (!WECOM_CORP_ID || !WECOM_SECRET || !/^\d+$/.test(WECOM_AGENT_ID ?? ''))
    throw new PublicError('NOT_CONFIGURED', '请配置企业微信 Corp ID、数字 Agent ID 和应用 Secret。', 409)
  try {
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken')
    url.search = new URLSearchParams({ corpid: WECOM_CORP_ID, corpsecret: WECOM_SECRET }).toString()
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) })
    const data = z
      .object({ errcode: z.number().optional(), access_token: z.string().min(1).optional() })
      .parse(await response.json())
    if (!response.ok || data.errcode || !data.access_token) throw new Error()
    return { token: data.access_token, agentid: Number(WECOM_AGENT_ID) }
  } catch {
    throw new PublicError(
      'SOURCE_AUTH',
      '企业微信连接验证失败，请检查应用凭据、应用可见范围和可信 IP 配置。',
      502,
    )
  }
}
export async function testWecom(env: ConnectionBindings) {
  await wecomToken(env)
  return { ok: true, message: '企业微信应用凭据验证通过；成员可见范围需通过实际通知核验。' }
}
function boundedText(text: string, link: string) {
  text = text.replaceAll('<', '＜').replaceAll('>', '＞')
  const tail = '\n\n完整周报：' + link
  let value = ''
  const encoder = new TextEncoder()
  for (const char of text) {
    if (encoder.encode(value + char + tail).length > 1900) return value + '\n…' + tail
    value += char
  }
  return value
}
export async function sendWeeklyNotifications(
  env: ConnectionBindings,
  runId: string,
  retryFailed = false,
) {
  const run = await env.DB.prepare(
    "SELECT * FROM weekly_feedback_runs WHERE id=? AND status IN ('done','partial') AND seller=(SELECT seller FROM title_audit_store WHERE singleton=1)",
  )
    .bind(runId)
    .first<FeedbackRun>()
  if (!run) throw new PublicError('NOT_FOUND', '找不到已完成的当前店铺差评周报。', 404)
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString()
  await env.DB.prepare(
    "UPDATE weekly_feedback_deliveries SET status='unknown',error='发送过程被中断，请人工核对送达结果，系统不会自动重发。',updated_at=? WHERE run=? AND status='sending' AND updated_at<?",
  )
    .bind(new Date().toISOString(), run.id, cutoff)
    .run()
  await env.DB.prepare(
    "DELETE FROM weekly_feedback_deliveries WHERE run=? AND status='preparing' AND updated_at<?",
  )
    .bind(run.id, cutoff)
    .run()
  if (retryFailed)
    await env.DB.prepare("DELETE FROM weekly_feedback_deliveries WHERE run=? AND status='failed'")
      .bind(run.id)
      .run()
  const draft = await notificationDraft(env.DB, run)
  const targets = draft.groups.filter((group) => !!group.userid)
  if (!targets.length)
    return {
      sent: 0,
      skipped: draft.unassigned,
      message: '没有已完成运营归属和企业微信成员绑定的商品。',
    }
  let auth: Awaited<ReturnType<typeof wecomToken>> | undefined
  let sent = 0
  for (const target of targets) {
    const now = new Date().toISOString(),
      lease = crypto.randomUUID()
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO weekly_feedback_deliveries(run,account_id,status,created_at,updated_at,lease) VALUES(?,?,'preparing',?,?,?)",
    )
      .bind(run.id, target.accountId, now, now, lease)
      .run()
    if (!claim.meta.changes) continue
    let sending = false
    try {
      auth ??= await wecomToken(env)
      const active = await env.DB.prepare(
        "SELECT 1 FROM accounts a JOIN weekly_feedback_members m ON m.account_id=a.id WHERE a.id=? AND a.active=1 AND a.role IN ('admin','operator') AND m.userid=?",
      )
        .bind(target.accountId, target.userid)
        .first()
      if (!active) throw new PublicError('FORBIDDEN', '运营账号或企业微信绑定已变化，请重新核对。', 409)
      const granted = await env.DB.prepare(
        "UPDATE weekly_feedback_deliveries SET status='sending',updated_at=? WHERE run=? AND account_id=? AND lease=? AND status='preparing' RETURNING account_id",
      )
        .bind(now, run.id, target.accountId, lease)
        .first()
      if (!granted) continue
      sending = true
      const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send')
      url.searchParams.set('access_token', auth.token)
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: target.userid,
          msgtype: 'text',
          agentid: auth.agentid,
          text: { content: boundedText(target.text, target.link) },
          enable_duplicate_check: 1,
          duplicate_check_interval: 1800,
        }),
      })
      const data = z
        .object({
          errcode: z.number(),
          invaliduser: z.string().optional(),
          unlicenseduser: z.string().optional(),
        })
        .parse(await response.json())
      if (!response.ok) throw new Error()
      const accepted = data.errcode === 0 && !data.invaliduser && !data.unlicenseduser
      await env.DB.prepare(
        'UPDATE weekly_feedback_deliveries SET status=?,error=?,updated_at=? WHERE run=? AND account_id=? AND lease=?',
      )
        .bind(
          accepted ? 'sent' : 'failed',
          accepted
            ? null
            : '企业微信拒绝发送（错误码 ' + data.errcode + '），请核对成员、可见范围和可信 IP。',
          new Date().toISOString(),
          run.id,
          target.accountId,
          lease,
        )
        .run()
      if (accepted) sent++
    } catch (error) {
      await env.DB.prepare(
        'UPDATE weekly_feedback_deliveries SET status=?,error=?,updated_at=? WHERE run=? AND account_id=? AND lease=?',
      )
        .bind(
          sending ? 'unknown' : 'failed',
          sending
            ? '企业微信未返回明确发送结果，请人工核对，系统不会自动重发。'
            : error instanceof PublicError
              ? error.message
              : '企业微信准备通知失败，请检查连接。',
          new Date().toISOString(),
          run.id,
          target.accountId,
          lease,
        )
        .run()
    }
  }
  return { sent, skipped: draft.unassigned, message: '通知处理完成，请查看发送记录。' }
}
