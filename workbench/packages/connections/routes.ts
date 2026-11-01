import { Hono } from 'hono'
import type { AppEnv } from '../../apps/api/src/bindings'
import { AmazonUS } from '../amazon/adapter'
import { PublicError } from '../contracts/errors'
import { testGeekbiSlot } from '../operations/execution'
import { geekbiSlotHealth, geekbiSlotUsage } from '../operations/geekbi'
import {
  connectionStatus,
  credentialEditing,
  isProvider,
  providerCredentials,
  replaceCredentials,
} from './credentials'

export const connections = new Hono<AppEnv>()
connections.get('/connections', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可查看连接配置。', 403)
  const [status, usage] = await Promise.all([connectionStatus(c.env), geekbiSlotUsage(c.env.DB)])
  const slots = await Promise.all(
    status.slots.map(async (s) => {
      const points = usage.find((row) => row.slot === s.slot)
      const base = {
        ...s,
        confirmedPoints: points?.confirmedPoints ?? 0,
        pendingPoints: points?.pendingPoints ?? 0,
      }
      const unknown = { balanceRefused: false, testStatus: null, lastTestedAt: null }
      if (!s.configured) return { ...base, ...unknown }
      try {
        return { ...base, ...(await geekbiSlotHealth(c.env, s.slot)) }
      } catch (error) {
        if (!(error instanceof PublicError) || error.code !== 'CREDENTIAL_STORE_UNAVAILABLE') throw error
        return { ...base, configured: false, binding: 'locked', ...unknown }
      }
    }),
  )
  const geekbiConfigured = slots.some((s) => s.configured)
  const last = await c.env.DB.prepare(
    "SELECT status,tested_at AS lastTestedAt FROM connection_tests WHERE service='amazon'",
  ).first<{ status: string; lastTestedAt: string }>()
  return c.json({
    credentialEditing: credentialEditing(c.env),
    productData: { configured: geekbiConfigured },
    geekbi: { configured: geekbiConfigured, slots },
    openrouter: { configured: status.openrouter },
    amazon: {
      configured: status.amazon,
      status: status.amazon ? (last?.status ?? 'untested') : 'unconfigured',
      lastTestedAt: last?.lastTestedAt ?? null,
    },
    haul: { configured: false },
  })
})
connections.post('/connections/geekbi/slots/:slot/test', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可验证密钥。', 403)
  const slot = c.req.param('slot')
  if (!/^[1-5]$/.test(slot)) throw new PublicError('INVALID_INPUT', '请选择第 1 至 5 组。', 400)
  return c.json(await testGeekbiSlot(c.env, Number(slot)))
})
connections.post('/connections/:provider/credentials', async (c) => {
  const provider = c.req.param('provider')
  if (!isProvider(provider)) throw new PublicError('NOT_FOUND', '找不到该服务。', 404)
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可更新服务凭证。', 403)
  const input: unknown = await c.req.json()
  if (
    !input ||
    typeof input !== 'object' ||
    !Object.hasOwn(input, 'credentials') ||
    Object.keys(input).some((key) => key !== 'credentials' && (provider !== 'geekbi' || key !== 'slot'))
  )
    throw new PublicError('INVALID_INPUT', '请填写该服务的凭证。', 400)
  const { credentials, slot = 1 } = input as { credentials: unknown; slot?: number }
  await replaceCredentials(c.env, provider, credentials, c.var.actor, slot)
  return c.json({ ok: true })
})
connections.post('/connections/amazon/order-fields', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可核对订单权限。', 403)
  const { credentials } = await providerCredentials(c.env, 'amazon')
  return c.json(await new AmazonUS(credentials).checkHaulOrderFields())
})
connections.post('/connections/amazon/listing-fields', async (c) => {
  if (c.var.actor.role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可核对刊登记录。', 403)
  const input = await c.req.json<{ sellerId?: unknown }>().catch(() => null)
  if (!input || typeof input.sellerId !== 'string' || Object.keys(input).length !== 1)
    throw new PublicError('INVALID_INPUT', '请填写卖家中心的 Seller ID。', 400)
  const { credentials } = await providerCredentials(c.env, 'amazon')
  return c.json(await new AmazonUS(credentials).searchListingsItems(input.sellerId.trim()))
})
connections.post('/connections/amazon/test', async (c) => {
  const { credentials, revision } = await providerCredentials(c.env, 'amazon')
  let status = 'catalog_verified'
  let failure: unknown
  try {
    await new AmazonUS(credentials, undefined, c.env.DB).test()
  } catch (e) {
    failure = e
    status = e instanceof PublicError ? e.code : 'SOURCE_UNAVAILABLE'
  }
  const saved = await c.env.DB.prepare(
    `INSERT OR REPLACE INTO connection_tests(service,status,tested_at) SELECT 'amazon',?,?
     WHERE coalesce((SELECT nonce FROM connection_credentials WHERE provider='amazon'),'')=?`,
  )
    .bind(status, new Date().toISOString(), revision)
    .run()
  if (!saved.meta.changes) throw new PublicError('CONFLICT', '测试期间已更换凭证，请重新测试。', 409)
  if (failure) throw failure
  return c.json({ status, message: '美国站目录检索已验证。确认候选 ASIN 时检查新品报价权限。' })
})
