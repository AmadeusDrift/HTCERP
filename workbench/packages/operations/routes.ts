import { Hono } from 'hono'
import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { backfillAmazon } from './backfill-amazon'
import { memberDiagnostic, memberStepResult } from '../contracts/presentation'
import { createJob, jobAction, jobView, listJobs } from './jobs'
import {
  createSchema,
  currentStrategy,
  getRun,
  models,
  now,
  type OpsBindings,
  parse,
  settingsSchema,
  sourceConfigured,
  usage,
} from './model'
import { potentialProducts } from './potential'
import { researchQueue } from './queue'

type Actor = { id: string; email: string; local: boolean; role: 'admin' | 'operator' | 'viewer' }
type OpsEnv = { Bindings: OpsBindings; Variables: { actor: Actor } }
export const operationsRoutes = new Hono<OpsEnv>()
operationsRoutes.get('/potential', async (c) => {
  const q = parse(z.object({
    category: z.string().max(1000).optional(),
    grade: z.enum(['priority','watch','hold','unknown','undated']).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }), c.req.query())
  return c.json(await potentialProducts(c.env.DB, now(), q.page, q.pageSize, q.grade, q.category))
})
operationsRoutes.get('/strategy', async (c) => {
  const { geekbi, openrouter } = await sourceConfigured(c.env)
  return c.json({
    ...(await currentStrategy(c.env.DB)),
    usage: await usage(c.env.DB),
    capabilities: { discovery: geekbi, research: openrouter },
    ...(c.var.actor.role === 'admin'
      ? { connections: { productData: geekbi, openrouter, geekbi }, verification: 'unverified', models }
      : {}),
  })
})
operationsRoutes.post('/strategy', async (c) => {
  const actor = c.get('actor')
  if (actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可修改策略与预算', 403)
  const body = parse(
    z.object({ baseVersion: z.number().int().positive(), settings: settingsSchema }).strict(),
    await c.req.json(),
  )
  const result =
    await c.env.DB.prepare(`INSERT INTO strategy_versions(version,settings_json,actor,created_at)
    SELECT ?,?,?,? WHERE ?=(SELECT MAX(version) FROM strategy_versions)
    AND (EXISTS(SELECT 1 FROM accounts WHERE id=? AND role='admin' AND active=1)
      OR (?=1 AND NOT EXISTS(SELECT 1 FROM accounts)))`)
      .bind(
        body.baseVersion + 1,
        JSON.stringify(body.settings),
        actor.email,
        now(),
        body.baseVersion,
        actor.id,
        Number(actor.local),
      )
      .run()
  if (!result.meta.changes) throw new PublicError('CONFLICT', '策略已有更新，请刷新后重新编辑', 409)
  return c.json({ version: body.baseVersion + 1, settings: body.settings })
})
operationsRoutes.get('/jobs', async (c) => {
  const q = parse(
    z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
      kind: z.enum(['', 'research', 'discovery']).default(''),
      status: z
        .enum([
          '',
          'queued',
          'running',
          'pausing',
          'paused',
          'cancelling',
          'cancelled',
          'partial',
          'succeeded',
          'failed',
        ])
        .default(''),
    }),
    c.req.query(),
  )
  return c.json(await listJobs(c.env.DB, q.kind, q.status, q.page, q.pageSize))
})
operationsRoutes.get('/jobs/:id', async (c) => {
  const job = await jobView(c.env.DB, c.req.param('id'))
  return c.json({
    ...job,
    steps: job.steps.map(({ evidenceRef, ...step }) => ({
      ...step,
      title: memberDiagnostic(step.title),
      summary: memberDiagnostic(step.summary),
      result: memberStepResult(step.result, c.var.actor.role === 'admin'),
    })),
  })
})
operationsRoutes.get('/jobs/:id/queue', async (c) => {
  const id = c.req.param('id')
  await getRun(c.env.DB, id)
  const q = parse(
    z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }),
    c.req.query(),
  )
  const page = await researchQueue(c.env.DB, id, q.page, q.pageSize)
  return c.json({ ...page, items: page.items.map(({ evidenceRef, ...row }) => row) })
})
operationsRoutes.post('/jobs', async (c) => {
  const actor = c.get('actor')
  if (actor.role === 'viewer') throw new PublicError('FORBIDDEN', '只读角色不能创建任务', 403)
  return c.json(await createJob(c.env, parse(createSchema, await c.req.json()), actor.email), 201)
})
operationsRoutes.post('/jobs/:id/amazon-compare', async (c) => {
  if (c.var.actor.role === 'viewer') throw new PublicError('FORBIDDEN', '只读角色不能补查 Amazon。', 403)
  return c.json(await backfillAmazon(c.env, c.req.param('id')))
})
operationsRoutes.post('/jobs/:id/:action', async (c) => {
  if (c.get('actor').role === 'viewer') throw new PublicError('FORBIDDEN', '只读角色不能操作任务', 403)
  return c.json(
    await jobAction(c.env, c.req.param('id'), c.req.param('action'), c.var.actor.role === 'admin'),
  )
})
