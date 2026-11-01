import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import type { WorkbenchRpc } from '../../api/src'

const client: RouterClient<WorkbenchRpc> = createORPCClient(
  new RPCLink({ url: window.location.origin + '/api/rpc' }),
)
export function loadSession() {
  return client.session()
}

export function isSignedOut(error: unknown) {
  return error instanceof ORPCError && error.status === 401
}

export function returnPath(value: string | null) {
  if (
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    !URL.canParse(value, window.location.origin)
  )
    return '/'
  const url = new URL(value, window.location.origin)
  if (
    url.origin !== window.location.origin ||
    (url.pathname !== '/' &&
      !/^\/(?:products\/[^/]+|home|performance|potential|research|candidates|daily|tasks|settings)\/?$/.test(
        url.pathname,
      ))
  )
    return '/'
  return url.pathname + url.search + url.hash
}

export function loginPath(expired = false) {
  const { pathname, search, hash } = window.location
  const next = returnPath(pathname + search + hash)
  const params = new URLSearchParams()
  if (next !== '/') params.set('next', next)
  if (expired) params.set('expired', '1')
  return '/login' + (params.size ? '?' + params : '')
}
