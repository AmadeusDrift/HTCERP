import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const scope = { sellerAccountId: 'seller', marketplaceId: 'US', warehouseCode: 'A1C5' }
const session = { actor: { id: 'admin', displayName: 'Admin', role: 'admin' }, scope }
function harness(initial: any = {}) {
  let state = structuredClone(initial)
  const calls: any[] = []
  let lost = '',
    tabs = [{ id: 3, url: 'https://htcerp.app/settings?tab=inventory' }],
    current = session
  const context: any = { URL, TextEncoder, Date, Uint8Array }
  const source = new URL('erp-connection.js', directory)
  try {
    runInNewContext(readFileSync(source, 'utf8'), context)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
  }
  const api = context.SellerFlexErpConnection?.create({
    crypto: webcrypto,
    read: async () => structuredClone(state),
    save: async (v: any) => {
      state = structuredClone(v)
    },
    chrome: {
      tabs: {
        query: async () => tabs,
        sendMessage: async (id: number, message: any, options: any) => {
          calls.push({
            operation: message.operation,
            input: message.input,
            persisted: structuredClone(state),
            id,
            options,
          })
          if (message.operation === 'session') return { ok: true, value: current }
          if (lost === 'authorize') throw new Error('lost authorization reply')
          return {
            ok: true,
            value: {
              grantId: '123e4567-e89b-42d3-a456-426614174000',
              expiresAt: Date.now() + 120000,
              scope,
            },
          }
        },
      },
    },
    request: async (_state: any, path: string, body: any) => {
      calls.push({ operation: path, input: body, persisted: structuredClone(state) })
      if (lost === 'connect') throw new Error('lost connect reply')
      return {
        deviceId: 'a'.repeat(64),
        token: 'b'.repeat(64),
        scope,
        mode: 'SIMULATION',
        pollSeconds: 60,
      }
    },
  })
  return {
    api,
    calls,
    state: () => state,
    lose: (s: string) => {
      lost = s
    },
    session: (s: any) => {
      current = s
    },
    tabs: (v: any) => {
      tabs = v
    },
  }
}
it('detects without authorizing and never exposes a proof or token', async () => {
  const h = harness()
  expect(h.api).toBeDefined()
  expect(await h.api.detect()).toEqual({ status: 'ready', ...session })
  expect(h.calls.map((c) => c.operation)).toEqual(['session'])
  expect(h.state()).toEqual({})
})
it('persists proof before authorization and resumes lost responses after worker restart', async () => {
  for (const loss of ['authorize', 'connect']) {
    const h = harness()
    expect(h.api).toBeDefined()
    h.lose(loss)
    await expect(h.api.connect({ name: 'Warehouse' })).rejects.toThrow()
    const pending = h.state().pendingConnection
    expect(pending.verifier).toMatch(/^[a-f0-9]{64}$/)
    expect(h.calls.find((c) => c.operation === 'authorize').persisted.pendingConnection).toEqual(
      expect.objectContaining({ requestId: pending.requestId, verifier: pending.verifier }),
    )
    expect(JSON.stringify(h.calls.find((c) => c.operation === 'authorize').input)).not.toContain(
      pending.verifier,
    )
    const restarted = harness(h.state())
    await restarted.api.connect({ name: 'Warehouse' })
    const authorization = restarted.calls.find((c) => c.operation === 'authorize')
    if (authorization) expect(authorization.input.requestId).toBe(pending.requestId)
    expect(restarted.calls.find((c) => c.operation === 'connect').input.verifier).toBe(pending.verifier)
    expect(restarted.state().token).toBe('b'.repeat(64))
    expect(restarted.state().pendingConnection).toBeUndefined()
  }
})
it('refuses overwriting paired v0.3 identity or pending receipts and preserves archives', async () => {
  for (const initial of [
    { token: 'old', live: { stage: 'ACKNOWLEDGED' } },
    { pending: { eventId: 'receipt' } },
    { live: { stage: 'UNKNOWN' } },
  ]) {
    const h = harness(initial)
    expect(h.api).toBeDefined()
    await expect(h.api.connect({ name: 'New' })).rejects.toThrow()
    expect(h.state()).toEqual(initial)
    expect(h.calls).toHaveLength(0)
  }
})
it('invalidates saved proof on changed session, scope or expiry without overwriting device data', async () => {
  const h = harness({ archivedReceipts: [{ deviceId: 'old' }] })
  expect(h.api).toBeDefined()
  h.lose('connect')
  await expect(h.api.connect({ name: 'Warehouse' })).rejects.toThrow()
  for (const mutation of ['actor', 'scope', 'expiry']) {
    const state = structuredClone(h.state())
    if (mutation === 'expiry') state.pendingConnection.expiresAt = Date.now() - 1
    const next = harness(state)
    if (mutation === 'actor') next.session({ ...session, actor: { ...session.actor, id: 'other' } })
    if (mutation === 'scope') next.session({ ...session, scope: { ...scope, sellerAccountId: 'other' } })
    await expect(next.api.connect({ name: 'Warehouse' })).rejects.toThrow()
    expect(next.state().pendingConnection).toBeUndefined()
    expect(next.state().archivedReceipts).toEqual([{ deviceId: 'old' }])
    expect(next.calls.filter((c) => c.operation === 'connect')).toHaveLength(0)
  }
})
it('reports absent tabs without opening or connecting automatically', async () => {
  const h = harness()
  expect(h.api).toBeDefined()
  h.tabs([])
  expect(await h.api.detect()).toEqual({ status: 'no-tab' })
  expect(h.calls).toHaveLength(0)
})
function relayHarness(origin = 'https://htcerp.app', subframe = false) {
  let listener: any
  const calls: any[] = []
  const top = {}
  const context: any = {
    URL,
    AbortSignal,
    top,
    self: subframe ? {} : top,
    location: { origin },
    chrome: {
      runtime: {
        id: 'ext',
        getURL: (path: string) => 'chrome-extension://ext/' + path,
        onMessage: {
          addListener: (fn: any) => {
            listener = fn
          },
        },
      },
    },
    fetch: async (url: any, options: any) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...session,
          token: 'must-not-leak',
          cookie: 'must-not-leak',
          grantId: '123e4567-e89b-42d3-a456-426614174000',
          expiresAt: Date.now() + 1000,
        }),
      }
    },
  }
  try {
    runInNewContext(readFileSync(new URL('erp-relay.js', directory), 'utf8'), context)
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
  }
  const invoke = (message: any, sender: any = { id: 'ext' }) =>
    new Promise<any>((resolve) => {
      if (!listener || !listener(message, sender, resolve)) resolve({ rejected: true })
    })
  return { calls, invoke }
}
it('relays only fixed top-frame own-background requests and strips all extra response fields', async () => {
  const h = relayHarness()
  const response = await h.invoke({ type: 'sf-erp-relay', operation: 'session' })
  expect(response).toEqual({ ok: true, value: session })
  expect(h.calls[0].url).toBe('https://htcerp.app/api/inventory-sync/connection/session')
  expect(h.calls[0].options.credentials).toBe('same-origin')
  expect(h.calls[0].options.redirect).toBe('error')
  const authorization = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    challenge: 'a'.repeat(64),
    name: 'Warehouse',
  }
  expect(
    (await h.invoke({ type: 'sf-erp-relay', operation: 'authorize', input: authorization })).ok,
  ).toBe(true)
  expect(JSON.parse(h.calls[1].options.body)).toEqual(authorization)
  expect(JSON.stringify(response)).not.toContain('must-not-leak')
  for (const sender of [
    { id: 'other' },
    { id: 'ext', tab: { id: 1 } },
    { id: 'ext', url: 'https://htcerp.app' },
    { id: 'ext', url: 'chrome-extension://ext/connection.html' },
  ]) {
    expect(await h.invoke({ type: 'sf-erp-relay', operation: 'session' }, sender)).toEqual({
      rejected: true,
    })
  }
  for (const message of [
    { type: 'sf-erp-relay', operation: 'fetch', url: 'https://evil.example' },
    { type: 'sf-erp-relay', operation: 'authorize', input: { ...authorization, verifier: 'secret' } },
    { type: 'sf-erp-relay', operation: 'session', url: '/api/accounts' },
  ]) {
    expect(await h.invoke(message)).toEqual({ rejected: true })
  }
  expect(h.calls).toHaveLength(2)
  for (const isolated of [
    relayHarness('https://evil.example'),
    relayHarness('https://htcerp.app', true),
  ]) {
    expect(await isolated.invoke({ type: 'sf-erp-relay', operation: 'session' })).toEqual({
      rejected: true,
    })
    expect(isolated.calls).toHaveLength(0)
  }
})
