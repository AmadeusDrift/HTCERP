import type { ConnectionBindings } from '../connections/credentials'
export interface ReadToolBindings extends ConnectionBindings {
  LOCAL_DEVELOPMENT?: string
}

import { PublicError } from '../contracts/errors'
import { memberDiagnostic, memberStepResult } from '../contracts/presentation'

export interface AssistantActor {
  id?: string
  email: string
  role: string
  local?: boolean
}
export async function currentActor(env: ReadToolBindings, actor: AssistantActor) {
  if (!actor || typeof actor.email !== 'string' || !actor.email) return null
  const row = await env.DB.prepare(
    'SELECT id,username,role,active FROM accounts WHERE ' +
      (actor.id ? 'id=?' : 'username=? COLLATE NOCASE'),
  )
    .bind(actor.id ?? actor.email)
    .first<{ id: string; username: string; role: string; active: number }>()
  if (row?.active && row.username.toLowerCase() === actor.email.toLowerCase())
    return { ...actor, id: row.id, email: row.username, role: row.role }
  if (
    actor.local &&
    env.LOCAL_DEVELOPMENT === '1' &&
    !(await env.DB.prepare('SELECT id FROM accounts LIMIT 1').first())
  )
    return { ...actor, role: 'admin' }
  return null
}
export function requireWritable(actor: AssistantActor | null) {
  if (!actor || actor.role === 'viewer')
    throw new PublicError('FORBIDDEN', '当前账号仅可查询，不能创建选品任务。', 403)
}
export async function ownsJob(db: D1Database, actor: AssistantActor, id: string) {
  const row = await db
    .prepare('SELECT actor FROM job_runs WHERE id=?')
    .bind(id)
    .first<{ actor: string }>()
  return Boolean(row && (row.actor === actor.email || actor.role === 'admin'))
}
export function sanitizeToolData(
  env: ReadToolBindings,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = Object.entries(env)
    .filter(([k, v]) => /KEY|SECRET|TOKEN|PASSWORD/.test(k) && typeof v === 'string' && v.length > 3)
    .map(([, v]) => String(v))
  function clean(item: unknown): unknown {
    if (typeof item === 'string') {
      let text = memberDiagnostic(item).replace(
        /(?:r2:\/\/|\br2\/|\bprobe-output\/)[^\s"，。]+/g,
        '[redacted]',
      )
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
      return text
    }
    if (Array.isArray(item)) return item.map(clean)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([k]) =>
              !/credential|password|secret|token|apikey|r2|archivepath|storagepath/i.test(
                k.replace(/[_-]/g, ''),
              ),
          )
          .map(([k, v]) => [k, clean(v)]),
      )
    return item
  }
  return clean(memberStepResult(value)) as Record<string, unknown>
}
export const privateEvidenceLostSql = (
  runExpression: string,
) => `EXISTS(SELECT 1 FROM assistant_steps ps JOIN assistant_runs pr ON pr.id=ps.run_id
 WHERE ps.run_id=${runExpression} AND ps.kind='tool' AND ps.name='read_job' AND ps.status='completed' AND json_extract(ps.result_json,'$.status') IN ('ok','partial','empty')
 AND NOT EXISTS(SELECT 1 FROM job_runs pj JOIN accounts pa ON pa.id=pr.account_id WHERE pj.id=json_extract(ps.input_json,'$.jobId') AND pj.actor=pa.username AND pa.active=1))`
