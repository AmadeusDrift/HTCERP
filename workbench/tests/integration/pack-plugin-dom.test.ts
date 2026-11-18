import { existsSync, readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)
const dir = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const script = (name: string) => readFileSync(new URL(name, dir), 'utf8')
const html = `<nav>A1C5</nav><button>Download &amp; print all transshipments</button><div role="dialog"><h2>Order List</h2><button id="xlsx">Download order list</button><button id="all">Download FNSKU labels</button><table><thead><tr><th>Product title</th><th>SKU</th><th>FNSKU</th><th>Transfer Id</th><th>Units</th><th></th></tr></thead><tbody><tr><td>Product</td><td>SKU</td><td>FN</td><td>TR</td><td>2</td><td><button>Print</button><button id="row">Download</button></td></tr></tbody></table></div>`

it('captures only XLSX blobs and refuses to arm or capture native PDFs', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.addScriptTag({ content: script('pack-export-main.js') })
    const messages = await page.evaluate(async () => {
      const messages: any[] = []
      addEventListener('message', event => { if (event.data?.channel === 'sf-pack-export-v1') messages.push(event.data) })
      const pause = () => new Promise(resolve => setTimeout(resolve, 40))
      const download = (filename: string, bytes: string, type: string) => {
        const a = document.createElement('a'); a.download = filename; a.href = URL.createObjectURL(new Blob([bytes], { type }))
        a.addEventListener('click', event => event.preventDefault()); a.dispatchEvent(new MouseEvent('click', { cancelable: true })); URL.revokeObjectURL(a.href)
      }
      window.postMessage({ channel: 'sf-pack-export-v1', type: 'arm', kind: 'pdf', filename: 'fnsku-labels-FN.pdf', nonce: 'a'.repeat(32) }, location.origin)
      await pause()
      download('fnsku-labels-FN.pdf', '%PDF-secret', 'application/pdf')
      await pause()
      window.postMessage({ channel: 'sf-pack-export-v1', type: 'arm', kind: 'xlsx', nonce: 'b'.repeat(32) }, location.origin)
      await pause()
      download('fnsku-labels-FN.pdf', '%PDF-secret', 'application/pdf')
      download('unrelated.xlsx', 'PK\x03\x04private', 'application/octet-stream')
      download('transshipment-order-list-2026-11-17.xlsx', 'bad', 'application/octet-stream')
      download('transshipment-order-list-2026-11-17.xlsx', 'PK\x03\x04native', 'application/octet-stream')
      await pause()
      return messages
    })
    expect(messages.filter(message => message.type === 'armed').map(message => message.nonce)).toEqual(['b'.repeat(32)])
    expect(messages.filter(message => message.type === 'file')).toEqual([{ channel: 'sf-pack-export-v1', type: 'file', nonce: 'b'.repeat(32), kind: 'xlsx', filename: 'transshipment-order-list-2026-11-17.xlsx', base64: Buffer.from('PK\x03\x04native').toString('base64') }])
  } finally { await browser.close() }
}, 20000)

it('uploads native XLSX only, shows ERP API pending/ready states, and rejects legacy ERP without any PDF fallback', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.evaluate(() => {
      const test = { clicks: [] as string[], messages: [] as any[], mode: 'new', stale: false }; (window as any).packTest = test
      const batch = { id: 'b1', totalRows: 1, newRows: 1, skippedRows: 0, conflicts: [], labels: [{ rowIndex: 0, sku: 'SKU', fnsku: 'FN', transferId: 'TR', units: 2, received: false }], state: 'LABELS_PENDING', labelSource: 'AMAZON_API', labelGroups: [{ group: 'Group', ready: false }] }
      ;(window as any).chrome = { runtime: { sendMessage: async (message: any) => {
        test.messages.push(message)
        if (message.operation === 'resume' && test.mode === 'new') return { ok: true, value: null }
        if (test.stale) document.querySelector('tbody td:nth-child(5)')!.textContent = '3'
        const returned: any = structuredClone(batch)
        if (test.mode === 'legacy') { delete returned.labelSource; returned.state = 'READY'; returned.labels[0].received = true }
        if (test.mode === 'ready') { returned.state = 'READY'; returned.labelGroups[0].ready = true }
        return { ok: true, value: { requestId: 'source', batch: returned } }
      } } }
      document.addEventListener('click', event => {
        const button = (event.target as Element).closest('button'); if (!button || button.id.startsWith('sf-')) return
        test.clicks.push(button.textContent || '')
        const xlsx = button.id === 'xlsx'
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([xlsx ? 'PK\x03\x04sample' : '%PDF-sample'], { type: xlsx ? 'application/octet-stream' : 'application/pdf' })); a.download = xlsx ? 'transshipment-order-list-2026-11-17.xlsx' : 'fnsku-labels-FN.pdf'; a.click(); URL.revokeObjectURL(a.href)
      })
    })
    await page.addScriptTag({ content: script('pack-export-main.js') })
    await page.addScriptTag({ content: script('pack-content.js') })
    const sync = async () => { await page.locator('#sf-pack-sync').click(); await page.waitForFunction(() => !(document.querySelector('#sf-pack-sync') as HTMLButtonElement).disabled) }
    await sync()
    expect(await page.evaluate(() => (window as any).packTest.clicks)).toEqual(['Download order list'])
    expect(await page.evaluate(() => (window as any).packTest.messages.map((message: any) => message.operation))).toEqual(['resume', 'enqueue'])
    expect(await page.locator('#sf-pack-status').innerText()).toContain('自动重试')
    expect(await page.locator('#sf-pack-status a').getAttribute('href')).toBe('https://htcerp.app/order-sorting?packBatch=b1')
    await page.evaluate(() => { (window as any).packTest.mode = 'ready' })
    await sync()
    expect(await page.locator('#sf-pack-status').innerText()).toContain('上欧代、下 SKU')
    await page.evaluate(() => { (window as any).packTest.mode = 'legacy' })
    await sync()
    expect(await page.locator('#sf-pack-status').innerText()).toContain('升级 ERP')
    expect(await page.evaluate(() => (window as any).packTest.clicks)).toEqual(['Download order list'])
    expect(await page.evaluate(() => (window as any).packTest.messages.some((message: any) => message.operation === 'label'))).toBe(false)
    await page.evaluate(() => { (window as any).packTest.stale = true })
    await sync()
    expect(await page.locator('#sf-pack-status').innerText()).toContain('变化')
  } finally { await browser.close() }
}, 20000)
