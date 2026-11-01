import { WorkerEntrypoint } from 'cloudflare:workers'

export default class OpenRouterUS extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (
      request.method !== 'POST' ||
      url.origin !== 'https://openrouter.ai' ||
      !['/api/v1/chat/completions', '/api/alpha/decisions'].includes(url.pathname) ||
      url.search
    )
      return new Response(null, { status: 400 })
    return fetch(
      new Request(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: request.headers.get('authorization') ?? '',
          'content-type': 'application/json',
        },
        body: request.body,
        signal: AbortSignal.timeout(60000),
      }),
    )
  }
}
