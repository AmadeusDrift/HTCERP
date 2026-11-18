import { expect, it, vi } from 'vitest'
import type { ConnectionBindings } from '../../packages/connections/credentials'
import { AmazonSourceClient, parseReport, sourceConnection } from '../../packages/inventory-sync/source'

const env = {
  DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  SP_CLIENT_ID: 'test-client',
  SP_CLIENT_SECRET: 'secret-do-not-log',
  SP_REFRESH_TOKEN: 'refresh-do-not-log',
} as unknown as ConnectionBindings
const auth = () => Response.json({ access_token: 'access-do-not-log', expires_in: 3600 })

it('uses protected credentials, limits diagnostics, and exposes no upstream secret-bearing errors', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(new Response('access-do-not-log https://secret-url', { status: 403 }))
  const api = new AmazonSourceClient(env, request)
  await expect(api.inventory([])).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  await expect(api.inventory(['A-J1T'])).rejects.toThrow('SOURCE_AMAZON_REQUEST_FAILED')
  expect(request.mock.calls[1][1]).toMatchObject({
    method: 'GET',
    redirect: 'manual',
    headers: { 'x-amz-access-token': 'access-do-not-log' },
  })
  expect(String(request.mock.calls[1][0])).toContain('/fba/inventory/v1/summaries?')
})

it('downloads GZIP report streams without forwarding Amazon access credentials to presigned S3', async () => {
  const raw = 'sku\tafn-fulfillable-quantity\tstore\nA-J1T\t2\tLow-Cost Store\n'
  const compressed = await new Response(
    new Response(raw).body!.pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(
      Response.json({
        url: 'https://report-bucket.s3.amazonaws.com/report?signature=private',
        compressionAlgorithm: 'GZIP',
      }),
    )
    .mockResolvedValueOnce(new Response(compressed))
  let saved = ''
  const bucket = {
    put: async (_key: string, stream: ReadableStream) => {
      saved = await new Response(stream).text()
    },
  } as unknown as R2Bucket
  await new AmazonSourceClient(env, request).download('doc', bucket, 'raw.tsv')
  expect(saved).toBe(raw)
  expect(request.mock.calls[2][1]?.headers).toBeUndefined()
})

it('rejects truncated compressed reports before a raw object can be completed', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(
      Response.json({ url: 'https://bucket.s3.amazonaws.com/report', compressionAlgorithm: 'GZIP' }),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array([31, 139, 8])))
  let completed = false
  const bucket = {
    put: async (_key: string, stream: ReadableStream) => {
      await new Response(stream).arrayBuffer()
      completed = true
    },
  } as unknown as R2Bucket
  await expect(new AmazonSourceClient(env, request).download('doc', bucket, 'raw.tsv')).rejects.toThrow(
    'SOURCE_REPORT_DOWNLOAD_FAILED',
  )
  expect(completed).toBe(false)
})

it('rejects report download redirects and untrusted hosts', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(Response.json({ url: 'https://untrusted.example/report' }))
  await expect(
    new AmazonSourceClient(env, request).download('doc', {} as R2Bucket, 'raw.tsv'),
  ).rejects.toThrow('SOURCE_REPORT_DOWNLOAD_FAILED')
  expect(request).toHaveBeenCalledTimes(2)
})

it('rejects seller or credential drift before requests even with a cached access token', async () => {
  let seller = 'SELLER'
  const dynamic = {
    ...env,
    DB: {
      prepare: (sql: string) =>
        sql.includes('title_audit_store')
          ? { first: async () => ({ seller }) }
          : { bind: () => ({ first: async () => null }) },
    },
  } as unknown as ConnectionBindings
  const expected = (await sourceConnection(dynamic)).identity
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValue(Response.json({ processingStatus: 'DONE', reportDocumentId: 'doc' }))
  const api = new AmazonSourceClient(dynamic, request, expected)
  await api.poll('report')
  dynamic.SP_REFRESH_TOKEN = 'changed-secret'
  await expect(api.poll('report')).rejects.toThrow('SOURCE_CONNECTION_CHANGED')
  dynamic.SP_REFRESH_TOKEN = env.SP_REFRESH_TOKEN
  seller = 'OTHER'
  await expect(api.poll('report')).rejects.toThrow('SOURCE_CONNECTION_CHANGED')
  expect(request).toHaveBeenCalledTimes(2)
})

it('calls the default fetch binding without an illegal Worker receiver', async () => {
  let calls = 0
  const binding = async function (this: unknown) {
    if (this !== undefined) throw new TypeError('Illegal invocation')
    calls++
    return calls === 1 ? auth() : Response.json({ processingStatus: 'DONE', reportDocumentId: 'doc' })
  }
  vi.stubGlobal('fetch', binding)
  try {
    expect(await new AmazonSourceClient(env).poll('report')).toMatchObject({
      status: 'DONE',
      documentId: 'doc',
    })
    expect(calls).toBe(2)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('normalizes explicitly declared CP1252 report bytes to UTF8 without corrupting non-ASCII SKUs', async () => {
  const bytes = Uint8Array.from(
    Array.from('sku\tafn-fulfillable-quantity\tstore\nCAF\xe9-\x80-J1T\t2\tLow-Cost Store\n', (ch) =>
      ch.charCodeAt(0),
    ),
  )
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(Response.json({ url: 'https://bucket.s3.amazonaws.com/report' }))
    .mockResolvedValueOnce(
      new Response(bytes, { headers: { 'content-type': 'text/plain; charset=Cp1252' } }),
    )
  let saved = new Uint8Array(),
    metadata: unknown
  const bucket = {
    put: async (_key: string, value: Uint8Array, options: unknown) => {
      saved = new Uint8Array(value)
      metadata = options
    },
  } as unknown as R2Bucket
  await new AmazonSourceClient(env, request).download('doc', bucket, 'raw.tsv')
  const rows = []
  for await (const row of parseReport(new Response(saved).body!, 'inventory')) rows.push(row)
  expect(rows).toEqual([{ sku: 'CAFé-€-J1T', sellable: 2 }])
  expect(metadata).toMatchObject({
    customMetadata: { sourceCharset: 'windows-1252', archiveCharset: 'utf-8' },
  })
})

it.each([
  ['text/plain; charset=utf-16', 'SOURCE_REPORT_CHARSET_UNSUPPORTED'],
  ['text/plain; charset=utf-8', 'SOURCE_REPORT_DECODE_FAILED'],
])('fails closed on unsupported or malformed declared encoding %s', async (contentType, code) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(Response.json({ url: 'https://bucket.s3.amazonaws.com/report' }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([0xe9]), { headers: { 'content-type': contentType } }),
    )
  const put = vi.fn()
  await expect(
    new AmazonSourceClient(env, request).download('doc', { put } as unknown as R2Bucket, 'raw.tsv'),
  ).rejects.toThrow(code)
  expect(put).not.toHaveBeenCalled()
})
