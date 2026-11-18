import { PDFDocument, type PDFEmbeddedPage, PrintScaling } from 'pdf-lib'
import { getDocumentProxy } from 'unpdf'
import { z } from 'zod'
import { type ConnectionBindings, providerCredentials } from '../connections/credentials'
import { PublicError } from '../contracts/errors'
import { LabelCache, labelCacheKey, pdfHash } from './cache'

const pointsPerMm = 72 / 25.4
const pageSize = 80 * pointsPerMm
const maxPages = 1000
const maxPdfBytes = 12 * 1024 * 1024
const amazonOrigins = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  FE: 'https://sellingpartnerapi-fe.amazon.com',
}
const templateKey = 'product-labels/eu-rep-ceramic-80mm-v1.pdf'
const inputSchema = z.object({
  sellerAccountId: z.string().trim().min(1).max(255),
  batchId: z.string().max(255).optional(),
  marketplaceId: z.string().regex(/^[A-Z0-9]{1,20}$/),
  region: z.enum(['NA', 'EU', 'FE']),
  locale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(150)
    .regex(/^[^\p{Cc}\\/]+$/u),
  lines: z
    .array(
      z.object({
        sku: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^\p{Cc}]+$/u),
        fnsku: z.string().regex(/^[A-Z0-9]{10}$/),
        units: z.number().int().positive().max(maxPages),
      }),
    )
    .min(1)
    .max(maxPages),
})

export type ProductLabelInput = z.input<typeof inputSchema>
type Input = ProductLabelInput
type Line = Input['lines'][number]
export type ProductLabelEnvironment = ConnectionBindings & { ARCHIVE: Pick<R2Bucket, 'get' | 'put'> }

function invalid(message: string) {
  return new PublicError('PRODUCT_LABEL_INPUT_INVALID', message, 400)
}

function amazonError(code: string, message: string, status = 502, retryable = false) {
  return new PublicError(code, message, status, 'amazon', retryable)
}

function collectLines(lines: Line[]) {
  const grouped = new Map<string, Line>()
  let total = 0
  for (const line of lines) {
    total += line.units
    const existing = grouped.get(line.sku)
    if (existing && existing.fnsku !== line.fnsku)
      throw invalid(`同一个 SKU 对应多个 FNSKU，请核对分拣结果：${line.sku}`)
    if (existing) existing.units += line.units
    else grouped.set(line.sku, { ...line })
  }
  if (total > maxPages) throw invalid(`每次最多生成 ${maxPages} 张标签，请分批下载。`)
  return [...grouped.values()]
}

async function request(send: typeof fetch, url: string, init: RequestInit = {}) {
  let response: Response
  try {
    response = await send(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(25_000) })
  } catch {
    throw amazonError('PRODUCT_LABEL_REQUEST_FAILED', '暂时无法连接亚马逊标签服务，请重试。', 502, true)
  }
  if (response.ok) return response
  if (response.status === 429)
    throw amazonError('PRODUCT_LABEL_THROTTLED', '亚马逊标签接口繁忙，请稍后重试。', 429, true)
  if (response.status === 401 || response.status === 403)
    throw amazonError('PRODUCT_LABEL_ACCESS_DENIED', '亚马逊拒绝了标签请求，请检查店铺授权和站点。')
  throw amazonError(
    'PRODUCT_LABEL_REQUEST_FAILED',
    '亚马逊未能提供商品标签，请核对店铺、站点和 SKU。',
    502,
    response.status >= 500,
  )
}

const responseInvalid = () => amazonError('PRODUCT_LABEL_RESPONSE_INVALID', '亚马逊标签文件链接无效。')
const pdfInvalid = () =>
  amazonError('PRODUCT_LABEL_PDF_INVALID', '亚马逊商品标签 PDF 无法读取或不符合单张标签格式。')

async function downloadPdf(send: typeof fetch, uri: string, limit: number) {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw responseInvalid()
  }
  // Amazon returns short-lived S3 links. Leave the LWA header on the SP-API request only.
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !/(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname)
  )
    throw responseInvalid()
  const response = await request(send, uri)
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw pdfInvalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const read = await reader.read()
      if (read.done) break
      size += read.value.byteLength
      if (size > limit) throw pdfInvalid()
      chunks.push(read.value)
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    throw pdfInvalid()
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw pdfInvalid()
  return bytes
}

async function fetchLabels(
  send: typeof fetch,
  token: string,
  input: Input,
  lines: Line[],
  sizeLimit: number,
) {
  const response = await request(
    send,
    `${amazonOrigins[input.region]}/inbound/fba/2024-03-20/items/labels`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        marketplaceId: input.marketplaceId,
        mskuQuantities: lines.map(({ sku, units }) => ({ msku: sku, quantity: units })),
        labelType: 'THERMAL_PRINTING',
        width: 70,
        height: 30,
        localeCode: input.locale,
      }),
    },
  )
  const parsed = z
    .object({
      documentDownloads: z
        .array(
          z.object({
            uri: z.string().max(8192),
            downloadType: z.literal('URL'),
          }),
        )
        .min(1)
        .max(20),
    })
    .safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw responseInvalid()

  const documents: Uint8Array[] = []
  let available = sizeLimit
  for (const { uri } of parsed.data.documentDownloads) {
    const bytes = await downloadPdf(send, uri, available)
    available -= bytes.byteLength
    documents.push(bytes)
  }
  return documents
}

async function labelText(archive: ProductLabelEnvironment['ARCHIVE'], bytes: Uint8Array) {
  const reader = await getDocumentProxy(bytes.slice(), {
    cMapUrl: 'https://product-label-cmaps.invalid/',
    useWorkerFetch: false,
    useWasm: false,
    BinaryDataFactory: class {
      async fetch({ kind, filename }: { kind: string; filename: string }) {
        if (kind !== 'cMapUrl' || !/^[A-Za-z0-9_-]{1,60}\.bcmap$/.test(filename)) throw pdfInvalid()
        const map = await archive.get(`product-labels/cmaps/${filename}`)
        if (!map || map.size > 256 * 1024) throw pdfInvalid()
        return new Uint8Array(await map.arrayBuffer())
      }
    },
  })
  try {
    const pages: string[] = []
    for (let number = 1; number <= reader.numPages; number++) {
      const page = await reader.getPage(number)
      const content = await page.getTextContent()
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
          .join(''),
      )
    }
    return pages
  } finally {
    await reader.loadingTask.destroy()
  }
}

/** Check every returned page before publishing any originals in a batch. */
async function splitOriginals(
  archive: ProductLabelEnvironment['ARCHIVE'],
  documents: Uint8Array[],
  lines: Line[],
) {
  const expected = new Map(lines.map((line) => [line.fnsku, line.sku]))
  const originals = new Map<string, Uint8Array>()
  const loaded = await Promise.all(
    documents.map(async (bytes) => ({
      bytes,
      pdf: await PDFDocument.load(bytes).catch(() => {
        throw pdfInvalid()
      }),
    })),
  )
  const count = loaded.reduce((total, { pdf }) => total + pdf.getPageCount(), 0)
  if (count !== lines.length)
    throw amazonError(
      'PRODUCT_LABEL_COUNT_MISMATCH',
      `需要 ${lines.length} 张原始标签，亚马逊返回了 ${count} 张。`,
    )
  for (const { bytes, pdf } of loaded) {
    const text = await labelText(archive, bytes).catch(() => {
      throw pdfInvalid()
    })
    if (text.length !== pdf.getPageCount()) throw pdfInvalid()
    for (const [index, page] of pdf.getPages().entries()) {
      const codes = text[index]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[A-Z0-9]{10}$/.test(line))
      const sku = codes.length === 1 ? expected.get(codes[0]) : undefined
      if (!sku || originals.has(sku))
        throw amazonError(
          'PRODUCT_LABEL_MISMATCH',
          '亚马逊标签含无法识别或与分拣单不符的 FNSKU，请核对商品标签。',
        )
      labelBox(page)
      const single = await PDFDocument.create()
      const [copy] = await single.copyPages(pdf, [index])
      single.addPage(copy)
      originals.set(sku, await single.save())
    }
  }
  return originals
}

function labelBox(page: import('pdf-lib').PDFPage) {
  const { x, y, width, height } = page.getCropBox()
  if (
    page.getRotation().angle % 360 ||
    width <= 0 ||
    height <= 0 ||
    width > pageSize ||
    height > pageSize / 2 - pointsPerMm
  )
    throw pdfInvalid()
  return { left: x, bottom: y, right: x + width, top: y + height }
}

async function loadTemplate(env: ProductLabelEnvironment) {
  const asset = await env.ARCHIVE.get(templateKey)
  const error = () =>
    new PublicError('PRODUCT_LABEL_TEMPLATE_UNAVAILABLE', '固定欧代标签模板尚未配置或尺寸不正确。', 503)
  if (!asset || asset.size > maxPdfBytes) throw error()
  const bytes = new Uint8Array(await asset.arrayBuffer())
  const doc = await PDFDocument.load(bytes).catch(() => {
    throw error()
  })
  const page = doc.getPages()[0]
  if (
    doc.getPageCount() !== 1 ||
    Math.abs(page.getWidth() - pageSize) > 0.05 ||
    Math.abs(page.getHeight() - pageSize) > 0.05 ||
    page.getRotation().angle % 360
  )
    throw error()
  return { page, revision: await pdfHash(bytes) }
}

/** Content revision, not an object timestamp: all groups use this exact fixed template. */
export async function productLabelTemplateRevision(env: ProductLabelEnvironment) {
  return (await loadTemplate(env)).revision
}

async function accessToken(env: ProductLabelEnvironment, send: typeof fetch) {
  const { credentials } = await providerCredentials(env, 'amazon')
  const { SP_CLIENT_ID, SP_CLIENT_SECRET, SP_REFRESH_TOKEN } = credentials
  if (!SP_CLIENT_ID || !SP_CLIENT_SECRET || !SP_REFRESH_TOKEN)
    throw new PublicError('PRODUCT_LABEL_NOT_CONFIGURED', '请先配置店铺的 Amazon SP-API 授权。', 409)
  const auth = await request(send, 'https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SP_CLIENT_ID,
      client_secret: SP_CLIENT_SECRET,
      refresh_token: SP_REFRESH_TOKEN,
    }),
  })
  const token = z
    .object({ access_token: z.string().min(1) })
    .safeParse(await auth.json().catch(() => null))
  if (!token.success) throw amazonError('PRODUCT_LABEL_ACCESS_DENIED', '无法验证亚马逊店铺授权。')
  return token.data.access_token
}

async function getOriginals(
  env: ProductLabelEnvironment,
  cache: LabelCache,
  input: Input,
  lines: Line[],
  send: typeof fetch,
) {
  const scope = [
    input.sellerAccountId,
    input.marketplaceId,
    input.region,
    input.locale,
    'THERMAL_PRINTING',
    70,
    30,
  ]
  const entries = await Promise.all(
    lines.map(async (line) => ({
      line,
      key: await labelCacheKey('original', [...scope, line.sku, line.fnsku]),
    })),
  )
  const originals = new Map<string, Uint8Array>()
  const owned: typeof entries = []
  const pending: typeof entries = []
  for (const entry of entries) {
    const bytes = await cache.read(entry.key)
    if (bytes) originals.set(entry.line.sku, bytes)
    else if (await cache.claim(entry.key)) owned.push(entry)
    else pending.push(entry)
  }
  // Auth is deliberately lazy: cache hits (including other Workers' completed leases) need none.
  let token: Promise<string> | undefined
  let remainingBytes = maxPdfBytes
  async function generate(batch: typeof entries) {
    token ??= accessToken(env, send)
    const documents = await fetchLabels(
      send,
      await token,
      input,
      batch.map(({ line }) => ({ ...line, units: 1 })),
      remainingBytes,
    )
    remainingBytes -= documents.reduce((sum, document) => sum + document.byteLength, 0)
    return splitOriginals(
      env.ARCHIVE,
      documents,
      batch.map(({ line }) => line),
    )
  }
  // Disjoint FNSKUs give each returned page an unambiguous SKU, regardless of Amazon's ordering.
  while (owned.length) {
    const batch: typeof entries = []
    const codes = new Set<string>()
    for (let i = 0; i < owned.length && batch.length < 100; ) {
      if (codes.has(owned[i].line.fnsku)) {
        i++
        continue
      }
      codes.add(owned[i].line.fnsku)
      batch.push(...owned.splice(i, 1))
    }
    const generated = await generate(batch)
    for (const { key, line } of batch) {
      const bytes = generated.get(line.sku)
      if (!bytes) throw pdfInvalid()
      await cache.publish(key, bytes)
      originals.set(line.sku, bytes)
    }
  }
  // Wait only after publishing our own claimed entries: overlapping batches cannot deadlock.
  for (const entry of pending) {
    const bytes = await cache.getOrCreate(entry.key, async () => {
      const generated = (await generate([entry])).get(entry.line.sku)
      if (!generated) throw pdfInvalid()
      return generated
    })
    originals.set(entry.line.sku, bytes)
  }
  return originals
}

/** Server-authorized seller scope and exact ordered rows. No browser or machine-local label cache. */
export async function downloadMergedProductLabels(
  env: ProductLabelEnvironment,
  raw: Input,
  send: typeof fetch = (url, init) => fetch(url, init),
): Promise<Response> {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw invalid('请先核对店铺、站点、SKU、FNSKU 和备货件数。')
  const input = parsed.data
  const uniqueLines = collectLines(input.lines)
  const template = await loadTemplate(env)
  const key = await labelCacheKey('merged', {
    sellerAccountId: input.sellerAccountId,
    marketplaceId: input.marketplaceId,
    region: input.region,
    locale: input.locale,
    format: '80x80-eu-rep-v1',
    template: template.revision,
    lines: input.lines,
  })
  const cache = new LabelCache(env)
  let bytes: Uint8Array
  try {
    bytes = await cache.getOrCreate(key, async () => {
      const originals = await getOriginals(env, cache, input, uniqueLines, send)
      const output = await PDFDocument.create()
      output.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None)
      const background = await output.embedPage(template.page)
      const embedded = new Map<string, PDFEmbeddedPage>()
      for (const [sku, original] of originals) {
        const pdf = await PDFDocument.load(original).catch(() => {
          throw pdfInvalid()
        })
        if (pdf.getPageCount() !== 1) throw pdfInvalid()
        const page = pdf.getPages()[0]
        embedded.set(sku, await output.embedPage(page, labelBox(page)))
      }
      for (const { sku, units } of input.lines) {
        const label = embedded.get(sku)
        if (!label) throw pdfInvalid()
        for (let unit = 0; unit < units; unit++) {
          const page = output.addPage([pageSize, pageSize])
          page.drawPage(background)
          page.drawPage(label, { x: (pageSize - label.width) / 2, y: pointsPerMm })
        }
      }
      return output.save().catch(() => {
        throw pdfInvalid()
      })
    })
  } finally {
    await cache.close()
  }
  const filename = encodeURIComponent(`${input.filename.replace(/\.pdf$/i, '')}.pdf`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return new Response(bytes.slice().buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="product-labels.pdf"; filename*=UTF-8''${filename}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Product-Label-Template': template.revision,
    },
  })
}
