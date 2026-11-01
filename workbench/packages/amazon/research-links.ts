import type { AmazonComparison } from './auto-compare'

// Only products actually presented to a successful Decisions call qualify for automatic lookup.
// Older single-product plans may carry the product ID only on the task itself.
const research = `FROM job_runs j JOIN job_steps d ON d.run_id=j.id AND d.step_key='decision' AND d.status='succeeded'
  LEFT JOIN amazon_auto_comparisons a ON a.run_id=j.id
  WHERE j.kind='research' AND json_extract(j.inputs_json,'$.mode')='live'`

export async function productAutomation(db: D1Database, productId: string) {
  const row = await db
    .prepare(`SELECT j.id,j.status,
      (SELECT result_json FROM amazon_auto_comparisons WHERE run_id=j.id AND product_id=?) AS result
    FROM job_runs j JOIN job_steps d ON d.run_id=j.id AND d.step_key='decision' AND d.status='succeeded'
    WHERE j.kind='research' AND json_extract(j.inputs_json,'$.mode')='live'
    AND (json_extract(j.inputs_json,'$.productId')=?
      OR EXISTS(SELECT 1 FROM json_each(d.result_json,'$.products') WHERE value=?))
    ORDER BY d.updated_at DESC,j.id DESC LIMIT 1`)
    .bind(productId, productId, productId)
    .first<{ id: string; status: string; result: string | null }>()
  return row
    ? {
        runId: row.id,
        canBackfill: ['succeeded', 'partial'].includes(row.status),
        comparison: row.result ? (JSON.parse(row.result) as AmazonComparison) : null,
      }
    : null
}

export async function reportComparisons(db: D1Database, runIds: string[]) {
  if (!runIds.length) return []
  const rows = await db
    .prepare(`SELECT j.id,j.status,a.product_id,a.result_json,
      json_extract(d.result_json,'$.choice') AS choice,
      (SELECT result_json FROM job_steps t WHERE t.run_id=j.id AND t.step_key='terra' AND t.status='succeeded') AS terra,
      json_extract(j.inputs_json,'$.productId') AS target,
      json_extract(d.result_json,'$.products') AS decisionProducts
    ${research} AND j.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(runIds))
    .all<{
      id: string
      choice: string | null
      terra: string | null
      status: string
      target: string | null
      decisionProducts: string | null
      product_id: string | null
      result_json: string | null
    }>()
  return rows.results
}
