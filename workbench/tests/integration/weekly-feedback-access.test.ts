import { Hono } from 'hono'
import { expect, it } from 'vitest'
import type { Role } from '../../apps/api/src/access'
import { requiredRole } from '../../apps/api/src/access'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../../packages/contracts/errors'
import { weeklyFeedbackRoutes } from '../../packages/weekly-feedback/routes'
import { investigationFixture } from './assistant-run-fixture'

it('reserves assignment and recipient setup for administrators and rejects broadcast recipients', async () => {
  const { db, env } = investigationFixture()
  let role: Role = 'viewer'
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('actor', {
        id: 'bob',
        username: 'bob',
        email: 'bob@test',
        role,
        local: false,
        position: null,
      })
      await next()
    })
    .route('/api/weekly-feedback', weeklyFeedbackRoutes)
    .onError((error) => Response.json({}, { status: error instanceof PublicError ? error.status : 500 }))
  const post = (path: string, body: unknown) =>
    app.request('/api/weekly-feedback/' + path, { method: 'POST', body: JSON.stringify(body) }, env)
  try {
    db.exec(
      "INSERT INTO title_audit_store VALUES(1,'SELLERA',0); INSERT INTO weekly_feedback_runs(id,seller,marketplace,week,started,status) VALUES('r','SELLERA','ATVPDKIKX0DER','2026-11-02','now','done'); INSERT INTO weekly_feedback_listings(run,sku,asin,title,role) VALUES('r','S','B000000001','Mug','child')",
    )
    const assignment = { run: 'r', sku: 'S', accountId: 'bob' }
    expect((await post('assign', assignment)).status).toBe(403)
    role = 'operator'
    expect((await post('assign', assignment)).status).toBe(403)
    expect((await app.request('/api/weekly-feedback/wecom', {}, env)).status).toBe(403)
    role = 'admin'
    expect((await post('assign', { ...assignment, accountId: 'alice' })).status).toBe(400)
    expect((await post('assign', { ...assignment, sku: 'OTHER' })).status).toBe(404)
    expect((await post('assign', assignment)).status).toBe(200)
    expect((await post('wecom-member', { accountId: 'bob', userid: '@all' })).status).toBe(400)
    expect((await post('wecom-member', { accountId: 'bob', userid: 'bob|alice' })).status).toBe(400)
    expect((await post('wecom-member', { accountId: 'bob', userid: 'wecom_bob' })).status).toBe(200)
    db.exec("UPDATE title_audit_store SET seller='SELLERB'")
    expect((await post('assign', assignment)).status).toBe(404)
    expect(requiredRole('POST', '/api/weekly-feedback/run')).toBe('operator')
    expect(requiredRole('POST', '/api/weekly-feedback/assign')).toBe('admin')
    expect(requiredRole('POST', '/api/weekly-feedback/notify')).toBe('admin')
  } finally {
    db.close()
  }
})
