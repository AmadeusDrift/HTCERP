import { z } from 'zod'
import { dailyOutstandingAllocationSql } from '../assistant/budget'
import { type ConnectionBindings, redactJson } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { geekCredential, geekDay, isGeekSlotRefused, nextGeekSlot } from './geekbi'
import {
  bounds,
  charged,
  type Envelope,
  geekRequest,
  isGeekBalanceRejection,
  retryAt,
  sendRequest,
} from './providers'
import { type DispatchIdentity, dispatch } from './service-queue'

type DirectEnv = ConnectionBindings & { ARCHIVE: R2Bucket }
type Selected = NonNullable<Awaited<ReturnType<typeof geekCredential>>>
type Last = {
  id: number
  step_key: string
  credential_slot: number
  balance_refused: number
  credential_revision: string
  business_date: string
}

const sites = z.object({
  code: z.literal(0),
  data: z.array(
    z.object({
      siteId: z.number(),
      regionId: z.number(),
    }),
  ),
})
function verifiedSites(body: unknown) {
  const result = sites.safeParse(body)
  return result.success && result.data.data.some((s) => s.siteId === 48 && s.regionId === 211)
    ? result.data.data.length
    : 0
}
const unknownCost = () =>
  new PublicError('USAGE_UNCERTAIN', '未能确认本次调用，已保留预留积分，请管理员核对。', 409)

// Direct reads have no workflow ID. A stable operation key lets a repeated click reuse archived
// evidence, including failures, if the Worker stopped between the vendor call and saving the report.
async function directRead(
  env: DirectEnv,
  operation: string,
  build: (credentials: Selected['credentials']) => Promise<Request>,
  test?: Selected,
) {
  const db = env.DB,
    estimate = test ? 0 : bounds.geekbi
  const last = await db
    .prepare(
      'SELECT rowid AS id,step_key,credential_slot,balance_refused,credential_revision,business_date FROM usage_reservations WHERE direct_key=? ORDER BY rowid DESC LIMIT 1',
    )
    .bind(operation)
    .first<Last>()
  let previous = last?.id ?? 0,
    fromSlot = 1,
    sawRefusal = !!last?.balance_refused
  let replay = last && (!last.balance_refused || test) ? last : null
  for (;;) {
    let step: string, slot: number, result: Envelope
    const replayed = replay
    if (replay) {
      step = replay.step_key
      slot = replay.credential_slot
      const archived = await env.ARCHIVE.get('geekbi/direct/' + step + '.json')
      if (!archived) throw unknownCost()
      result = await archived.json<Envelope>()
      replay = null
    } else {
      const selected = test ?? (await nextGeekSlot(env, fromSlot, sawRefusal))
      slot = selected.slot
      const request = await build(selected.credentials),
        day = geekDay()
      step = crypto.randomUUID()
      const inserted = await db
        .prepare(
          `INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,credential_slot,credential_revision)
         SELECT ?,?,'points',?,?,'reserved',?,?,?
         WHERE COALESCE((SELECT MAX(rowid) FROM usage_reservations WHERE direct_key=?),0)=?
           AND (?=0 OR NOT EXISTS(SELECT 1 FROM usage_reservations WHERE balance_refused=1 AND business_date=? AND credential_slot=? AND ? IN (credential_revision,legacy_binding_match)))
           AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE unit='points' AND business_date=? AND actual>reserved)
           AND (?=0 OR ?+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='points' AND business_date=?)+${dailyOutstandingAllocationSql('points', '?')}
               <= (SELECT json_extract(settings_json,'$.dataDailyPoints') FROM strategy_versions ORDER BY version DESC LIMIT 1))
         RETURNING rowid AS id`,
        )
        .bind(
          operation,
          step,
          day,
          estimate,
          new Date().toISOString(),
          slot,
          selected.revision,
          operation,
          previous,
          estimate,
          day,
          slot,
          selected.revision,
          day,
          estimate,
          estimate,
          day,
          day,
        )
        .first<{ id: number }>()
      if (!inserted) {
        if (
          await db
            .prepare('SELECT 1 FROM usage_reservations WHERE direct_key=? AND rowid>?')
            .bind(operation, previous)
            .first()
        )
          throw new PublicError('CONFLICT', '此查询已有发送记录，请稍后查看。', 409)
        if (!test && (await isGeekSlotRefused(db, slot, selected.revision))) {
          fromSlot = slot + 1
          sawRefusal = true
          continue
        }
        throw new PublicError('DATA_BUDGET', '团队积分预算不足或需要核对超额记录，本次请求未发送。', 409)
      }
      previous = inserted.id
      try {
        result = await sendRequest(request)
        const tokens = Object.values(selected.credentials)
        result = {
          ...result,
          body: redactJson(result.body, tokens),
          points: redactJson(result.points, tokens) as string | null,
          retryAfter: redactJson(result.retryAfter, tokens) as string | null | undefined,
        }
        if (
          !(await env.ARCHIVE.put('geekbi/direct/' + step + '.json', JSON.stringify(result), {
            onlyIf: { etagDoesNotMatch: '*' },
            httpMetadata: { contentType: 'application/json' },
          }))
        )
          throw unknownCost()
      } catch {
        await db
          .prepare(
            "UPDATE usage_reservations SET state='uncertain',test_status=? WHERE direct_key=? AND step_key=?",
          )
          .bind(test ? 'failed' : null, operation, step)
          .run()
        throw unknownCost()
      }
    }
    const cost = charged(result, 'points'),
      refused = isGeekBalanceRejection(result)
    const verified = test && result.status === 200 && cost === 0 && !!verifiedSites(result.body)
    await db
      .prepare(
        'UPDATE usage_reservations SET actual=?,state=?,balance_refused=?,test_status=? WHERE direct_key=? AND step_key=?',
      )
      .bind(
        cost,
        cost === null ? 'uncertain' : 'confirmed',
        Number(refused),
        test ? (verified ? 'verified' : 'failed') : null,
        operation,
        step,
      )
      .run()
    if (refused) {
      if (test) throw new PublicError('NO_CREDITS', '该组返回余额不足。', 409)
      sawRefusal = true
      fromSlot = slot + 1
      continue
    }
    if (result.status !== 200) {
      if (replayed && !test && result.status >= 400 && cost === 0 && retryAt(result) <= Date.now()) {
        const updated = await geekCredential(env, slot)
        if (
          updated &&
          (replayed.business_date !== geekDay() || updated.revision !== replayed.credential_revision)
        ) {
          fromSlot = slot
          continue
        }
      }
      throw new PublicError('GEEKBI_SOURCE', '极鲸云请求失败（HTTP ' + result.status + '）。', 502)
    }
    if (cost === null) throw unknownCost()
    if (cost > estimate)
      throw new PublicError('USAGE_OVERRUN', '实际扣分超过预留，已按回执记账，请管理员核对。', 409)
    return result
  }
}

export async function readGeekbiReviews(
  env: DirectEnv,
  goodsId: string,
  refreshVersion: number,
  identity: DispatchIdentity = { owner: 'interactive-review' },
) {
  return dispatch(env.DB, 'geekbi', identity, () =>
    directRead(env, 'temu-reviews/US/' + goodsId + '/' + refreshVersion, (credentials) =>
      geekRequest(credentials, 'temu', 'reviews', {
        goodsId,
        regionId: '211',
        scoreMin: '1',
        scoreMax: '2',
        page: '1',
        size: '30',
      }),
    ),
  )
}

export async function readTrackingDetail(env: DirectEnv, operation: string, goodsId: string) {
  return directRead(env, operation, (credentials) =>
    geekRequest(credentials, 'temu', true, { goodsId, regionId: '211' }),
  )
}

export async function testGeekbiSlot(env: DirectEnv, slot: number) {
  const selected = await geekCredential(env, slot)
  if (!selected) throw new PublicError('GEEKBI_UNCONFIGURED', '请先配置该组凭据。', 409)
  const operation = ['temu-sites', slot, selected.revision, geekDay()].join('/')
  const result = await directRead(
    env,
    operation,
    (creds) => geekRequest(creds, 'temu', 'sites', {}),
    selected,
  )
  const rows = verifiedSites(result.body)
  if (!rows) throw new PublicError('GEEKBI_SITES', '站点响应未包含预期的美国站信息。', 502)
  if ((await geekCredential(env, slot))?.revision !== selected.revision)
    throw new PublicError('CONFLICT', '测试期间已更换凭据，请重新测试。', 409)
  return { slot, rows, points: 0, testedAt: result.fetchedAt }
}
