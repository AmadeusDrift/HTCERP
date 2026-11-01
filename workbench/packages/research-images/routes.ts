import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { cleanResearchJpeg } from './jpeg'

const payload = z.object({
  dataUrl: z
    .string()
    .max(219000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
})
export const images = new Hono<AppEnv>()
images.post('/research-images', async (c) => {
  const parsed = payload.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new PublicError('INVALID_INPUT', '请提供 JPEG 参考图。', 400)
  let input: Uint8Array
  try {
    input = Uint8Array.from(atob(parsed.data.dataUrl.slice(23)), (s) => s.charCodeAt(0))
  } catch {
    throw new PublicError('INVALID_INPUT', '图片编码无效。', 400)
  }
  const { bytes, width, height } = cleanResearchJpeg(input)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  digest[6] = (digest[6] & 15) | 128
  digest[8] = (digest[8] & 63) | 128
  const hash = Array.from(digest.subarray(0, 16), (n) => n.toString(16).padStart(2, '0')).join('')
  const id = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20),
  ].join('-')
  await c.env.ARCHIVE.put('research-images/' + id + '.jpg', bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'image/jpeg' },
  })
  await c.env.DB.prepare(
    'INSERT INTO research_images(id,width,height,actor,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
  )
    .bind(id, width, height, c.var.actor.email, new Date().toISOString())
    .run()
  return c.json({ id, width, height }, 201)
})
images.get('/research-images/:id', async (c) => {
  const id = c.req.param('id')
  if (!z.uuid().safeParse(id).success) throw new PublicError('INVALID_INPUT', '参考图编号无效。', 400)
  const object = await c.env.ARCHIVE.get('research-images/' + id + '.jpg')
  if (!object) throw new PublicError('NOT_FOUND', '未找到参考图。', 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  })
})
