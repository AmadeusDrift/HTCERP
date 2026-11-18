import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { unstable_splitSqlQuery as splitSQL } from 'wrangler'
import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts } from 'pdf-lib'

let apiLabelCalls=0, apiLabelFinished=false, imageCalls=0
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')
const native=await PDFDocument.create()
const font=await native.embedFont(StandardFonts.Helvetica)
native.addPage([70*72/25.4,30*72/25.4]).drawText('X005EVJ3LD',{x:10,y:20,size:10,font})
const nativeBytes=await native.save()
const templatePdf = await PDFDocument.create()
const templateFont = await templatePdf.embedFont(StandardFonts.Helvetica)
const templateSize = (80 * 72) / 25.4
templatePdf.addPage([templateSize, templateSize]).drawText('EU REP FIXTURE', {
  x: 10,
  y: 160,
  size: 10,
  font: templateFont,
})
// Whole production API routing/authentication, ephemeral DB and R2. No live data/network.
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: process.env.PACK_API_SCRIPT || '.local/pack-api/index.js',
    compatibilityDate: '2026-10-01',
    bindings: { LOCAL_DEVELOPMENT: '1',SP_CLIENT_ID:'test',SP_CLIENT_SECRET:'test',SP_REFRESH_TOKEN:'test' },
    d1Databases: { DB: 'pack-runtime' },
    r2Buckets: { ARCHIVE: 'pack-runtime' },
    outboundService: async request => {
      const url=new URL(request.url)
      if(url.hostname==='api.amazon.com')return Response.json({access_token:'test'})
      if(url.pathname.includes('/listings/'))return Response.json({sku:decodeURIComponent(url.pathname.split('/').at(-1)),summaries:[{marketplaceId:'ATVPDKIKX0DER',asin:'B000000079'}]})
      if(url.pathname.includes('/catalog/'))return Response.json({asin:'B000000079',images:[{marketplaceId:'ATVPDKIKX0DER',images:[{variant:'MAIN',link:'https://m.media-amazon.com/fixture.png',height:1000}]}]})
      if(url.hostname==='m.media-amazon.com'){imageCalls++;return new Response(imageBytes)}
      if(url.pathname.endsWith('/items/labels')){apiLabelCalls++;await new Promise(resolve=>setTimeout(resolve,1500));apiLabelFinished=true;const body=await request.json();assert.equal(body.mskuQuantities[0].quantity,1);return Response.json({documentDownloads:[{uri:'https://fixture.s3.us-east-1.amazonaws.com/labels.pdf',downloadType:'URL'}]})}
      if(url.hostname==='fixture.s3.us-east-1.amazonaws.com')return new Response(nativeBytes)
      throw Error('Unexpected network '+url.hostname)
    },
  }),
)
const digest = (v) => createHash('sha256').update(v).digest('hex')
try {
  const db = await mf.getD1Database('DB')
  for (const name of readdirSync('migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    for (const sql of splitSQL(readFileSync('migrations/' + name, 'utf8'))) await db.prepare(sql).run()
  const archive=await mf.getR2Bucket('ARCHIVE')
  await archive.put('product-labels/eu-rep-ceramic-80mm-v1.pdf', await templatePdf.save())
  await db.prepare("INSERT INTO title_audit_store(singleton,seller) VALUES(1,'FIXTURE')").run()
  await db
    .prepare(
      "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('local','local','admin','','')",
    )
    .run()
  const cookie = 'a'.repeat(64),
    token = 'b'.repeat(64)
  await db
    .prepare('INSERT INTO account_sessions VALUES(?,?,1,?)')
    .bind(digest(cookie), 'local', Math.floor(Date.now() / 1000) + 3600)
    .run()
  await db
    .prepare('INSERT INTO inventory_devices(id,token_hash,name,scope_json,paired_at) VALUES(?,?,?,?,?)')
    .bind(
      'c'.repeat(64),
      digest(token),
      'isolated',
      JSON.stringify({
        sellerAccountId: 'FIXTURE',
        marketplaceId: 'ATVPDKIKX0DER',
        warehouseCode: 'A1C5',
      }),
      Date.now(),
    )
    .run()
  async function api(path, body, auth = 'device') {
    return mf.dispatchFetch('http://127.0.0.1/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1',
        ...(auth === 'device'
          ? { Authorization: 'Bearer ' + token }
          : auth === 'session'
            ? { Cookie: 'workbench_dev_session=' + cookie }
            : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function good(path, body, auth) {
    const r = await api(path, body, auth)
    assert.equal(r.status, 200, await r.clone().text())
    return r.json()
  }
  const template = new ExcelJS.Workbook()
  template.addWorksheet('Details')
  template.addWorksheet('Raw')
  const file = {
    name: 'template.xlsx',
    base64: Buffer.from(await template.xlsx.writeBuffer()).toString('base64'),
  }
  await good(
    '/order-sorting/config',
    { revision: 0, rows: [], attributeFile: file, templateFile: file },
    'session',
  )
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Order List')
  sheet.getCell('A1').value = 'Transshipment Order List'
  sheet.getCell('A2').value = 'Orders: 1, SKUs: 1, Units: 2'
  sheet.getCell('A3').value = 'Warehouse: A1C5'
  sheet.getCell('A4').value = 'Shipout: 2026-11-17 16:00 CST'
  sheet.getRow(6).values = ['Product title', 'SKU', 'FNSKU', 'Transfer Id', 'Units']
  sheet.getRow(7).values = ['Mug', 'HUAB-JIT-1', 'X005EVJ3LD', 'TR1', 2]
  const input = {
    requestId: crypto.randomUUID(),
    filename: 'transshipment-order-list-2026-11-17.xlsx',
    warehouse: 'A1C5',
    base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64'),
  }
  const previewInput={revision:1,order:{date:'2026-11-17',rows:[['Ceramic','HUCTCGJ-JIT-00079','X005EC8JYT','TEST79',2],['Ceramic','HUCTCGJ-JIT-00058','X005EC4Z9R','TEST58',1]]}}
  assert.equal((await api('/order-sorting/picking-preview',previewInput,'none')).status,401)
  const previewResponse=await api('/order-sorting/picking-preview',previewInput,'session')
  assert.equal(previewResponse.status,200,await previewResponse.clone().text())
  const pickingBytes=Buffer.from(await previewResponse.arrayBuffer()),picking=new ExcelJS.Workbook()
  await picking.xlsx.load(pickingBytes)
  assert.equal(picking.worksheets[0].getImages().length,2)
  assert.equal(picking.worksheets[0].getCell('H3').value.result,3)
  const repeated=await api('/order-sorting/picking-preview',previewInput,'session')
  assert.deepEqual(Buffer.from(await repeated.arrayBuffer()),pickingBytes)
  assert.equal(imageCalls,2)
  assert.equal((await db.prepare('SELECT count(*) n FROM order_sorting_runs').first()).n,0)
  assert.equal((await api('/inventory-device/pack-orders/import', input, 'none')).status, 401)
  assert.equal((await api('/order-sorting/pack/batches', undefined, 'none')).status, 401)
  const streaming = await api('/inventory-device/pack-orders/import', input)
  assert.equal(streaming.status,200)
  assert.equal(apiLabelFinished,false,'Response headers must arrive before Amazon labels complete')
  const imported = await streaming.json()
  assert.equal(imported.newRows, 1)
  assert.equal(imported.state, 'READY')
  assert.equal(imported.labelSource,'AMAZON_API')
  assert.deepEqual(imported.pickingGroups,[{group:'HUAB',ready:true}])
  assert.equal((await good('/inventory-device/pack-orders/import', input)).id, imported.id)
  assert.equal((await api('/inventory-device/pack-orders/'+imported.id+'/labels',{})).status,409)
  const label1=await api('/order-sorting/pack/'+imported.id+'/group-labels/HUAB',undefined,'session')
  assert.equal(label1.status,200,await label1.clone().text())
  const bytes1=new Uint8Array(await label1.arrayBuffer())
  assert.equal((await PDFDocument.load(bytes1)).getPageCount(),2)
  const label2=await api('/order-sorting/pack/'+imported.id+'/group-labels/HUAB',undefined,'session')
  assert.deepEqual(new Uint8Array(await label2.arrayBuffer()),bytes1)
  assert.equal(apiLabelCalls,1)
  const factory=await api('/order-sorting/pack/'+imported.id+'/group-picking/HUAB',undefined,'session')
  assert.equal(factory.status,200,await factory.clone().text())
  const factoryBytes=Buffer.from(await factory.arrayBuffer()),factoryBook=new ExcelJS.Workbook()
  await factoryBook.xlsx.load(factoryBytes)
  assert.equal(factoryBook.worksheets[0].getImages().length,1)
  const factoryRepeat=await api('/order-sorting/pack/'+imported.id+'/group-picking/HUAB',undefined,'session')
  assert.deepEqual(Buffer.from(await factoryRepeat.arrayBuffer()),factoryBytes)
  assert.equal(imageCalls,3)
  assert.equal(
    (await good('/order-sorting/pack/batches', undefined, 'session')).batches[0].id,
    imported.id,
  )
  assert.equal(
    (await api('/order-sorting/pack/' + imported.id + '/source', undefined, 'session')).status,
    200,
  )
  assert.equal(
    (await api('/order-sorting/pack/' + imported.id + '/labels/0', undefined, 'session')).status,
    409,
  )
  await db.prepare('UPDATE inventory_devices SET revoked_at=?').bind(Date.now()).run()
  assert.equal((await api('/inventory-device/pack-orders/' + imported.id)).status, 401)
  assert.equal((await db.prepare('SELECT enabled FROM inventory_automatic_settings').first()).enabled, 0)
  const evidence = {
    passed: true,
    anonymousRejected: true,
    deviceAuthenticated: true,
    revokedRejected: true,
    sourceAndLabelSessionProtected: true,
    inventoryEnabled: 0,
    state: 'READY',
    apiLabelCalls,source:'AMAZON_API',repeatBytesIdentical:true,
    previewImages:2,previewUnits:3,imageCalls,previewDoesNotCreateOrders:true,
  }
  mkdirSync('.local/pack-backend', { recursive: true })
  writeFileSync('.local/pack-backend/api-result.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  await mf.dispose()
}
