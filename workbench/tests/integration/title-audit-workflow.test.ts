import { expect, it, vi } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import { investigationFixture } from './assistant-run-fixture'
import { AmazonUS } from '../../packages/amazon/adapter'
import { auditWorkflow, launchAudit } from '../../packages/title-audit/jobs'
import { titleAudit } from '../../packages/title-audit/routes'
import type { OpsBindings } from '../../packages/operations/model'
it('publishes honest split-scan coverage and recovers a short final page without duplicating SKUs', async () => {
  const { db, env } = investigationFixture()
  const day = 86400000
  const insertRun = db.prepare(
    "INSERT INTO title_audit_runs(id,seller,started,status,version) VALUES(?,'SELLERA',?,'running','test')",
  )
  db.exec("INSERT INTO title_audit_store VALUES(1,'SELLERA',1)")
  insertRun.run('r', new Date(Date.now() - 2 * day).toISOString())
  const step = {
    do: async (_key: string, ...args: unknown[]) => await (args.at(-1) as () => Promise<unknown>)(),
  } as unknown as WorkflowStep
  const us = 'ATVPDKIKX0DER'
  const api = vi.spyOn(AmazonUS.prototype, 'auditListings')
  try {
    api
      .mockResolvedValueOnce({ numberOfResults: 1001, items: [] })
      .mockResolvedValueOnce({
        numberOfResults: 2,
        pagination: { nextToken: 'next' },
        items: [
          {
            sku: 'KU',
            summaries: [
              { asin: 'B000000001', marketplaceId: us, itemName: 'Kuromi Mug', status: ['BUYABLE'] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        numberOfResults: 2,
        items: [
          {
            sku: 'SM',
            summaries: [{ marketplaceId: us, itemName: 'Spiderman Poster' }],
            issues: [
              {
                code: 'X',
                message: 'Amazon notice',
                enforcements: { actions: [{ action: 'CATALOG_ITEM_REMOVED' }] },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ numberOfResults: 0, items: [] })
    await auditWorkflow(env as unknown as OpsBindings, 'r', step)
    expect(db.prepare('select status from title_audit_runs').get()?.status).toBe('partial')
    const res = await titleAudit.request(
      '/results?' +
        new URLSearchParams({ state: '官方已限制销售', family: 'Marvel', term: 'Spider-Man', q: 'SM' }),
      {},
      env,
    )
    expect(await res.json()).toMatchObject({
      total: 1,
      rows: [{ sku: 'SM', verdict: '重点提醒', disposition: '官方已限制销售' }],
    })
    insertRun.run('r2', new Date(Date.now() - day).toISOString())
    api.mockResolvedValueOnce({numberOfResults: 2, items:[{sku:'A'}]})
       .mockResolvedValueOnce({numberOfResults: 1, items:[{sku:'A'}]})
       .mockResolvedValueOnce({numberOfResults: 1, items:[{sku:'B'}]})
    await auditWorkflow(env as unknown as OpsBindings, 'r2', step)
    const latest = await titleAudit.request('/results', {}, env)
    expect(await latest.json()).toMatchObject({
      last: { status: 'done' }, complete: { id: 'r2' }, total: 2,
    })
  } finally {
    api.mockRestore()
    db.close()
  }
})

it('audits only confirmed new US Haul listings and continues from the completed batch', async () => {
  const { db, env } = investigationFixture()
  const bindings = { ...env, RUNNER: { create: vi.fn(async () => {}) } } as unknown as OpsBindings
  const step = {
    do: async (_name: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
  } as unknown as WorkflowStep
  const marketplaceId = 'ATVPDKIKX0DER'
  const scheduled = Date.parse('2026-11-12T13:30:00Z')
  const cutoff = scheduled - 120000
  const halfHour = 1800000
  db.exec(`INSERT INTO title_audit_store VALUES(1,'SELLERA',1);
    INSERT INTO title_audit_runs(id,seller,started,status,version)
    VALUES('full','SELLERA','2026-11-12T12:00:00Z','running','test');`)
  const api = vi.spyOn(AmazonUS.prototype, 'auditListings')
    .mockResolvedValueOnce({
      numberOfResults: 5,
      pagination: { nextToken: 'next' },
      items: [
        {
          sku: 'haul-attribute',
          attributes: { is_value_stores_item: [{ marketplace_id: marketplaceId, value: true }] },
          summaries: [{ marketplaceId, itemName: 'Spiderman Poster' }],
        },
        {
          sku: 'ordinary',
          summaries: [{ marketplaceId, itemName: 'Spiderman Poster' }],
        },
        {
          sku: 'haul-descriptor',
          attributes: { is_value_stores_item: [{ marketplace_id: marketplaceId, value: true }] },
          summaries: [{ marketplaceId, itemName: 'Rock Star Crew Neck T-Shirt' }],
        },
        {
          sku: 'haul-ambiguous',
          offers: [{ marketplaceId, audience: { value: 'BZR' } }],
          summaries: [{ marketplaceId, itemName: 'Dark Knight Dog Tag Key Ring' }],
        },
      ],
    })
    .mockResolvedValueOnce({
      numberOfResults: 5,
      items: [{ sku: 'haul-offer', offers: [{ marketplaceId, audience: { value: 'BZR' } }] }],
    })
  try {
    await launchAudit(bindings, 'SELLERA', scheduled)
    const run = db.prepare("SELECT id FROM title_audit_runs WHERE scope='haul'").get()!
    await auditWorkflow(bindings, String(run.id), step)
    expect(api.mock.calls).toEqual([
      ['SELLERA', cutoff - halfHour + 1, cutoff, undefined, true],
      ['SELLERA', cutoff - halfHour + 1, cutoff, 'next', true],
    ])
    const result = await titleAudit.request('/results?scope=haul', {}, bindings)
    expect(await result.json()).toMatchObject({
      total: 4,
      complete: { id: run.id, status: 'done', window_end_ms: cutoff },
      runs: [{ id: run.id }],
      rows: [
        { sku: 'haul-ambiguous', verdict: '重点提醒' },
        { sku: 'haul-attribute', verdict: '重点提醒' },
        { sku: 'haul-descriptor', verdict: '低优先级' },
        { sku: 'haul-offer' },
      ],
    })
    const priority = await titleAudit.request('/results?scope=haul&result=' + encodeURIComponent('风险'), {}, bindings)
    expect(await priority.json()).toMatchObject({ total: 2, rows: [{ sku: 'haul-ambiguous' }, { sku: 'haul-attribute' }] })
    const full = await titleAudit.request('/results', {}, bindings)
    expect(await full.json()).toMatchObject({ last: { id: 'full', status: 'running' }, total: 0 })

    await launchAudit(bindings, 'SELLERA', scheduled + halfHour)
    expect(db.prepare("SELECT window_start_ms,window_end_ms FROM title_audit_runs WHERE scope='haul' AND status='running'").get())
      .toEqual({ window_start_ms: cutoff + 1, window_end_ms: cutoff + halfHour })
    expect(db.prepare('SELECT count(*) AS n FROM notification_deliveries').get()?.n).toBe(0)
  } finally {
    api.mockRestore()
    db.close()
  }
})
