import { businessClock } from '../operations/model'

export const assistantModelReservationMicros = 80000

// Both caps are checked by the same INSERT in the existing shared usage ledger.
export async function reserveInvestigationModel(
  db: D1Database,
  runId: string,
  key: string,
  attempt: number,
  scopeVersion?: number,
  leaseToken?: string | null,
) {
  const day = businessClock().slice(0, 10)
  return db
    .prepare(`INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id,attempt,logical_key)
 SELECT ?1,?2,'micros',?3,?4,'reserved',?5,?6,?7,?2 WHERE
 EXISTS(SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id WHERE r.id=?6 AND r.attempt=?7 AND r.status='running' AND a.active=1
 AND EXISTS(SELECT 1 FROM assistant_conversations WHERE id=r.conversation_id AND account_id=r.account_id) AND (?8 IS NULL OR r.scope_version=?8) AND (?9 IS NULL OR r.lease_token=?9) AND NOT EXISTS(SELECT 1 FROM assistant_messages WHERE run_id=r.id AND state='pending' AND intent='continue')
 AND ?4+${investigationSpentSql('micros', 'r.id')}<=json_extract(r.limits_json,'$.aiMicros'))
 AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE unit='micros' AND business_date=?3 AND actual>reserved)
 AND ?4+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='micros' AND business_date=?3)+${dailyOutstandingAllocationSql('micros', '?3')}<=(SELECT json_extract(settings_json,'$.aiDailyMicros') FROM strategy_versions ORDER BY version DESC LIMIT 1)
 ON CONFLICT DO NOTHING RETURNING rowid`)
    .bind(
      'assistant-run:' + runId,
      key,
      day,
      assistantModelReservationMicros,
      new Date().toISOString(),
      runId,
      attempt,
      scopeVersion ?? null,
      leaseToken ?? null,
    )
    .first()
}
export async function settleInvestigationModel(
  db: D1Database,
  runId: string,
  key: string,
  cost: number | null,
) {
  await db
    .prepare(
      "UPDATE usage_reservations SET actual=?,state=? WHERE assistant_run_id=? AND step_key=? AND (state='reserved' OR (state='uncertain' AND ? IS NOT NULL))",
    )
    .bind(cost, cost === null ? 'uncertain' : 'confirmed', runId, key, cost)
    .run()
}

export function outstandingAllocationSql(unit: 'points' | 'micros', runExpression: string) {
  const column = unit === 'points' ? 'allocated_points' : 'allocated_micros'
  return `(SELECT COALESCE(SUM(MAX(0,l.${column}-(SELECT COALESCE(SUM(COALESCE(u.actual,u.reserved)),0) FROM usage_reservations u WHERE u.assistant_link_id=l.id AND u.unit='${unit}'))),0) FROM assistant_job_links l WHERE l.run_id=${runExpression} AND l.state IN ('pending','submitted','uncertain'))`
}
export function dailyOutstandingAllocationSql(unit: 'points' | 'micros', dayExpression: string) {
  const column = unit === 'points' ? 'allocated_points' : 'allocated_micros'
  return `(SELECT COALESCE(SUM(MAX(0,l.${column}-(SELECT COALESCE(SUM(COALESCE(u.actual,u.reserved)),0) FROM usage_reservations u WHERE u.assistant_link_id=l.id AND u.unit='${unit}'))),0) FROM assistant_job_links l WHERE l.business_date=${dayExpression} AND l.state IN ('pending','submitted','uncertain'))`
}
export function investigationSpentSql(unit: 'points' | 'micros', runExpression: string) {
  return `((SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE assistant_run_id=${runExpression} AND unit='${unit}')+${outstandingAllocationSql(unit, runExpression)})`
}
export async function investigationUsage(db: D1Database, id: string) {
  const rows = await db
    .prepare(
      "SELECT unit,COALESCE(SUM(COALESCE(actual,reserved)),0) amount,COALESCE(SUM(CASE WHEN state!='confirmed' THEN reserved ELSE 0 END),0) uncertain FROM usage_reservations WHERE assistant_run_id=? GROUP BY unit",
    )
    .bind(id)
    .all<{ unit: string; amount: number; uncertain: number }>()
  const holds = await db
    .prepare(
      `SELECT ${outstandingAllocationSql('points', '?1')} points,${outstandingAllocationSql('micros', '?1')} micros`,
    )
    .bind(id)
    .first<{ points: number; micros: number }>()
  const p = rows.results.find((v) => v.unit === 'points'),
    a = rows.results.find((v) => v.unit === 'micros')
  return {
    dataPoints: (p?.amount ?? 0) + (holds?.points ?? 0),
    aiMicros: (a?.amount ?? 0) + (holds?.micros ?? 0),
    unconfirmedDataPoints: p?.uncertain ?? 0,
    unconfirmedAiMicros: a?.uncertain ?? 0,
    allocatedDataPoints: holds?.points ?? 0,
    allocatedAiMicros: holds?.micros ?? 0,
  }
}
// Evaluated inside every child reservation/call claim; cached browser roles never authorize a send.
export function childAuthorizationSql(jobExpression: string) {
  return `EXISTS(SELECT 1 FROM assistant_job_links l JOIN assistant_runs r ON r.id=l.run_id JOIN assistant_proposals p ON p.id=l.proposal_id JOIN accounts a ON a.id=r.account_id JOIN job_runs j ON j.id=l.job_id AND j.status='running' AND j.actor=a.username JOIN assistant_conversations c ON c.id=r.conversation_id AND c.account_id=r.account_id
 WHERE l.job_id=${jobExpression} AND l.state='submitted' AND r.scope_version=l.scope_version AND p.scope_version=l.scope_version AND p.status='confirmed' AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND a.active=1 AND a.role IN ('operator','admin') AND (l.operation!='reviews_refresh' OR a.role='admin') AND r.status IN ('queued','running','waiting_jobs')
 AND NOT EXISTS(SELECT 1 FROM assistant_messages m WHERE m.run_id=r.id AND m.state='pending' AND m.intent='continue')
 AND ${investigationSpentSql('points', 'r.id')}<=json_extract(r.limits_json,'$.dataPoints') AND ${investigationSpentSql('micros', 'r.id')}<=json_extract(r.limits_json,'$.aiMicros'))`
}
export async function assertAssistantChildActive(db: D1Database, jobId: string) {
  const linked = await db.prepare('SELECT 1 FROM assistant_job_links WHERE job_id=?').bind(jobId).first()
  if (
    linked &&
    !(await db
      .prepare(`SELECT 1 WHERE ${childAuthorizationSql('?1')}`)
      .bind(jobId)
      .first())
  )
    throw new Error('调查授权、范围、账号、调用上限或待处理补充已变化，未发送新请求。')
}
export async function claimAssistantCall(db: D1Database, jobId: string) {
  if (!(await db.prepare('SELECT 1 FROM assistant_job_links WHERE job_id=?').bind(jobId).first())) return
  const updated = await db
    .prepare(
      `UPDATE assistant_job_links SET calls_used=calls_used+1 WHERE job_id=?1 AND calls_used<calls_limit AND ${childAuthorizationSql('?1')}`,
    )
    .bind(jobId)
    .run()
  if (!updated.meta.changes) throw new Error('调查授权或调用数量已到上限，未发送新请求。')
}
