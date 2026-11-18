// Runs the real 13-order snapshot entirely in ephemeral D1/R2, with all outbound network denied.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { chromium } from '@playwright/test'

const synthetic = process.env.FACTORY_SYNTHETIC_MISSING === '1'
const dir = '.local/pack-factory-real',
  out = process.env.FACTORY_TEST_OUTPUT || (synthetic ? '.local/pack-factory-fixture-only' : '../outputs/pack-factory-isolated'),
  stage = process.env.FACTORY_TEST_STAGE || '.local/pack-factory-build'
mkdirSync(out, { recursive: true })
const tables = JSON.parse(readFileSync(dir + '/tables.json', 'utf8')),
  keys = JSON.parse(readFileSync(dir + '/keys.json', 'utf8'))
const batchId = tables.pack_order_batches[0].id,
  hash = (b) => createHash('sha256').update(b).digest('hex')
let outbound = 0
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: stage + '/bundle/index.js',
    compatibilityDate: '2026-10-01',
    bindings: { LOCAL_DEVELOPMENT: '1' },
    d1Databases: { DB: 'factory-isolated' },
    r2Buckets: { ARCHIVE: 'factory-isolated' },
    outboundService: async () => {
      outbound++
      throw Error('Network forbidden in isolated factory test')
    },
  }),
)
try {
  const db = await mf.getD1Database('DB'),
    archive = await mf.getR2Bucket('ARCHIVE')
  for (const name of readdirSync('migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    for (const sql of splitSQL(readFileSync('migrations/' + name, 'utf8'))) await db.prepare(sql).run()
  tables.pack_order_batches.push(...JSON.parse(readFileSync(dir + '/related-batches.json', 'utf8')))
  const insert = async (table, row) => {
    const cols = Object.keys(row)
    await db
      .prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
      .bind(...cols.map((k) => row[k]))
      .run()
  }
  for (const table of [
    'order_sorting_assets',
    'order_sorting_config',
    'title_audit_store',
    'pack_order_batches',
    'pack_order_rows',
    'pack_order_labels',
    'product_image_cache',
    'product_label_cache',
  ])
    for (const row of tables[table]) await insert(table, row)
  await archive.put(tables.pack_order_batches[0].source_key, readFileSync(dir + '/source.xlsx'))
  for (const file of readdirSync(dir).filter((n) => /^objects-\d+\.json$/.test(n))) {
    for (const item of JSON.parse(readFileSync(dir + '/' + file, 'utf8'))) {
      const bytes = item.bytes.base64
        ? Buffer.from(item.bytes.base64, 'base64')
        : Buffer.from(JSON.stringify(item.bytes))
      await archive.put(item.key, bytes)
    }
  }
  for (const name of readdirSync('packages/product-labels/cmaps').filter((n) => n.endsWith('.bcmap')))
    await archive.put(
      'product-labels/cmaps/' + name,
      readFileSync('packages/product-labels/cmaps/' + name),
    )
  if (existsSync(dir + '/extra-images.json'))
    for (const image of JSON.parse(readFileSync(dir + '/extra-images.json', 'utf8'))) {
      await archive.put(image.row.object_key, readFileSync(dir + '/' + image.file))
      await insert('product_image_cache', image.row)
    }
  let syntheticImages = 0
  if (synthetic) {
    // Explicit test doubles for missing image responses; never present this ZIP as a factory deliverable.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    )
    for (let i = 0; i < keys.imageKeys.length; i++) {
      const key = keys.imageKeys[i]
      if (
        (
          await db
            .prepare('SELECT object_key FROM product_image_cache WHERE cache_key=?')
            .bind(key)
            .first()
        )?.object_key
      )
        continue
      const object_key = 'isolated-fixture-image/' + i
      await archive.put(object_key, png)
      await insert('product_image_cache', {
        cache_key: key,
        object_key,
        content_sha256: hash(png),
        metadata_json: JSON.stringify({
          type: 'image/png',
          sku: keys.rows[i][1],
          asin: 'B000000001',
          width: 1,
          height: 1,
          extension: 'png',
          sourceUrl: 'https://m.media-amazon.com/isolated-test-only.png',
        }),
        lease_owner: null,
        lease_until: 0,
        updated_at: Date.now(),
      })
      syntheticImages++
    }
  }
  const cookies = { admin: 'a'.repeat(64), operator: 'b'.repeat(64), viewer: 'c'.repeat(64) }
  for (const [role, cookie] of Object.entries(cookies)) {
    await db
      .prepare("INSERT INTO accounts(id,username,role,salt,password_hash) VALUES(?,?,?,'','')")
      .bind(role, role, role)
      .run()
    await db
      .prepare('INSERT INTO account_sessions VALUES(?,?,1,?)')
      .bind(hash(cookie), role, Math.floor(Date.now() / 1000) + 3600)
      .run()
  }
  const origin = 'http://127.0.0.1:18987',
    base = '/api/order-sorting/pack/' + batchId
  const api = (path, method = 'GET', role = 'admin', body) =>
    mf.dispatchFetch(origin + path, {
      method,
      headers: {
        ...(role ? { Cookie: 'workbench_dev_session=' + cookies[role] } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const unchanged = async () =>
    JSON.stringify(
      await Promise.all(
        [
          'pack_order_batches',
          'pack_order_requests',
          'pack_order_rows',
          'order_sorting_config',
          'order_sorting_versions',
          'inventory_automatic_settings',
        ].map(async (t) => (await db.prepare(`SELECT * FROM ${t}`).all()).results),
      ),
    )
  const before = await unchanged()
  assert.equal((await api(base + '/factory-package', 'POST', '')).status, 401)
  assert.equal((await api(base + '/factory-package', 'POST', 'viewer', {})).status, 403)
  const response = await api(base + '/factory-package', 'POST', 'operator', {})
  const result = await response.json()
  if (response.status !== 200) {
    writeFileSync(
      out + '/runtime-pending.json',
      JSON.stringify(
        { status: response.status, result, outbound, ledgerUnchanged: before === (await unchanged()) },
        null,
        2,
      ),
    )
    throw Error('Factory prepare failed: ' + JSON.stringify(result))
  }
  assert.equal(result.rowCount, 13)
  assert.equal(result.orderCount, 13)
  assert.equal(result.units, 17)
  assert.equal(result.newRows, 5)
  assert.equal(result.skippedRows, 8)
  const file = await api(base + '/factory-package/' + result.key),
    bytes = Buffer.from(await file.arrayBuffer())
  assert.equal(file.status, 200)
  writeFileSync(out + '/' + result.filename, bytes)
  const zip = await JSZip.loadAsync(bytes)
  assert.deepEqual(
    await zip.file('原始订单.xlsx').async('nodebuffer'),
    readFileSync(dir + '/source.xlsx'),
  )
  let orderRows = 0,
    units = 0,
    pages = 0,
    imageCount = 0
  const found = []
  for (const group of result.groups) {
    const sheet = new ExcelJS.Workbook()
    await sheet.xlsx.load(await zip.file('分拣表/' + group.filename).async('nodebuffer'))
    sheet.worksheets[1].eachRow((r, i) => {
      if (i > 1 && r.getCell(2).value) {
        orderRows++
        units += Number(r.getCell(5).value)
        found.push([
          r.getCell(4).value,
          r.getCell(2).value,
          r.getCell(3).value,
          Number(r.getCell(5).value),
        ])
      }
    })
    const pdf = await PDFDocument.load(
      await zip.file('SKU标签/' + group.filename.replace('.xlsx', '.pdf')).async('uint8array'),
    )
    pages += pdf.getPageCount()
    for (const page of pdf.getPages()) {
      assert.ok(Math.abs(page.getWidth() - (80 * 72) / 25.4) < 0.01)
      assert.ok(Math.abs(page.getHeight() - (80 * 72) / 25.4) < 0.01)
    }
    const picking = new ExcelJS.Workbook()
    await picking.xlsx.load(
      await zip
        .file('带图备货单/' + group.filename.replace('.xlsx', '-带图备货单.xlsx'))
        .async('nodebuffer'),
    )
    imageCount += picking.worksheets[0].getImages().length
  }
  assert.deepEqual(
    { orderRows, units, pages, imageCount },
    { orderRows: 13, units: 17, pages: 17, imageCount: 13 },
  )
  assert.deepEqual(found.sort(), keys.rows.map((r) => [r[3], r[1], r[2], r[4]]).sort())
  const repeat = await api(base + '/factory-package', 'POST', 'operator', {})
  assert.equal(repeat.status, 200)
  assert.deepEqual(await repeat.json(), result)
  const repeatZip = Buffer.from(await (await api(base + '/factory-package/' + result.key)).arrayBuffer())
  assert.equal(hash(repeatZip), hash(bytes))
  assert.equal((await api(base + '/factory-package/' + result.key, 'GET', '')).status, 401)
  assert.equal(
    (
      await api(
        '/api/order-sorting/pack/' + tables.pack_order_batches[1].id + '/factory-package/' + result.key,
      )
    ).status,
    404,
  )
  assert.equal(before, await unchanged())
  assert.equal(outbound, 0)
  // Functional UI test only, using the built frontend and real isolated Worker routes.
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    await context.addCookies([{ name: 'workbench_dev_session', value: cookies.operator, url: origin }])
    const page = await context.newPage()
    await page.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname.startsWith('/api/')) {
        const response = await mf.dispatchFetch(req.url(), {
          method: req.method(),
          headers: req.headers(),
          ...(req.postData() ? { body: req.postData() } : {}),
        })
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        })
      }
      const file = resolve(stage + '/dist/web', '.' + url.pathname),
        root = resolve(stage + '/dist/web')
      if (!file.startsWith(root)) return route.abort()
      const selected = existsSync(file) && extname(file) ? file : root + '/index.html'
      const mime =
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        }[extname(selected)] || 'application/octet-stream'
      return route.fulfill({ body: readFileSync(selected), contentType: mime })
    })
    await page.goto(origin + '/order-sorting?packBatch=' + batchId)
    const newScope = page.getByRole('radio', { name: /仅本次新增.*5 条.*6 件/ })
    await newScope.waitFor()
    assert.ok(await newScope.isChecked())
    await page.getByRole('radio', { name: /本次全部/ }).check()
    const walletGroup = page.getByRole('row').filter({ has: page.getByRole('button', { name: /HUJM/ }) })
    await walletGroup.getByText('13 件', { exact: true }).waitFor()
    await walletGroup.getByRole('button', { name: /HUJM/ }).click()
    assert.equal(await page.getByRole('table', { name: 'HUJM 明细' }).locator('tbody tr').count(), 9)
    await walletGroup.locator('summary').click()
    const labelDownload = page.waitForEvent('download')
    await walletGroup.getByRole('button', { name: 'SKU标签' }).click()
    const groupPdf = await PDFDocument.load(readFileSync(await (await labelDownload).path()))
    assert.equal(groupPdf.getPageCount(), 13)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载全部订单工厂包 · 17 件', exact: true }).click()
    const downloaded = await download
    assert.equal(hash(readFileSync(await downloaded.path())), hash(bytes))
    await page.getByRole('status').filter({ hasText: '已导出全部订单工厂包' }).waitFor()
    assert.match(
      await page.getByRole('status').filter({ hasText: '已导出全部订单工厂包' }).innerText(),
      /13 个订单.*17 件/,
    )
    writeFileSync(
      out + '/ui-check.txt',
      await page.getByRole('status').filter({ hasText: '已导出全部订单工厂包' }).innerText(),
    )
  } finally {
    await browser.close()
  }
  assert.equal(before, await unchanged())
  assert.equal(outbound, 0)
  const report = {
    ...result,
    bytes: bytes.length,
    sha256: hash(bytes),
    orderRows,
    units,
    pages,
    imageCount,
    syntheticImages,
    notForFactory: synthetic,
    ledgerUnchanged: true,
    repeatSameBytes: true,
    outboundRequests: outbound,
    uiDownloadPassed: true,
    productionWrites: 0,
    deployed: false,
  }
  writeFileSync(out + '/验收结果.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await mf.dispose()
}
