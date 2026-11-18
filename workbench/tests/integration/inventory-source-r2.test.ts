import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { archiveReportStream, normalizeReportStream } from '../../packages/inventory-sync/source'

it('archives unknown-length decompressed GZIP through real Worker/R2 single and multipart writes', async () => {
  // Serialize the actual production helper into workerd, not a permissive R2 mock.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-10-01',
      r2Buckets: { ARCHIVE: 'source-r2' },
      script: `
    const archiveReportStream=${archiveReportStream.toString()};
    const normalizeReportStream=${normalizeReportStream.toString()};
    export default {async fetch(request,env){
      const key=new URL(request.url).pathname;
      const normalized=normalizeReportStream(request.body.pipeThrough(new DecompressionStream('gzip')),request.headers.get('content-type'));
      await archiveReportStream(env.ARCHIVE,key,normalized.stream,normalized.sourceCharset);
      const result=await env.ARCHIVE.get(key);
      return new Response(result.body);
    }};
  `,
    }),
  )
  try {
    for (const length of [73, 6 * 1024 * 1024 + 17]) {
      const raw = 'x'.repeat(length)
      const body = await new Response(
        new Response(raw).body!.pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer()
      const response = await mf.dispatchFetch('http://localhost/report-' + length, {
        method: 'POST',
        body,
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(raw)
    }
    const bytes = new Uint8Array([67, 65, 70, 233, 45, 128, 45, 74, 49, 84])
    const body = await new Response(
      new Response(bytes).body!.pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer()
    const response = await mf.dispatchFetch('http://localhost/cp1252', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=Cp1252' },
      body,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('CAFé-€-J1T')
  } finally {
    await mf.dispose()
  }
}, 30000)
