import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Position } from '../../../packages/contracts/accounts'
import { PublicError } from '../../../packages/contracts/errors'

export type Role = 'viewer' | 'operator' | 'admin'
interface AccessIdentity {
  email: string
  role: Role
  local: boolean
}
export interface Actor extends AccessIdentity {
  id: string
  username: string
  position: Position | null
}
export interface AccessBindings {
  LOCAL_DEVELOPMENT?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  APP_ROLES?: string
}
const ranks = { viewer: 0, operator: 1, admin: 2 }
export const accessRole = (role: Role, needed: Role) => ranks[role] >= ranks[needed]
export function requiredRole(method: string, path: string): Role {
  if (method === 'POST' && /^\/api\/order-sorting\/runs\/[a-f\d-]{36}\/(?:files|group-picking|group-labels)\/[^/]+$/i.test(path))
    return 'operator'
  if (method === 'POST' && /^\/api\/order-sorting\/pack\/[a-f\d-]{36}\/factory-package$/i.test(path)) return 'operator'
  if(method==='POST'&&/^\/api\/order-sorting\/(preview|picking-preview|run)$/.test(path))return 'operator'
  if(path==='/api/order-sorting/config')return 'admin'
  if (method === 'POST' && /^\/api\/weekly-feedback\/(?:run|action)$/.test(path)) return 'operator'
  if(method === 'POST' && path === '/api/title-audit/preview') return 'viewer'
  if(method === 'POST' && ['/api/title-audit/run','/api/title-audit/terms'].includes(path)) return 'operator'
  if (/^\/api\/(?:accounts|connections|group-notifications|inventory-sync|partner-admin)(?:\/|$)/.test(path)) return 'admin'
  if (
    method === 'POST' &&
    /^\/api\/assistant\/(?:conversations\/[\da-f-]{36}\/investigations|investigations\/[\da-f-]{36}\/(?:pause|resume|cancel|messages)|investigations\/[\da-f-]{36}\/proposals\/[\da-f-]{36}\/reject)$/i.test(
      path,
    )
  )
    return 'viewer'
  if (
    method === 'POST' &&
    /^\/api\/assistant\/investigations\/[\da-f-]{36}\/proposals(?:\/[\da-f-]{36}\/confirm)?$/i.test(path)
  )
    return 'operator'
  if (method === 'GET' || method === 'HEAD') return 'viewer'
  if (method === 'POST' && /^\/api\/assistant\/conversations\/[\da-f-]{36}\/turns$/i.test(path))
    return 'viewer'
  if (
    method === 'POST' &&
    /^\/api\/assistant\/conversations\/[\da-f-]{36}\/turns\/[\da-f-]{36}\/run$/i.test(path)
  )
    return 'operator'
  if (
    method === 'POST' &&
    /^\/api\/me\/(?:preferences|presets(?:\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/(?:rename|delete))?)$/i.test(
      path,
    )
  )
    return 'viewer'
  if (
    path === '/api/research-images' ||
    path === '/api/jobs' ||
    /^\/api\/jobs\/[^/]+\/(pause|resume|retry|cancel|amazon-compare)$/.test(path)
  )
    return 'operator'
  if (/^\/api\/products\/[^/]+\/(candidate|amazon\/(search|matches\/[A-Z0-9]{10}))$/.test(path))
    return 'operator'
  return 'admin'
}
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export const unauthorized = () => new PublicError('UNAUTHORIZED', '请登录工作台。', 401)

export function isLocalDevelopment(url: URL, env: AccessBindings) {
  return (
    env.LOCAL_DEVELOPMENT === '1' &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
}

export async function authenticate(
  request: Request,
  env: AccessBindings,
  verificationKey?: CryptoKey,
): Promise<AccessIdentity> {
  const url = new URL(request.url)
  if (isLocalDevelopment(url, env)) {
    return { email: 'local@workbench', role: 'admin', local: true }
  }
  if (url.protocol !== 'https:') throw unauthorized()
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  const team = env.ACCESS_TEAM_DOMAIN
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !env.ACCESS_AUD || !token)
    throw unauthorized()
  const issuer = 'https://' + team
  const keys = keysets.get(issuer) ?? createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'))
  keysets.set(issuer, keys)
  const options = {
    issuer,
    audience: env.ACCESS_AUD,
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'email'],
  }
  const verified = await (verificationKey
    ? jwtVerify(token, verificationKey, options)
    : jwtVerify(token, keys, options)
  ).catch(() => {
    throw unauthorized()
  })
  const email = String(verified.payload.email).toLowerCase()
  let role: unknown
  try {
    role = JSON.parse(env.APP_ROLES ?? '{}')[email]
  } catch {
    /* fail closed */
  }
  if (role !== 'admin' && role !== 'operator' && role !== 'viewer') {
    throw new PublicError('FORBIDDEN', '请联系管理员分配工作台角色。', 403)
  }
  return { email, role, local: false }
}
