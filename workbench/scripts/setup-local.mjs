import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { acquireLocalState, stateDir, testing } from './local-state.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
mkdirSync('.local', { recursive: true })
acquireLocalState()
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  WRANGLER_SEND_METRICS: 'false',
}
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Wrangler owns the file layout. Only choose a migrated local application DB.
run(process.execPath, [
  cli,
  'd1',
  'migrations',
  'apply',
  'DB',
  '--local',
  '-c',
  'wrangler.jobs.jsonc',
  '--persist-to',
  stateDir,
])
const dir = resolve(stateDir, 'v3/d1')
const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile() && f.name.endsWith('.sqlite'))
  .map((f) => join(f.parentPath, f.name))
const targets = paths.filter((path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").get(),
    )
  } finally {
    db.close()
  }
})
if (targets.length !== 1) throw new Error('无法唯一识别已迁移的本地 D1 数据库。')
if (existsSync('../probe-output/expanded/responses')) {
  run(process.env.PYTHON ?? 'python', ['scripts/bootstrap.py', '--sqlite', targets[0]])
} else if (testing) {
  throw new Error('端到端测试需要本地私有商品样本 probe-output。')
} else {
  console.log('本地数据库已迁移，从空商品库启动。')
}
