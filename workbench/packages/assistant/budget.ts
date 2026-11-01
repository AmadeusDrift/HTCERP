import { businessClock } from '../operations/model'
import { bounds } from '../operations/providers'

// Both caps are checked by the same INSERT in the existing shared usage ledger.
export async function reserveInvestigationModel(
  db: D1Database,
  runId: string,
  key: string,
  attempt: number,
) {
  const day = businessClock().slice(0, 10)
  return db
    .prepare(`INSERT INTO usage_reservations(direct_key,step_key,unit,business_date,reserved,state,created_at,assistant_run_id,attempt,logical_key)
 SELECT ?1,?2,'micros',?3,?4,'reserved',?5,?6,?7,?2 WHERE
 EXISTS(SELECT 1 FROM assistant_runs r JOIN accounts a ON a.id=r.account_id WHERE r.id=?6 AND r.attempt=?7 AND r.status='running' AND a.active=1
 AND ?4+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE assistant_run_id=?6 AND unit='micros')<=json_extract(r.limits_json,'$.aiMicros'))
 AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE unit='micros' AND business_date=?3 AND actual>reserved)
 AND ?4+(SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage_reservations WHERE unit='micros' AND business_date=?3)<=(SELECT json_extract(settings_json,'$.aiDailyMicros') FROM strategy_versions ORDER BY version DESC LIMIT 1)
 ON CONFLICT DO NOTHING RETURNING rowid`)
    .bind('assistant-run:' + runId, key, day, bounds.terra, new Date().toISOString(), runId, attempt)
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
