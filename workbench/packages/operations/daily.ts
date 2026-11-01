import { Hono } from 'hono'
import { z } from 'zod'
import { memberDiagnostic } from '../contracts/presentation'
import { businessClock, parse, selectionPromptVersion } from './model'

const filters = z.object({
  date: z.iso.date().default(() => businessClock().slice(0, 10)),
  view: z.enum(['all', 'recommended']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
type Outcome = 'recommend' | 'pass' | 'insufficient' | 'unrated' | 'triage' | 'pending' | 'unlinked'
interface Item {
  productId: string
  title: string | null
  tier: number
  totalSold: number | null
  occurrences: number
  independentRecommendations: number
  discoveryId: string
  researchId: string | null
  researchDiscoveryId: string | null
  reused: number
  researchStatus: string | null
  outcome: Outcome
  reason: string | null
}
interface Summary {
  liveRuns: number
  searchedRuns: number
  latestRun: string | null
  selected: number
  linked: number
  reports: number
  recommended: number
}
export interface DailyReport {
  date: string
  summary: Summary
  items: Item[]
  total: number
  page: number
  pageSize: number
}

// Keep the latest qualifying snapshot, but credit distinct verified reports across all
// qualifying discoveries that day. A reused research job carries one recommendation.
const reportRows = `WITH runs AS (
  SELECT id,created_at FROM job_runs
  WHERE kind='discovery' AND created_at>=? AND created_at<? AND json_extract(inputs_json,'$.mode')='live'
), hits AS (
  SELECT q.run_id,q.product_id,q.tier,q.total_sold,q.evidence_ref,q.child_id,
    row_number() OVER product_runs AS rank
  FROM runs r JOIN job_seen q ON q.run_id=r.id WHERE q.tier IS NOT NULL
  WINDOW product_runs AS (PARTITION BY product_id ORDER BY r.created_at DESC,r.id DESC)
), linked AS (
  SELECT h.*,j.id AS researchId,j.status AS researchStatus,
    CASE WHEN j.parent_id<>h.run_id THEN 1 ELSE 0 END AS reused
  FROM hits h LEFT JOIN job_runs j ON j.id=COALESCE(h.child_id,(
    SELECT child.id FROM job_runs child INDEXED BY job_children
    WHERE child.parent_id=h.run_id AND child.kind='research'
      AND json_extract(child.inputs_json,'$.productId')=h.product_id
    ORDER BY child.created_at DESC,child.id DESC LIMIT 1
  )) AND j.kind='research' AND json_extract(j.inputs_json,'$.productId')=h.product_id
), evidence AS (
  SELECT l.*,t.run_id AS reportId,d.run_id AS decisionId,
    CASE WHEN json_extract(t.result_json,'$.promptVersion')=?
      AND json_type(t.result_json,'$.selection.reason')='text'
      AND length(trim(json_extract(t.result_json,'$.selection.reason'))) BETWEEN 1 AND 500
      THEN json_extract(t.result_json,'$.selection.verdict') END AS verdict,
    json_extract(t.result_json,'$.selection.reason') AS reasonText
  FROM linked l
  LEFT JOIN job_steps t ON t.run_id=l.researchId AND t.step_key='terra' AND t.status='succeeded'
    AND json_array_length(t.result_json,'$.products')=1
    AND json_extract(t.result_json,'$.products[0]')=l.product_id
  LEFT JOIN job_steps d ON d.run_id=l.researchId AND d.step_key='decision' AND d.status='succeeded'
), outcomes AS (
  SELECT *, CASE WHEN verdict IN ('recommend','pass','insufficient') THEN verdict
    WHEN reportId IS NOT NULL THEN 'unrated' WHEN decisionId IS NOT NULL THEN 'triage'
    WHEN researchId IS NOT NULL THEN 'pending' ELSE 'unlinked' END AS outcome
  FROM evidence
), totals AS (
  SELECT product_id,COUNT(*) AS occurrences,
    COUNT(DISTINCT CASE WHEN outcome='recommend' THEN researchId END) AS independentRecommendations,
    COUNT(DISTINCT reportId) AS reports,MAX(researchId IS NOT NULL) AS hasResearch
  FROM outcomes GROUP BY product_id
), preferred AS (
  SELECT o.*,ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY
    (outcome='recommend') DESC,(reportId IS NOT NULL) DESC,(researchId IS NOT NULL) DESC,rank) AS evidenceRank
  FROM outcomes o
), results AS (
  SELECT h.product_id,h.run_id,h.tier,h.total_sold,h.evidence_ref,
    t.occurrences,t.independentRecommendations,t.reports,t.hasResearch,
    p.researchId,CASE WHEN p.researchId IS NOT NULL THEN p.run_id END AS researchDiscoveryId,
    p.researchStatus,p.reused,p.outcome,p.reasonText
  FROM hits h JOIN totals t USING(product_id)
  JOIN preferred p ON p.product_id=h.product_id AND p.evidenceRank=1
  WHERE h.rank=1
)`

export const dailyRoutes = new Hono<{ Bindings: { DB: D1Database } }>()
dailyRoutes.get('/daily', async (c) => {
  const { date, view, page, pageSize } = parse(filters, c.req.query())
  const start = new Date(date + 'T00:00:00+08:00')
  const args = [
    start.toISOString(),
    new Date(start.getTime() + 86400000).toISOString(),
    selectionPromptVersion,
  ]
  const scope = view === 'recommended' ? "WHERE outcome='recommend'" : ''
  const { DB } = c.env
  const [counts, rows] = await DB.batch([
    DB.prepare(
      reportRows +
        ` SELECT (SELECT COUNT(*) FROM runs) AS liveRuns,
      (SELECT COUNT(*) FROM runs r WHERE EXISTS(SELECT 1 FROM job_seen s WHERE s.run_id=r.id)
        OR EXISTS(SELECT 1 FROM job_steps p WHERE p.run_id=r.id AND p.step_key GLOB 'search-[0-9]*'
          AND p.status='succeeded')) AS searchedRuns,
      (SELECT id FROM runs ORDER BY created_at DESC,id DESC LIMIT 1) AS latestRun,
      COUNT(*) AS selected,COALESCE(SUM(hasResearch),0) AS linked,COALESCE(SUM(reports),0) AS reports,
      COUNT(CASE WHEN outcome='recommend' THEN 1 END) AS recommended FROM results`,
    ).bind(...args),
    DB.prepare(
      reportRows +
        `, filtered AS MATERIALIZED (SELECT * FROM results ${scope}),
      page_rows AS (SELECT * FROM filtered ORDER BY independentRecommendations DESC,total_sold DESC,product_id
        LIMIT ? OFFSET MAX(0,MIN(?,(SELECT CAST((COUNT(*)-1)/? AS INTEGER) FROM filtered)))*?)
      SELECT p.product_id AS productId,
        COALESCE(NULLIF(json_extract(s.snapshot_json,'$.title_cn'),''),json_extract(s.snapshot_json,'$.title')) AS title,
        p.tier,p.total_sold AS totalSold,p.occurrences,p.independentRecommendations,
        p.run_id AS discoveryId,p.researchId,p.researchDiscoveryId,p.reused,
        p.researchStatus,p.outcome,CASE WHEN p.outcome IN ('recommend','pass','insufficient')
          THEN p.reasonText END AS reason
      FROM page_rows p LEFT JOIN product_snapshots s ON s.product_id=p.product_id AND s.evidence_ref=p.evidence_ref
      ORDER BY p.independentRecommendations DESC,p.total_sold DESC,p.product_id`,
    ).bind(...args, pageSize, page - 1, pageSize, pageSize),
  ])
  const summary = counts.results[0] as unknown as Summary
  const total = view === 'recommended' ? summary.recommended : summary.selected
  return c.json({
    date,
    summary,
    total,
    pageSize,
    page: Math.min(page, Math.max(1, Math.ceil(total / pageSize))),
    items: (rows.results as unknown as Item[]).map((row) => ({
      ...row,
      reason: row.reason && memberDiagnostic(row.reason),
    })),
  } satisfies DailyReport)
})
