import { dailyOutstandingAllocationSql } from '../assistant/budget'
import { PublicError } from '../contracts/errors'
import { hash } from '../operations/jobs'
import { businessClock } from '../operations/model'
import { bounds, charged, type Envelope, sendRequest } from '../operations/providers'
import { dispatch } from '../operations/service-queue'
import { type ConnectionBindings, providerCredentials, redactJson } from './credentials'

export async function paidReviewSummary(
  env: ConnectionBindings & { ARCHIVE: R2Bucket },
  identity: { owner: string; authorize?: () => Promise<void>; retryKnownFailure?: boolean },
  sample: unknown,
  build: (credentials: ConnectionBindings) => Request,
): Promise<Envelope> {
  const key = 'review-summary:' + (await hash(JSON.stringify(sample))),
    prefix = 'reviews/ai/' + (await hash(key)) + '/'
  return dispatch(
    env.DB,
    'ai',
    {
      owner: identity.owner,
      shouldContinue: async () => {
        await identity.authorize?.()
        return true
      },
    },
    async () => {
      const existing = await env.DB.prepare(
        'SELECT step_key,state FROM usage_reservations WHERE direct_key=? ORDER BY rowid DESC LIMIT 1',
      )
        .bind(key)
        .first<{ step_key: string; state: string }>()
      const count = await env.DB.prepare('SELECT COUNT(*) n FROM usage_reservations WHERE direct_key=?')
        .bind(key)
        .first<{ n: number }>()
      const stepKey = 'summary-' + ((count?.n ?? 0) + 1),
        ref = prefix + stepKey + '.json'
      if (existing) {
        const object = await env.ARCHIVE.get(prefix + existing.step_key + '.json')
        if (!object) throw new PublicError('USAGE_UNCERTAIN', '评论总结费用待核对，未自动重发。', 409)
        const envelope = await object.json<Envelope>(),
          cost = charged(envelope, 'micros')
        await env.DB.prepare(
          'UPDATE usage_reservations SET actual=?,state=? WHERE direct_key=? AND step_key=?',
        )
          .bind(cost, cost === null ? 'uncertain' : 'confirmed', key, existing.step_key)
          .run()
        if (cost === null)
          throw new PublicError('USAGE_UNCERTAIN', '评论总结费用未知，已保留预留。', 409)
        if (cost > bounds.terra)
          throw new PublicError('USAGE_OVERRUN', '模型实际费用超过预留上限，已按回执记账。', 409)
        if (!(identity.retryKnownFailure && envelope.status >= 400 && cost === 0)) return envelope
      }

      const { credentials } = await providerCredentials(env, 'openrouter')
      if (!credentials.OPENROUTER_API_KEY)
        throw new PublicError('NOT_CONFIGURED', '尚未配置评论总结模型。', 409)
      const request = build({ ...env, ...credentials }),
        day = businessClock().slice(0, 10)
      await identity.authorize?.()
      const reserved =
        await env.DB.prepare(`INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at)
   SELECT ?1,?5,'micros',?2,?3,'reserved',?4 WHERE (SELECT COUNT(*) FROM usage_reservations WHERE direct_key=?1)=?6 AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE unit='micros' AND business_date=?2 AND actual>reserved)
   AND ?3+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='micros' AND business_date=?2)+${dailyOutstandingAllocationSql('micros', '?2')}<=(SELECT json_extract(settings_json,'$.aiDailyMicros') FROM strategy_versions ORDER BY version DESC LIMIT 1) ON CONFLICT DO NOTHING RETURNING rowid`)
          .bind(key, day, bounds.terra, new Date().toISOString(), stepKey, count?.n ?? 0)
          .first()
      if (!reserved) throw new PublicError('AI_BUDGET', '团队 AI 预算不足，评论总结未发送。', 409)
      let envelope: Envelope
      try {
        envelope = await sendRequest(request, env.OPENROUTER_US)
        envelope = redactJson(envelope, [credentials.OPENROUTER_API_KEY]) as Envelope
        if (
          !(await env.ARCHIVE.put(ref, JSON.stringify(envelope), {
            onlyIf: { etagDoesNotMatch: '*' },
            httpMetadata: { contentType: 'application/json' },
          }))
        )
          throw new Error('归档冲突')
      } catch {
        await env.DB.prepare(
          "UPDATE usage_reservations SET state='uncertain' WHERE direct_key=? AND step_key=?",
        )
          .bind(key, stepKey)
          .run()
        throw new PublicError(
          'USAGE_UNCERTAIN',
          '评论总结发送或归档未确认，已保留预留，不自动重发。',
          409,
        )
      }
      const cost = charged(envelope, 'micros')
      await env.DB.prepare(
        'UPDATE usage_reservations SET actual=?,state=? WHERE direct_key=? AND step_key=?',
      )
        .bind(cost, cost === null ? 'uncertain' : 'confirmed', key, stepKey)
        .run()
      if (cost === null) throw new PublicError('USAGE_UNCERTAIN', '评论总结费用未知，已保留预留。', 409)
      if (cost > bounds.terra)
        throw new PublicError('USAGE_OVERRUN', '模型实际费用超过预留上限，已按回执记账。', 409)
      return envelope
    },
  )
}
