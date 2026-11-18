import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)
const extension = fileURLToPath(new URL('../../extensions/sellerflex-inventory', import.meta.url))

it('persists only the original native XLSX in real extension IndexedDB across browser restart and uploads through its isolated broker', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sf-pack-isolated-'))
  const options = { executablePath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], ignoreDefaultArgs: ['--disable-extensions'] }
  let context = await chromium.launchPersistentContext(profile, options)
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    // This fresh temporary profile has no real user tabs, cookies or device credentials.
    await worker.evaluate(async () => {
      // Deliberately disallowed endpoint makes the production transport fail before any network I/O.
      await (globalThis as any).chrome.storage.local.set({ 'sf-erp-v2': { baseUrl: 'http://127.0.0.1:9', deviceId: 'isolated-device', token: 'isolated-test-token', scope: { sellerAccountId: 'isolated-seller', marketplaceId: 'US', warehouseCode: 'A1C5' } } })
    })
    await context.route('https://htcerp.app/**', route => route.abort())
    const html = `<div role="dialog"><h2>Order List</h2><button id="export">Download order list</button><table><thead><tr><th>Product title</th><th>SKU</th><th>FNSKU</th><th>Transfer Id</th><th>Units</th><th></th></tr></thead><tbody><tr><td>Product</td><td>SKU</td><td>FN</td><td>TR</td><td>2</td><td><button>Download</button></td></tr></tbody></table></div><script>document.querySelector('#export').onclick=()=>{const a=document.createElement('a');a.download='transshipment-order-list-2026-11-16.xlsx';a.href=URL.createObjectURL(new Blob(['PK\\x03\\x04native-source'],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));a.click();URL.revokeObjectURL(a.href)};</script>`
    await context.route('https://sellerflex.amazon.com/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    const page = await context.newPage()
    await page.goto('https://sellerflex.amazon.com/transshipments/pack')
    await page.locator('#sf-pack-sync').click()
    await page.waitForFunction(() => document.querySelector('#sf-pack-status')?.textContent?.includes('本机'), undefined, { timeout: 20000 })
    const before = await worker.evaluate(async () => (globalThis as any).SellerFlexPackOutbox.create().all())
    expect(before).toHaveLength(1)
    expect(before[0].base64).toBe(Buffer.from('PK\x03\x04native-source').toString('base64'))
    expect(before[0].pdfs).toBeUndefined()
    expect(before[0].identity.deviceId).toBe('isolated-device')
    expect(JSON.stringify(before)).not.toContain('isolated-test-token')
    await context.close()
    context = await chromium.launchPersistentContext(profile, options)
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const after = await worker.evaluate(async () => (globalThis as any).SellerFlexPackOutbox.create().all())
    expect(after[0].requestId).toBe(before[0].requestId)
    expect(after[0].base64).toBe(before[0].base64)
    // Use the actual worker broker/outbox with a deterministic local transport, never a live ERP request.
    const uploaded = await worker.evaluate(async () => {
      const outbox = (globalThis as any).SellerFlexPackOutbox.create()
      const record = (await outbox.all())[0]
      const calls: any[] = []
      const state = (await (globalThis as any).chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']
      const broker = (globalThis as any).SellerFlexPackConnector.create({ store: outbox, serial: (fn: any) => fn(), read: async () => state, request: async (_: any, path: string, body: any) => {
        calls.push({ path, body })
        return { id: 'isolated-batch', labelSource: 'AMAZON_API', labelGroups: [], state: 'NO_NEW', totalRows: 1, newRows: 0, skippedRows: 1, conflicts: [], labels: [] }
      } })
      await broker.synchronize()
      return { calls, record: (await outbox.all())[0], original: record.requestId }
    })
    expect(uploaded.calls[0].body.requestId).toBe(before[0].requestId)
    expect(uploaded.record.batch.state).toBe('NO_NEW')
  } finally { await context.close() }
}, 60000)
