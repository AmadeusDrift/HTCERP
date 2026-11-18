import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

// Actual MV3 extension, separate disk profiles, actual Worker auth and D1. Every
// browser request and every Worker Amazon request is intercepted by local fixtures.
export async function browserHandoff({ api, admin, setSellable }) {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)
  const extension = resolve('extensions/sellerflex-inventory')
  const contexts = new Set()
  const profiles = [0, 1].map(() => mkdtempSync(resolve('.local/inventory-browser-')))
  const uploaded = []
  let loseReceipt = true
  let markLost
  const lost = new Promise((resolve) => {
    markLost = resolve
  })
  async function launch(index) {
    const context = await chromium.launchPersistentContext(profiles[index], {
      executablePath,
      headless: true,
      args: [
        '--disable-background-networking',
        '--disable-extensions-except=' + extension,
        '--load-extension=' + extension,
      ],
    })
    contexts.add(context)
    await context.exposeBinding('recordFixtureUpload', (_source, filename) => {
      uploaded.push(filename)
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
        if (
          index === 0 &&
          loseReceipt &&
          url.pathname.endsWith('/live/results') &&
          response.status === 200
        ) {
          loseReceipt = false
          await route.abort('failed')
          markLost()
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
          body: '<!doctype html><html><body><h1>Isolated ERP login fixture</h1></body></html>',
        })
        return
      }
      if (url.origin === 'https://sellerflex.amazon.com' && url.pathname === '/receive') {
        const rows = uploaded
          .map(
            (name) =>
              `<tr><td>Now</td><td><a role="button">${name}</a></td><td>Completed</td><td>0</td></tr>`,
          )
          .join('')
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><nav><button><span role="combobox">A1C5</span></button></nav><main><div data-testid="bulk-upload-actions-row"><input type="file" accept=".csv"><button>Upload inventory file</button></div><table><thead><tr><th>Time</th><th>Uploaded file</th><th>Status</th><th>Errors<button>Refresh</button></th></tr></thead><tbody>${rows}</tbody></table></main><script>document.querySelector('input').addEventListener('change',async()=>{const name=document.querySelector('input').files[0].name;await window.recordFixtureUpload(name);document.querySelector('tbody').innerHTML+='<tr><td>Now</td><td><a role="button">'+name+'</a></td><td>Completed</td><td>0</td></tr>'})</script></body></html>`,
        })
        return
      }
      if (url.protocol === 'chrome-extension:') return route.continue()
      await route.abort('blockedbyclient')
    })
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    return { context, worker, extensionOrigin: 'chrome-extension://' + new URL(worker.url()).hostname }
  }
  async function connect(browser, index) {
    const erp = await browser.context.newPage()
    await erp.goto('https://htcerp.app/settings?tab=inventory')
    const loginStatus = await erp.evaluate(
      async () =>
        (
          await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fixture-admin', password: 'isolated-fixture-password' }),
          })
        ).status,
    )
    assert.equal(loginStatus, 200)
    const popup = await browser.context.newPage()
    await popup.goto(browser.extensionOrigin + '/connection.html')
    await popup.waitForFunction(
      () => document.querySelector('#erp-session')?.textContent.includes('已检测到'),
      null,
      { timeout: 15000 },
    )
    await popup.locator('#device-name').fill('Browser computer ' + index)
    await popup.locator('#connect-erp').click({ timeout: 15000 })
    await popup.waitForFunction(
      () => /已配对/.test(document.querySelector('#details').textContent),
      null,
      { timeout: 15000 },
    )
    const device = await browser.worker.evaluate(async () => {
      const state = (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']
      return {
        deviceId: state.deviceId,
        hasToken: typeof state.token === 'string',
        pendingConnection: Boolean(state.pendingConnection),
      }
    })
    assert.ok(device.hasToken)
    assert.match(device.deviceId, /^[a-f0-9]{64}$/)
    const text = await popup.locator('body').innerText()
    const leaked = await browser.worker.evaluate(async (text) => {
      const state = (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']
      return text.includes(state.token)
    }, text)
    assert.equal(leaked, false, 'popup must not expose credential material')
    await popup.close()
    return device
  }
  async function select(device) {
    const status = await admin('')
    return admin('/executor', {
      requestId: crypto.randomUUID(),
      deviceId: device.deviceId,
      expectedExecutorId: status.executor.deviceId,
      expectedVersion: status.executor.version,
      expectedTrialId: status.activeTrialId,
    })
  }
  async function waitFor(check, description) {
    for (let n = 0; n < 120; n++) {
      if (await check()) return
      await delay(100)
    }
    throw new Error('Timed out: ' + description)
  }
  try {
    const a = await launch(0),
      b = await launch(1)
    const deviceA = await connect(a, 0),
      deviceB = await connect(b, 1)
    assert.notEqual(deviceA.deviceId, deviceB.deviceId)
    await select(deviceA)
    setSellable(3)
    await admin('/live/trial', { skus: ['FIXTURE-JIT'] })
    const sellerA = await a.context.newPage()
    await sellerA.goto('https://sellerflex.amazon.com/receive')
    await Promise.race([
      lost,
      delay(15000).then(() => {
        throw new Error('Expected lost acknowledgement after upload')
      }),
    ])
    await waitFor(
      async () =>
        Boolean(
          await a.worker.evaluate(
            async () => (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']?.live?.pending,
          ),
        ),
      'receipt persisted before network',
    )
    assert.equal(uploaded.length, 1)
    await a.context.close()
    contexts.delete(a.context)
    await select(deviceB)
    const sellerB = await b.context.newPage()
    await sellerB.goto('https://sellerflex.amazon.com/receive')
    await waitFor(
      async () => (await admin('/live/status')).trial.state === 'WAITING_API',
      'transferred API reconciliation',
    )
    setSellable(5)
    await sellerB.reload()
    await waitFor(
      async () => (await admin('/live/status')).trial.state === 'COMPLETE',
      'new computer completes API reconciliation',
    )
    // Restart the old computer from its disk profile. Its unacknowledged old lease
    // must be archived with exact server transfer proof, not replayed as a new job.
    const resumed = await launch(0)
    const oldSeller = await resumed.context.newPage()
    await oldSeller.goto('https://sellerflex.amazon.com/receive')
    await waitFor(
      async () =>
        resumed.worker.evaluate(async () => {
          const value = (await chrome.storage.local.get('sf-erp-v2'))['sf-erp-v2']
          return (
            value?.deviceId &&
            !value.live?.pending &&
            value.archivedLive?.some(
              (entry) =>
                entry.reason === 'TRANSFERRED' && entry.live?.pending && entry.proof?.submitted === true,
            )
          )
        }),
      'old receipt retirement after restart',
    )
    assert.equal(uploaded.length, 1)
    return {
      profiles: 2,
      actualMV3: true,
      uploadedFiles: uploaded.length,
      state: 'COMPLETE',
      realAmazonWrites: 0,
    }
  } finally {
    for (const context of contexts) await context.close()
  }
}
