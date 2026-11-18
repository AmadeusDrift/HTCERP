import { AmazonUS } from '../amazon/adapter'
import { type ConnectionBindings, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { fileKey, PrivateFileCache, type FileEnvironment } from './cache'

export type ImageScope = { sellerAccountId: string; marketplaceId: string }
export type ProductImage = {
  bytes: Uint8Array
  extension: 'jpeg' | 'png'
  width: number
  height: number
  asin: string
  url: string
}
export type ImageEnvironment = ConnectionBindings & FileEnvironment
type Source = Pick<AmazonUS, 'productMainImage'>
const invalid = () =>
  new PublicError('PRODUCT_IMAGE_UNAVAILABLE', '主图缺失或图片文件无法读取，请重试取图。', 502)
const maxBytes = 8 * 1024 * 1024

export function imageDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0,
    height = 0,
    extension: 'jpeg' | 'png' = 'jpeg'
  if (bytes.length >= 24 && bytes.slice(0, 8).join() === '137,80,78,71,13,10,26,10') {
    extension = 'png'
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let i = 2
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 255) throw invalid()
      while (bytes[i] === 255) i++
      const marker = bytes[i++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = view.getUint16(i)
      if (length < 2 || i + length > bytes.length) throw invalid()
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
      ) {
        if (length < 8) throw invalid()
        height = view.getUint16(i + 3)
        width = view.getUint16(i + 5)
        break
      }
      i += length
    }
  }
  if (!width || !height || width * height > 40_000_000) throw invalid()
  return { extension, width, height }
}
export class ProductImages {
  constructor(
    private readonly env: ImageEnvironment,
    private source?: Source,
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async get(scope: ImageScope, sku: string): Promise<ProductImage> {
    if (scope.marketplaceId !== 'ATVPDKIKX0DER' || !sku || sku.length > 512) throw invalid()
    const key = await fileKey('original', [scope.sellerAccountId, scope.marketplaceId, sku])
    const file = await new PrivateFileCache(this.env).getOrCreate(key, async () => {
      this.source ??= new AmazonUS(
        (await providerCredentials(this.env, 'amazon')).credentials,
        this.send,
        this.env.DB,
      )
      const result = await this.source.productMainImage(scope.sellerAccountId, sku)
      const url = new URL(result.url)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !/(^|\.)(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|images\.amazon\.com)$/i.test(
          url.hostname,
        )
      )
        throw invalid()
      const response = await this.send(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes)
        throw invalid()
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > maxBytes) throw invalid()
          chunks.push(part.value)
        }
      } catch (e) {
        await reader.cancel().catch(() => undefined)
        throw e
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      const dimensions = imageDimensions(bytes)
      return {
        bytes,
        metadata: { ...dimensions, ...result, sku, type: `image/${dimensions.extension}` },
      }
    })
    return {
      bytes: file.bytes,
      ...imageDimensions(file.bytes),
      asin: String(file.metadata.asin),
      url: String(file.metadata.url),
    }
  }
}
