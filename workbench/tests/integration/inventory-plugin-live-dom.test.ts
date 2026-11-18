import { existsSync, readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)

it('matches actual duplicate-header tables and role-button filename; refuses partial success and duplicate rows', async () => {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<main></main>' }),
    )
    await page.goto('https://sellerflex.amazon.com/receive')
    await page.evaluate(() => {
      const header =
        '<thead><tr><th>Time</th><th>Uploaded file</th><th>Status</th><th>Errors<button>Refresh</button></th></tr></thead>'
      document.querySelector('main')!.innerHTML =
        `<table>${header}</table><table>${header}<tbody><tr><td>Now</td><td><span><a role="button">receive-j1.csv</a></span></td><td><span><div><span>Completed</span></div></span></td><td><div>0</div><button>Download</button></td></tr></tbody></table>`
      ;(window as any).chrome = {
        runtime: { sendMessage: async () => ({ ok: true, value: { job: null } }) },
      }
    })
    await page.addScriptTag({
      content: readFileSync(
        new URL('../../extensions/sellerflex-inventory/live-content.js', import.meta.url),
        'utf8',
      ),
    })
    const result = () =>
      page.evaluate(() => (window as any).SellerFlexLiveDOM.resultFor('receive-j1.csv'))
    expect(await result()).toMatchObject({ status: 'COMPLETED', errorCount: 0 })
    await page.evaluate(() => {
      document.querySelectorAll('tbody tr td')[3].innerHTML = '<div>None</div>'
    })
    expect(await result()).toMatchObject({ status: 'COMPLETED', errorCount: 0 })
    await page.evaluate(() => {
      document.querySelectorAll('tbody tr td')[3].innerHTML = '<div>1</div><button>Download</button>'
    })
    expect(await result()).toMatchObject({ status: 'UNKNOWN', errorCount: 1 })
    await page.evaluate(() => {
      const row = document.querySelector('tbody tr')!
      row.parentNode!.append(row.cloneNode(true))
    })
    expect(await result()).toMatchObject({ status: 'UNKNOWN', errorCount: null })
  } finally {
    await browser.close()
  }
}, 20000)

it('dispatches a stable file once and reports its actual table result; reconciliation never changes the file again', async () => {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<nav><button><span role="combobox">A1C5</span></button></nav><main><div data-testid="bulk-upload-actions-row"><input type="file" accept=".csv"><button>Upload inventory file</button></div><table><thead><tr><th>Time</th><th>Uploaded file</th><th>Status</th><th>Errors<button>Refresh</button></th></tr></thead><tbody></tbody></table></main>',
      }),
    )
    await page.goto('https://sellerflex.amazon.com/receive')
    await page.evaluate(() => {
      const state: any = { calls: [], changes: 0, prepared: false, manualBusy: true }
      ;(window as any).trialTest = state
      const job = {
        id: 'j1',
        leaseId: 'lease1',
        mode: 'REAL_TRIAL',
        filename: 'receive-j1.csv',
        sha256: 'a'.repeat(64),
        warehouseCode: 'A1C5',
        rows: [{ sku: 's1' }],
      }
      ;(window as any).chrome = {
        runtime: {
          sendMessage: async (message: any) => {
            state.calls.push(message)
            if (message.operation === 'poll')
              return { ok: true, value: { job, needsReconciliation: state.prepared } }
            if (message.operation === 'prepare') {
              state.prepared = true
              return {
                ok: true,
                value: { job: { ...job, csv: 'fresh,csv\r\n' }, needsReconciliation: false },
              }
            }
            return { ok: true, value: { accepted: true } }
          },
        },
      }
      ;(window as any).SellerFlexManualGuard = { isBusy: () => state.manualBusy, setLiveBusy: () => {} }
      document.querySelector('input')!.addEventListener('change', () => {
        state.changes++
        state.filename = document.querySelector('input')!.files![0].name
        document.querySelector('tbody')!.innerHTML =
          '<tr><td>Now</td><td><a role="button">receive-j1.csv</a></td><td>Completed</td><td>0</td></tr>'
      })
      const original = window.setTimeout
      window.setTimeout = ((handler: TimerHandler) => original(handler, 30)) as typeof setTimeout
    })
    await page.addScriptTag({
      content: readFileSync(
        new URL('../../extensions/sellerflex-inventory/live-content.js', import.meta.url),
        'utf8',
      ),
    })
    expect(await page.evaluate(() => (window as any).trialTest.calls)).toEqual([])
    await page.evaluate(() => {
      ;(window as any).trialTest.manualBusy = false
    })
    await page.waitForFunction(
      () => (window as any).trialTest.calls.filter((c: any) => c.operation === 'results').length >= 2,
    )
    const state = await page.evaluate(() => (window as any).trialTest)
    expect(state.changes).toBe(1)
    expect(state.filename).toBe('receive-j1.csv')
    expect(state.calls.filter((c: any) => c.operation === 'prepare')).toHaveLength(1)
    expect(state.calls.find((c: any) => c.operation === 'results').input).toMatchObject({
      status: 'COMPLETED',
      errorCount: 0,
      filename: 'receive-j1.csv',
    })
  } finally {
    await browser.close()
  }
}, 20000)

it('automatic UNKNOWN durable receipt clears only its owned file and schedules the next batch', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://sellerflex.amazon.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<nav><button><span role="combobox">A1C5</span></button></nav><main><div><input type="file"><button>Upload inventory file</button></div><table><thead><tr><th>Uploaded file</th><th>Status</th><th>Errors</th></tr></thead><tbody></tbody></table></main>',
      }),
    )
    await page.goto('https://sellerflex.amazon.com/receive')
    await page.evaluate(() => {
      const state: any = { calls: [], changes: 0, next: 1, cleanupProof: null, delays: [] }
      ;(window as any).automaticTest = state
      const job = () => ({
        id: `auto${state.next}`,
        leaseId: `lease${state.next}`,
        mode: 'AUTO_REPLENISH',
        filename: `receive-auto${state.next}.csv`,
        sha256: 'a'.repeat(64),
        warehouseCode: 'A1C5',
      })
      ;(window as any).chrome = {
        runtime: {
          sendMessage: async (message: any) => {
            state.calls.push(message)
            if (message.operation === 'poll')
              return {
                ok: true,
                value: { job: state.next <= 2 ? job() : null, cleanupProof: state.cleanupProof },
              }
            if (message.operation === 'prepare') {
              const csv = 'fresh,csv\r\n'
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csv))
              const sha256 = Array.from(new Uint8Array(digest), (n) =>
                n.toString(16).padStart(2, '0'),
              ).join('')
              const ownedFile = {
                filename: job().filename,
                sha256,
                size: csv.length,
                lastModified: Date.now(),
                owner: 'tab:1:document:one',
              }
              state.ownedFile = ownedFile
              return { ok: true, value: { job: { ...job(), sha256, csv }, ownedFile } }
            }
            if (message.operation === 'results') {
              state.cleanupProof = {
                receipt: {
                  id: job().id,
                  leaseId: job().leaseId,
                  eventId: 'event1',
                  state: 'RECORDED',
                  submitted: true,
                },
                ownedFile: state.ownedFile,
              }
              state.next++
              return { ok: true, value: { accepted: true, cleanupProof: state.cleanupProof } }
            }
            return { ok: true, value: {} }
          },
        },
      }
      document.querySelector('input')!.addEventListener('change', () => {
        state.changes++
        document.querySelector('tbody')!.innerHTML =
          `<tr><td>${document.querySelector('input')!.files![0].name}</td><td>Completed</td><td>1</td></tr>`
      })
      const original = window.setTimeout
      window.setTimeout = ((handler: TimerHandler, delay?: number) => {
        state.delays.push(delay)
        return original(handler, Math.min(delay || 0, 25))
      }) as typeof setTimeout
    })
    await page.addScriptTag({
      content: readFileSync(
        new URL('../../extensions/sellerflex-inventory/live-content.js', import.meta.url),
        'utf8',
      ),
    })
    await page.waitForFunction(() => (window as any).automaticTest.next === 3)
    const state = await page.evaluate(() => ({
      ...(window as any).automaticTest,
      files: document.querySelector('input')!.files!.length,
    }))
    expect(state.changes).toBe(2)
    expect(state.files).toBe(0)
    expect(
      state.calls
        .filter((c: any) => c.operation === 'results')
        .every((c: any) => c.input.status === 'UNKNOWN'),
    ).toBe(true)
    expect(state.delays).toContain(5000)
  } finally {
    await browser.close()
  }
}, 20000)

it('restored exact receipt clears a previous owned file but preserves a same-name user replacement', async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    for (const replacement of [false, true]) {
      const page = await browser.newPage()
      await page.route('https://sellerflex.amazon.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<nav><button><span role="combobox">A1C5</span></button></nav><main><div><input type="file"><button>Upload inventory file</button></div><table><thead><tr><th>Uploaded file</th><th>Status</th><th>Errors</th></tr></thead><tbody></tbody></table></main>',
        }),
      )
      await page.goto('https://sellerflex.amazon.com/receive')
      await page.evaluate(async (replacement) => {
        const csv = 'previous,csv\r\n'
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csv))),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('')
        const filename = 'receive-previous.csv',
          lastModified = Date.now() - 30000
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([replacement ? 'user-new,csv\r\n' : csv], filename, { lastModified }),
        )
        document.querySelector('input')!.files = transfer.files
        ;(window as any).calls = []
        ;(window as any).chrome = {
          runtime: {
            sendMessage: async (message: any) => {
              ;(window as any).calls.push(message)
              return {
                ok: true,
                value: {
                  job: null,
                  cleanupProof: {
                    receipt: {
                      id: 'previous',
                      leaseId: 'lease0',
                      eventId: 'event0',
                      state: 'RECORDED',
                      submitted: true,
                    },
                    ownedFile: {
                      filename,
                      sha256,
                      size: csv.length,
                      lastModified,
                      owner: 'tab:1:document:old',
                    },
                  },
                },
              }
            },
          },
        }
      }, replacement)
      await page.addScriptTag({
        content: readFileSync(
          new URL('../../extensions/sellerflex-inventory/live-content.js', import.meta.url),
          'utf8',
        ),
      })
      await page.waitForFunction(() => (window as any).calls.length > 0)
      await expect
        .poll(() => page.locator('input').evaluate((input: HTMLInputElement) => input.files!.length))
        .toBe(replacement ? 1 : 0)
      await page.close()
    }
  } finally {
    await browser.close()
  }
}, 20000)
