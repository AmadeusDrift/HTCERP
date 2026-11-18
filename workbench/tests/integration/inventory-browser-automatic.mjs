import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

// Actual MV3 worker and UI, exclusively isolated local APIs and temporary profiles.
export async function browserAutomatic({ api, db, admin, stocks }) {
  const extension = resolve('extensions/sellerflex-inventory')
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const profile = mkdtempSync(resolve('.local/inventory-automatic-browser-'))
  const contexts = new Set(),
    uploads = []
  let lose = true,
    lostResolve
  const lost = new Promise((resolve) => {
    lostResolve = resolve
  })
  async function launch() {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined),
      args: [
        '--disable-background-networking',
        '--disable-extensions-except=' + extension,
        '--load-extension=' + extension,
      ],
    })
    contexts.add(context)
    await context.exposeBinding('recordUpload', (_source, file) => {
      assert.ok(!uploads.some((old) => old.name === file.name), 'a file must never be uploaded twice')
      uploads.push(file)
    })
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url())
      if (url.origin === 'https://htcerp.app' && url.pathname.startsWith('/api/')) {
        const response = await api.fetch(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          ...(request.postData() === null ? {} : { body: request.postData() }),
        })
        if (lose && url.pathname.endsWith('/automatic/results') && response.status === 200) {
          lose = false
          await route.abort('failed')
          lostResolve()
          return
        }
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
        return
      }
      if (url.origin === 'https://htcerp.app') {
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body>Isolated automatic ERP fixture</body></html>',
        })
        return
      }
      if (url.origin === 'https://sellerflex.amazon.com' && url.pathname === '/receive') {
        const rows = uploads
          .map(
            (file, index) =>
              `<tr><td>Now</td><td><a role="button">${file.name}</a></td><td>Completed</td><td>${index === 0 ? 1 : 0}</td></tr>`,
          )
          .join('')
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><nav><button><span role="combobox">A1C5</span></button></nav><main><div data-testid="bulk-upload-actions-row"><input type="file" accept=".csv"><button>Upload inventory file</button></div><table><thead><tr><th>Time</th><th>Uploaded file</th><th>Status</th><th>Errors<button>Refresh</button></th></tr></thead><tbody>${rows}</tbody></table></main><script>let count=${uploads.length};document.querySelector('input').addEventListener('change',async()=>{const file=document.querySelector('input').files[0];if(!file)return;await window.recordUpload({name:file.name,text:await file.text()});document.querySelector('tbody').innerHTML+='<tr><td>Now</td><td><a role="button">'+file.name+'</a></td><td>Completed</td><td>'+(count++===0?1:0)+'</td></tr>'})</script></body></html>`,
        })
        return
      }
      if (url.protocol === 'chrome-extension:') return route.continue()
      await route.abort('blockedbyclient')
    })
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    return { context, worker, origin: 'chrome-extension://' + new URL(worker.url()).hostname }
  }
  try {
    // Start a fresh local administrator rate window for this independent scenario.
    await db.prepare('UPDATE write_limits SET window=window-1').run()
    await db.prepare("UPDATE inventory_replenishment_jobs SET lease_until=0 WHERE state='CLAIMED'").run()
    const browser = await launch()
    const erp = await browser.context.newPage()
    await erp.goto('https://htcerp.app/settings?tab=inventory')
    assert.equal(
      await erp.evaluate(
        async () =>
          (
            await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: 'fixture-admin', password: 'isolated-fixture-password' }),
            })
          ).status,
      ),
      200,
    )
    const popup = await browser.context.newPage()
    await popup.goto(browser.origin + '/connection.html')
    await popup.waitForFunction(
      () => document.querySelector('#erp-session')?.textContent.includes('已检测到'),
      null,
      { timeout: 15000 },
    )
    await popup.locator('#device-name').fill('Automatic browser fixture')
    await popup.locator('#connect-erp').click()
    await popup.waitForFunction(
      () => document.querySelector('#details')?.textContent.includes('已配对'),
      null,
      { timeout: 15000 },
    )
    const deviceId = await browser.worker.evaluate(
      async () => (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2'].deviceId,
    )
    const current = await admin('')
    await admin('/executor', {
      requestId: crypto.randomUUID(),
      deviceId,
      expectedExecutorId: current.executor.deviceId,
      expectedVersion: current.executor.version,
      expectedTrialId: current.activeTrialId,
    })
    await admin('/automatic/settings', { enabled: true, intervalMinutes: 60, startFrom: 'NEXT_PATROL' })
    assert.equal((await admin('/automatic/plan', {})).skippedBeforeActivation, true)
    const receive = await browser.context.newPage()
    await receive.goto('https://sellerflex.amazon.com/receive')
    await delay(500)
    assert.equal(uploads.length, 0)
    const previous = await db
      .prepare('SELECT * FROM inventory_source_runs ORDER BY started_at DESC LIMIT 1')
      .first()
    const generation = 'fixture-next-browser-patrol',
      started = Date.now()
    await db
      .prepare(
        "INSERT INTO inventory_source_runs(id,seller,started_at,activated_at,order_from,order_through,state,finished_at,connection_revision,inventory_status,listings_status,orders_status) VALUES(?,'SELLER1',?,?,?,?,'COMPLETE',?,?,'COMPLETE','COMPLETE','COMPLETE')",
      )
      .bind(
        generation,
        started,
        previous.activated_at,
        started - 86400000,
        started,
        started,
        previous.connection_revision,
      )
      .run()
    for (let n = 0; n < 22; n++) {
      const sku = `AUTO-BROWSER-${String(n).padStart(3, '0')}-JIT`
      stocks.set(sku, n === 1 ? 0 : 3)
      await db
        .prepare(
          "INSERT INTO inventory_source_rows(generation,sku,channel,sellable,listing_status,ordered,new_listing) VALUES(?,?,'JIT',?,'unknown',?,?)",
        )
        .bind(generation, sku, n === 1 ? 0 : 3, n === 1 ? null : 1, n === 1 ? 1 : 0)
        .run()
    }
    await db
      .prepare("UPDATE inventory_source_current SET generation=?,published_at=? WHERE seller='SELLER1'")
      .bind(generation, started)
      .run()
    await admin('/automatic/plan', {})
    await receive.reload()
    await Promise.race([
      lost,
      delay(45000).then(() => {
        throw Error('first automatic receipt not observed')
      }),
    ])
    assert.equal(uploads.length, 1)
    const before = await browser.worker.evaluate(async () => {
      const s = (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']
      return { pending: s.live?.pending?.eventId, mode: s.live?.job?.mode }
    })
    assert.equal(before.mode, 'AUTO_REPLENISH')
    assert.ok(before.pending)
    await browser.context.close()
    contexts.delete(browser.context)
    const restarted = await launch(),
      page = await restarted.context.newPage()
    await page.goto('https://sellerflex.amazon.com/receive')
    const deadline = Date.now() + 90000
    while (uploads.length < 3 && Date.now() < deadline) await delay(250)
    assert.equal(uploads.length, 3, 'restarted automatic worker must progress across batches')
    await page.waitForFunction(
      () => document.querySelector('input[type=file]').files.length === 0,
      null,
      { timeout: 15000 },
    )
    const rowCounts = uploads.map(
      (file) =>
        file.text
          .replace(/^\uFEFF/, '')
          .trim()
          .split(/\r?\n/).length - 1,
    )
    assert.deepEqual(rowCounts, [10, 10, 2])
    assert.equal(new Set(uploads.map((file) => file.name)).size, 3)
    await admin('/automatic/settings', { enabled: false, intervalMinutes: 60 })
    return {
      passed: true,
      realAmazonWrites: 0,
      uploadedFiles: 3,
      rows: 22,
      batches: rowCounts,
      skippedCurrentGeneration: true,
      lostAcknowledgementRestart: true,
      unknownDidNotBlockOtherSkus: true,
      ownInputCleared: true,
    }
  } finally {
    for (const context of contexts) await context.close()
  }
}
