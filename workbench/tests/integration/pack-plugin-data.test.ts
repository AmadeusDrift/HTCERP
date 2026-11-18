import { existsSync, readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)
const dir = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const html = '<div role="dialog"><h2>Order List</h2><button>Download order list</button><table><thead><tr><th>Product title</th><th>SKU</th><th>FNSKU</th><th>Transfer Id</th><th>Units</th></tr></thead><tbody><tr><td>Product</td><td>SKU</td><td>FN</td><td>TR</td><td>2</td></tr></tbody></table></div>'

it('accepts only armed inline XLSX, rejects PDF base64 with exact file guards, strict MIME/magic/size, and honors cancellation without fetching', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    const logs: string[] = []
    page.on('console', message => { if (message.text().startsWith('[sf-pack]')) logs.push(message.text()) })
    await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.addScriptTag({ content: readFileSync(new URL('pack-export-main.js', dir), 'utf8') })
    const result = await page.evaluate(async () => {
      const messages: any[] = []; let fetches = 0
      window.fetch = (async () => { fetches++; throw new Error('unexpected fetch') }) as typeof fetch
      addEventListener('message', event => { if (event.data?.channel === 'sf-pack-export-v1') messages.push(event.data) })
      const pause = () => new Promise(resolve => setTimeout(resolve, 30))
      const arm = async (nonce: string, kind: string) => { window.postMessage({ channel: 'sf-pack-export-v1', type: 'arm', nonce: nonce.repeat(32), kind, filename: 'fnsku-labels-FN.pdf' }, location.origin); await pause() }
      const download = (href: string, filename: string) => { const a = document.createElement('a'); a.href = href; a.download = filename; a.addEventListener('click', event => event.preventDefault()); a.dispatchEvent(new MouseEvent('click', { cancelable: true })) }
      const xlsxName = 'transshipment-order-list-2026-11-17.xlsx'
      const xlsxUrl = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + btoa('PK\x03\x04INLINE-XLSX')
      const pdfUrl = 'data:application/pdf;charset=UTF-8;base64,' + btoa('%PDF-INLINE-PDF')
      download(xlsxUrl, xlsxName)
      await arm('a', 'xlsx')
      download('https://example.invalid/private.xlsx', xlsxName)
      download('javascript:void(0)', xlsxName)
      download('data:text/plain;base64,' + btoa('PK\x03\x04wrong-mime'), xlsxName)
      download('data:application/octet-stream;base64,' + btoa('%PDF-wrong-magic'), xlsxName)
      download(xlsxUrl, 'unrelated.xlsx')
      download(xlsxUrl, xlsxName)
      await pause()
      await arm('b', 'pdf')
      download(pdfUrl, 'fnsku-labels-OTHER.pdf')
      download(pdfUrl, 'fnsku-labels-2026-11-17.pdf')
      download('data:application/pdf;base64,JVBERi1x===', 'fnsku-labels-FN.pdf')
      download('data:application/pdf;base64,JVBERi1YIR==', 'fnsku-labels-FN.pdf')
      download('data:application/pdf;base64,%25PDF-', 'fnsku-labels-FN.pdf')
      download('data:application/pdf,' + encodeURIComponent('%PDF-not-base64'), 'fnsku-labels-FN.pdf')
      download('data:application/octet-stream;base64,' + btoa('%PDF-wrong-mime'), 'fnsku-labels-FN.pdf')
      download('data:application/pdf;base64,' + btoa('PK\x03\x04wrong-magic'), 'fnsku-labels-FN.pdf')
      download(pdfUrl, 'fnsku-labels-FN.pdf')
      await pause()
      await arm('c', 'xlsx')
      download('data:application/octet-stream;base64,' + 'A'.repeat(16_000_004), xlsxName)
      await pause()
      await arm('d', 'xlsx')
      window.postMessage({ channel: 'sf-pack-export-v1', type: 'cancel', nonce: 'd'.repeat(32), dispatched: true }, location.origin)
      await pause()
      download(pdfUrl, 'fnsku-labels-FN.pdf')
      await arm('e', 'xlsx')
      history.pushState({}, '', '/receive')
      download(pdfUrl, 'fnsku-labels-FN.pdf')
      await pause()
      return { messages, fetches }
    })
    const files = result.messages.filter(message => message.type === 'file')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ kind: 'xlsx', filename: 'transshipment-order-list-2026-11-17.xlsx', base64: Buffer.from('PK\x03\x04INLINE-XLSX').toString('base64') })
    expect(result.messages.find(message => message.type === 'error' && message.nonce === 'c'.repeat(32))).toMatchObject({ code: 'too-large' })
    expect(result.messages.find(message => message.type === 'error' && message.nonce === 'e'.repeat(32))).toMatchObject({ code: 'reload-required' })
    expect(result.fetches).toBe(0)
    expect(logs.join('\n')).not.toContain('data:application')
    expect(logs.join('\n')).not.toContain('INLINE-XLSX')
    expect(logs.join('\n')).not.toContain(Buffer.from('%PDF-INLINE-PDF').toString('base64'))
  } finally { await browser.close() }
}, 20000)

it('shows a refresh instruction if the extension runtime disappeared after reload', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.evaluate(() => { (window as any).chrome = {} })
    await page.addScriptTag({ content: readFileSync(new URL('pack-content.js', dir), 'utf8') })
    await page.locator('#sf-pack-sync').click()
    expect(await page.locator('#sf-pack-status').innerText()).toContain('刷新')
    expect(await page.locator('#sf-pack-status').innerText()).not.toContain('TypeError')
  } finally { await browser.close() }
}, 20000)

it('keeps an inline native anchor click inside its armed operation and never invokes the row label export', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    const nativeAnchor = '<a role="button" download="transshipment-order-list-2026-11-17.xlsx" href="data:application/octet-stream;base64,' + Buffer.from('PK\x03\x04inline').toString('base64') + '">Download order list</a>'
    const body = html.replace('<button>Download order list</button>', nativeAnchor).replace('<td>2</td>', '<td>2</td><td><button id="row">Download</button></td>')
    await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({ body, contentType: 'text/html' }))
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.evaluate(() => {
      const calls: any[] = []; (window as any).inlineCalls = calls
      ;(window as any).chrome = { runtime: { sendMessage: async (message: any) => {
        calls.push(message)
        if (message.operation === 'resume') return { ok: true, value: null }
        return { ok: true, value: { requestId: 'inline', storedRows: [], batch: { id: 'inline', labelSource: 'AMAZON_API', labelGroups: [{ group: 'Group', ready: false }], state: 'LABELS_PENDING', totalRows: 1, newRows: 1, skippedRows: 0, conflicts: [], labels: [{ rowIndex: 0, sku: 'SKU', fnsku: 'FN', transferId: 'TR', units: 2, received: message.operation === 'label' }] } } }
      } } }
      document.querySelector('a')!.addEventListener('click', event => event.preventDefault())
      document.querySelector('#row')!.addEventListener('click', () => {
        const a = document.createElement('a'); a.download = 'fnsku-labels-FN.pdf'; a.href = 'data:application/pdf;base64,' + btoa('%PDF-inline-row'); a.addEventListener('click', event => event.preventDefault()); a.click()
      })
    })
    await page.addScriptTag({ content: readFileSync(new URL('pack-export-main.js', dir), 'utf8') })
    await page.addScriptTag({ content: readFileSync(new URL('pack-content.js', dir), 'utf8') })
    await page.locator('#sf-pack-sync').click()
    await page.waitForFunction(() => !(document.querySelector('#sf-pack-sync') as HTMLButtonElement).disabled)
    expect(await page.evaluate(() => (window as any).inlineCalls.map((call: any) => call.operation))).toEqual(['resume', 'enqueue'])
  } finally { await browser.close() }
}, 20000)
