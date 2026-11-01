import { potentialScope } from './potential-scope'
import { z } from 'zod'
import { type ConnectionBindings, connectionStatus } from '../connections/credentials'
import { PublicError } from '../contracts/errors'

export interface OpsBindings extends ConnectionBindings {
  ARCHIVE: R2Bucket
  RUNNER: Workflow<{ runId: string }>
}
export const models = { research: 'openai/gpt-6.1-terra', decision: 'openai/gpt-6-luna-decisions' }
export const promptVersion = 'opportunity-review-v1'
export const selectionPromptVersion = 'opportunity-review-v2'
const platform = z.enum(['temu', 'amazon', 'shein', 'tiktok', 'aliexpress'])
const bounded = (max: number) => z.number().int().min(0).max(max)
const scope = {
  platform,
  categoryId: z.string().regex(/^(?:home|\d{1,20})?$/),
  keyword: z.string().trim().max(150),
  maxPrice: z.number().nonnegative().max(1_000_000).nullable(),
  tiers: z
    .array(bounded(1_000_000_000))
    .min(1)
    .max(6)
    .refine((xs) => xs.every((n, i) => i === 0 || n < xs[i - 1]), '销量分层须严格降序'),
  pageLimit: bounded(20).min(1),
}
export const settingsSchema = z
  .object({
    ...scope,
    market: z.literal('US'),
    focusLimit: bounded(10),
    researchLimit: bounded(3).default(0),
    dataDailyPoints: bounded(100_000),
    aiDailyMicros: bounded(100_000_000),
    schedulePreset: z.enum(['potential','custom']).optional(),
    scheduleEnabled: z.boolean(),
    scheduleTime: z.string().regex(/^(?:([01]\d|2[0-3]):[0-5]\d)?$/),
  })
  .strict()
  .refine(
    (s) =>
      !s.scheduleEnabled ||
      (s.scheduleTime !== '' && s.dataDailyPoints >= 10 && (s.platform === 'amazon' || s.schedulePreset === 'potential' || !!(s.categoryId || s.keyword))),
    '开启自动调度需要北京时间、类目或关键词和至少 10 积分的日预算',
  )
export type Settings = z.infer<typeof settingsSchema>
export const inputsSchema = z
  .object(scope)
  .partial()
  .extend({
    preset: z.literal('potential').optional(),
    goal: z.string().trim().max(1500).optional(),
    productId: z
      .string()
      .regex(/^(?:amazon:US:[A-Z0-9]{10}|(?:temu|shein|tiktok|aliexpress):US:\d{1,32})$/)
      .optional(),
    mode: z.enum(['cache', 'live']).default('cache'),
    maxDataPoints: bounded(100_000).optional(),
    maxAiMicros: bounded(100_000_000).optional(),
    imageId: z.uuid().optional(),
  })
  .strict()
  .refine((i) => !i.imageId || !!i.productId, '参考图需要关联已选商品')
export const createSchema = z
  .object({
    kind: z.enum(['discovery', 'research']),
    inputs: inputsSchema,
    requestId: z
      .string()
      .regex(/^[\w.-]{1,100}$/)
      .optional(),
  })
  .strict()
  .refine(j => !j.inputs.preset || j.kind === 'discovery', '潜力新品预设仅适用于发现任务')
  .refine(
    (j) => j.kind === 'discovery' || !!(j.inputs.goal || j.inputs.productId || j.inputs.keyword),
    '请指定商品或研究目标',
  )
export type JobInput = z.infer<typeof inputsSchema>
export type NewJob = z.infer<typeof createSchema>
export type JobRow = {
  id: string
  kind: 'discovery' | 'research'
  title: string
  status: string
  summary: string
  actor: string
  request_key: string
  parent_id: string | null
  inputs_json: string
  strategy_version: number
  attempt: number
  created_at: string
  updated_at: string
}
export type StepResult = { summary: string; result: Record<string, unknown>; evidenceRef?: string }
export const now = () => new Date().toISOString()
export const businessClock = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString()
export const bad = (msg: string) => new PublicError('INVALID_INPUT', msg, 400)
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value)
  if (!checked.success) throw bad(checked.error.issues[0]?.message ?? '输入无效')
  return checked.data
}
export async function currentStrategy(db: D1Database, version?: number) {
  const row =
    version === undefined
      ? await db
          .prepare('SELECT version,settings_json FROM strategy_versions ORDER BY version DESC LIMIT 1')
          .first<{ version: number; settings_json: string }>()
      : await db
          .prepare('SELECT version,settings_json FROM strategy_versions WHERE version=?')
          .bind(version)
          .first<{ version: number; settings_json: string }>()
  if (!row) throw new Error('缺少策略版本')
  return { version: row.version, settings: parse(settingsSchema, JSON.parse(row.settings_json)) }
}
export async function getRun(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM job_runs WHERE id=?').bind(id).first<JobRow>()
  if (!row) throw new PublicError('NOT_FOUND', '任务不存在', 404)
  return row
}
export function effective(settings: Settings, input: JobInput): Settings {
  if (input.preset === 'potential') return { ...settings, ...potentialScope, tiers: [0], focusLimit: 0, researchLimit: 0 }
  // Only the discovery scope can be overridden by a manual run.
  return {
    ...settings,
    ...Object.fromEntries(
      Object.keys(scope)
        .filter((k) => Object.hasOwn(input, k))
        .map((k) => [k, input[k as keyof JobInput]]),
    ),
  }
}
export async function sourceConfigured(env: OpsBindings) {
  const { geekbi, openrouter } = await connectionStatus(env)
  return { geekbi, openrouter }
}
export async function saveStep(
  db: D1Database,
  id: string,
  key: string,
  title: string,
  status: string,
  details: StepResult,
) {
  return db
    .prepare(`INSERT INTO job_steps(run_id,step_key,title,status,summary,result_json,evidence_ref,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,step_key) DO UPDATE SET status=excluded.status,summary=excluded.summary,
    result_json=excluded.result_json,evidence_ref=excluded.evidence_ref,updated_at=excluded.updated_at`)
    .bind(
      id,
      key,
      title,
      status,
      details.summary,
      JSON.stringify(details.result),
      details.evidenceRef ?? null,
      now(),
    )
    .run()
}
export async function usage(db: D1Database, runId?: string, childrenOnly = false) {
  const where = childrenOnly
    ? 'run_id IN (SELECT id FROM job_runs WHERE parent_id=?)'
    : runId
      ? 'run_id=?'
      : 'business_date=?'
  const rows = await db
    .prepare(`SELECT unit,SUM(COALESCE(actual,reserved)) amount,
    SUM(CASE WHEN state!='confirmed' THEN reserved ELSE 0 END) pending FROM usage_reservations WHERE ${where} GROUP BY unit`)
    .bind(runId ?? businessClock().slice(0, 10))
    .all<{ unit: string; amount: number; pending: number }>()
  const points = rows.results.find((r) => r.unit === 'points'),
    ai = rows.results.find((r) => r.unit === 'micros')
  return {
    dataPoints: points?.amount ?? 0,
    aiMicros: ai?.amount ?? 0,
    unconfirmedDataPoints: points?.pending ?? 0,
    unconfirmedAiMicros: ai?.pending ?? 0,
  }
}
