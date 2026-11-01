import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const path = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(path) ? path : undefined),
})
const directory = '.local/visual'
mkdirSync(directory, { recursive: true })
const base = 'http://127.0.0.1:8787'
const pages = [
  ['01-discovery', '/'],
  ['02-product', '/products/temu%3AUS%3A606597539559600'],
  ['03-research', '/research'],
  ['04-candidates', '/candidates'],
  ['05-tasks', '/tasks'],
  ['06-settings', '/settings'],
]
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  for (const [name, route] of pages) {
    await page.goto(base + route, { waitUntil: 'domcontentloaded' })
    await page.locator('main h1').first().waitFor()
    if (name === '01-discovery') await page.locator('.products-table tbody tr').first().waitFor()
    await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'))
    await page.evaluate(() =>
      Promise.race([
        Promise.all([...document.images].slice(0, 6).map((i) => i.decode().catch(() => {}))),
        new Promise((done) => setTimeout(done, 2500)),
      ]),
    )
    await page.screenshot({ path: directory + '/' + name + '.png', timeout: 15000 })
    console.log(
      name,
      await page.locator('h1').first().innerText(),
      await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        images: [...document.images].filter((i) => i.naturalWidth > 0).length,
      })),
    )
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('.products-table tbody tr').first().waitFor()
  await page.screenshot({ path: directory + '/07-mobile.png' })
  const timings = []
  for (let i = 0; i < 20; i++) {
    const fresh = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const start = performance.now()
    await fresh.goto(base, { waitUntil: 'domcontentloaded' })
    await fresh.locator('.products-table tbody a').first().waitFor()
    timings.push(performance.now() - start)
    await fresh.close()
  }
  const p95 = timings.sort((a, b) => a - b)[18]
  console.log(
    'Local first actionable catalog, 20 fresh browser contexts; P95 = ' + p95.toFixed(1) + ' ms',
  )
  if (p95 > 3000) throw new Error('首屏可操作时间超过本地验收基线')
  if (errors.length) throw new Error(errors.join('\n'))
} finally {
  await browser.close()
}
