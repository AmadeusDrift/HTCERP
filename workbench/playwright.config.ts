import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  outputDir: '.local/e2e-results',
  use: {
    baseURL: 'http://127.0.0.1:8788',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined),
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/setup-local.mjs && node scripts/dev.mjs',
    env: { WORKBENCH_E2E: '1' },
    url: 'http://127.0.0.1:8788/api/session',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
