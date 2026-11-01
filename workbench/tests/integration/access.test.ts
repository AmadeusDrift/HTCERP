import { generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { accessRole, authenticate, requiredRole } from '../../apps/api/src/access'

describe('API access boundary', () => {
  it('defaults to closed and ignores email headers and hostnames', async () => {
    await expect(
      authenticate(
        new Request('https://localhost/api/jobs', {
          headers: { 'Cf-Access-Authenticated-User-Email': 'admin@test.invalid' },
        }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
  it('requires an explicit development binding and loopback host', async () => {
    const env = { LOCAL_DEVELOPMENT: '1' }
    expect((await authenticate(new Request('http://127.0.0.1/api/session'), env)).local).toBe(true)
    await expect(authenticate(new Request('https://public.example/api/session'), env)).rejects.toThrow()
  })
  it('requires a signed current Access token plus an assigned role', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const env = {
      ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com',
      ACCESS_AUD: 'app',
      APP_ROLES: '{"admin@example.test":"admin"}',
    }
    const make = async (aud: string, exp: string, email: string) =>
      new Request('https://work.example/api/jobs', {
        headers: {
          'Cf-Access-Jwt-Assertion': await new SignJWT({ email })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer('https://acme.cloudflareaccess.com')
            .setAudience(aud)
            .setExpirationTime(exp)
            .sign(privateKey),
        },
      })
    expect(
      (await authenticate(await make('app', '5m', 'admin@example.test'), env, publicKey)).role,
    ).toBe('admin')
    for (const [aud, exp] of [
      ['other', '5m'],
      ['app', '-1h'],
    ]) {
      await expect(
        authenticate(await make(aud, exp, 'admin@example.test'), env, publicKey),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
    await expect(
      authenticate(await make('app', '5m', 'unknown@example.test'), env, publicKey),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('enforces budgets and connection tests server-side', () => {
    expect(requiredRole('POST', '/api/strategy')).toBe('admin')
    expect(requiredRole('POST', '/api/connections/amazon/test')).toBe('admin')
    expect(requiredRole('GET', '/api/connections')).toBe('admin')
    expect(requiredRole('HEAD', '/api/connections')).toBe('admin')
    expect(requiredRole('GET', '/api/strategy')).toBe('viewer')
    const id = 'c3d633aa-1c88-4e07-9879-2022398fc9ae'
    for (const path of [
      'preferences',
      'presets',
      'presets/' + id + '/rename',
      'presets/' + id + '/delete',
    ])
      expect(requiredRole('POST', '/api/me/' + path)).toBe('viewer')
    expect(requiredRole('POST', '/api/me/accounts')).toBe('admin')
    expect(requiredRole('POST', '/api/me/presets/' + id + '/role')).toBe('admin')
    expect(accessRole('viewer', requiredRole('POST', '/api/jobs'))).toBe(false)
  })
})
