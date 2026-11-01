import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  acquireLocalState,
  connectionKeyFile,
  devControl,
  port,
  stateDir,
  testing,
} from './local-state.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
if (!existsSync('dist/web/index.html')) {
  console.error('请先执行 pnpm build 和 pnpm db:local。')
  process.exit(1)
}
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
acquireLocalState()
const child = spawn(
  process.execPath,
  [
    cli,
    'dev',
    '-c',
    'wrangler.api.jsonc',
    '-c',
    'wrangler.jobs.jsonc',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    port,
    '--inspector-port',
    testing ? '9341' : '9331',
    '--persist-to',
    stateDir,
    ...(existsSync('.dev.vars') ? ['--env-file', '.dev.vars'] : []),
    '--env-file',
    connectionKeyFile(),
    '--var',
    'LOCAL_DEVELOPMENT:1',
    '--show-interactive-dev-session=false',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    },
  },
)
function stop() {
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}
const control = createServer((socket) => {
  socket.setTimeout(1000, () => socket.destroy())
  socket.once('data', (message) => {
    if (message.toString() === 'stop') {
      socket.end('正在关闭本机工作台。\n')
      stop()
    } else socket.end()
  })
})
control.listen(devControl)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
child.once('exit', (code) => process.exit(code ?? 1))
