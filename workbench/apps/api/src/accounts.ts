import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { positions } from '../../../packages/contracts/accounts'
import { PublicError } from '../../../packages/contracts/errors'
import { authenticate } from './access'
import {
  type AccountRow,
  accountFields,
  newCredentials,
  publicAccount,
  signIn,
  signOut,
} from './account-session'
import type { AppEnv } from './bindings'

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,39}$/)
const password = z.string().min(12).max(128)
const role = z.enum(['viewer', 'operator', 'admin'])
const credentials = z.strictObject({ username, password })
const loginInput = z.strictObject({ username, password: z.string().min(1).max(128) })
const position = z.enum(positions).nullable().optional()
const newAccount = credentials.extend({ password: z.string().min(8).max(128), role: role.default('viewer'), position })
const editAccount = z
  .strictObject({
    role: role.optional(),
    position,
    active: z.boolean().optional(),
    password: password.optional(),
  })
  .refine((v) => Object.keys(v).length > 0)
const invalid = () =>
  new PublicError(
    'INVALID_INPUT',
    '请检查输入。用户名需为 3–40 个字母、数字、点、下划线或短横线，且以字母或数字开头；成员初始密码需为 8–128 个字符，管理员首次设置或重置密码需为 12–128 个字符。',
    400,
  )
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw invalid()
  return result.data
}

export function guardWrite(request: Request, form = false) {
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if (
    ((form || origin !== null) && origin !== new URL(request.url).origin) ||
    site === 'cross-site' ||
    site === 'same-site'
  ) {
    throw new PublicError('FORBIDDEN', '请从工作台发起操作。', 403)
  }
  const mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (mime !== (form ? 'application/x-www-form-urlencoded' : 'application/json'))
    throw new PublicError('INVALID_INPUT', form ? '请使用开户表单。' : '请发送 JSON 数据。', 415)
}

async function insertAccount(c: Context<AppEnv>, data: z.infer<typeof newAccount>, first: boolean) {
  if (first && data.role !== 'admin') throw new PublicError('FIRST_ADMIN', '请先建立管理员账号。', 409)
  if (first) parse(password, data.password)
  const { salt, hash } = await newCredentials(data.password)
  const allowed = first
    ? 'NOT EXISTS(SELECT 1 FROM accounts)'
    : "EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin')"
  const row = await c.env.DB.prepare(`INSERT INTO accounts(id,username,role,position,salt,password_hash)
    SELECT ?,?,?,?,?,? WHERE ${allowed} ON CONFLICT(username) DO NOTHING RETURNING ${accountFields}`)
    .bind(
      crypto.randomUUID(),
      data.username,
      data.role,
      data.position ?? null,
      salt,
      hash,
      ...(first ? [] : [c.var.actor.id]),
    )
    .first<AccountRow>()
  if (!row)
    throw new PublicError(
      'CONFLICT',
      first ? '首个管理员已建立，请登录工作台。' : '该用户名已被使用，或当前账号权限已变更。',
      409,
    )
  return publicAccount(row)
}

const setupForm = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>建立首个管理员 · 选品工作台</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#182825;background:#f6f8f7;margin:0}main{box-sizing:border-box;max-width:30rem;margin:8vh auto;padding:2rem;background:white}h1{font-size:1.5rem}label,input{display:block}input{box-sizing:border-box;width:100%;padding:.6rem;margin:.25rem 0 1rem;font:inherit}button{border:0;border-radius:.3rem;padding:.6rem 1rem;background:#195f48;color:white;font:inherit}</style>
<main><h1>建立首个管理员</h1><p>创建后，请用这个账号登录工作台并为团队成员开户。</p>
<form method="post" action="/api/auth/setup"><label for="username">用户名</label>
<input id="username" name="username" type="text" required minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,39}" autocapitalize="none" autocomplete="username" title="3–40 个字母、数字、点、下划线或短横线，以字母或数字开头">
<label for="password">密码（12–128 个字符）</label><input id="password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password">
<button type="submit">建立管理员账号</button></form></main></html>`

export const publicAuth = new Hono<AppEnv>()
publicAuth.use('/auth/setup', async (c, next) => {
  const owner = await authenticate(c.req.raw, c.env)
  if (owner.role !== 'admin') throw new PublicError('FORBIDDEN', '仅工作台所有者可建立首个管理员。', 403)
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
  c.header('Referrer-Policy', 'same-origin')
  await next()
})
publicAuth.get('/auth/setup', async (c) => {
  if (await c.env.DB.prepare('SELECT id FROM accounts LIMIT 1').first()) return c.redirect('/login', 303)
  return c.html(setupForm)
})
publicAuth.post('/auth/setup', async (c) => {
  guardWrite(c.req.raw, true)
  const data = parse(credentials, Object.fromEntries(new URLSearchParams(await c.req.text())))
  await insertAccount(c, { ...data, role: 'admin' }, true)
  return c.redirect('/login', 303)
})
publicAuth.post('/auth/login', async (c) => {
  guardWrite(c.req.raw)
  const parsed = loginInput.safeParse(await c.req.json())
  if (!parsed.success) throw new PublicError('INVALID_INPUT', '请输入有效的用户名和密码。', 400)
  return c.json(await signIn(c, parsed.data.username, parsed.data.password))
})

export const accountRoutes = new Hono<AppEnv>()
accountRoutes.get('/auth/me', (c) => c.json(c.var.actor))
accountRoutes.post('/auth/logout', async (c) => {
  await signOut(c)
  return c.json({ ok: true })
})
accountRoutes.get('/accounts', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT ' + accountFields + ' FROM accounts ORDER BY username',
  ).all<AccountRow>()
  return c.json({ items: rows.results.map(publicAccount) })
})
accountRoutes.post('/accounts', async (c) =>
  c.json(await insertAccount(c, parse(newAccount, await c.req.json()), c.var.actor.local), 201),
)
accountRoutes.patch('/accounts/:id', async (c) => {
  const { role, position, active, password } = parse(editAccount, await c.req.json())
  const replacement = password === undefined ? null : await newCredentials(password)
  const id = c.req.param('id')
  // Keep the role/activation predicate in the UPDATE so simultaneous demotions cannot remove the last admin.
  const row =
    await c.env.DB.prepare(`UPDATE accounts SET role=coalesce(?1,role),active=coalesce(?2,active),
    salt=coalesce(?3,salt),password_hash=coalesce(?4,password_hash),
    position=CASE WHEN ?7=1 THEN ?8 ELSE position END,
    auth_version=auth_version+CASE WHEN ?4 IS NOT NULL OR (?2 IS NOT NULL AND active<>?2) THEN 1 ELSE 0 END
    WHERE id=?5 AND EXISTS (SELECT 1 FROM accounts WHERE id=?6 AND active=1 AND role='admin')
    AND (role<>'admin' OR active=0 OR (coalesce(?1,role)='admin' AND coalesce(?2,active)=1)
      OR EXISTS(SELECT 1 FROM accounts WHERE id<>?5 AND role='admin' AND active=1))
    RETURNING ${accountFields}`)
      .bind(
        role ?? null,
        active === undefined ? null : Number(active),
        replacement?.salt ?? null,
        replacement?.hash ?? null,
        id,
        c.var.actor.id,
        Number(position !== undefined),
        position ?? null,
      )
      .first<AccountRow>()
  if (!row) {
    if (!(await c.env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(id).first()))
      throw new PublicError('NOT_FOUND', '找不到该账号。', 404)
    throw new PublicError('CONFLICT', '需要保留至少一名启用的管理员，请确认当前账号仍有管理权限。', 409)
  }
  return c.json(publicAccount(row))
})
