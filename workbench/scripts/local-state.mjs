import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// Keep test feedback and jobs out of the working catalog.
export const testing = process.env.WORKBENCH_E2E === '1'
export const stateDir = resolve(testing ? '.local/e2e-state' : '.local/state')
export const port = testing ? '8788' : '8787'
const key = 'selection-' + createHash('sha256').update(stateDir).digest('hex').slice(0, 18)
export const devControl =
  process.platform === 'win32' ? '\\\\.\\pipe\\' + key : resolve(tmpdir(), key + '.sock')
// Local credentials and their encryption key live in separate locations. Keep a stable key per DB.
export function connectionKeyFile() {
  const base =
    process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state')
  const dir = resolve(base, 'SelectionWorkbench', key)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = resolve(dir, 'connections.env')
  try {
    writeFileSync(file, 'CONNECTIONS_KEY=' + randomBytes(32).toString('hex') + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return file
}
export function acquireLocalState() {
  mkdirSync(stateDir, { recursive: true })
  // The OS releases this transaction's lock even if a test runner kills the process.
  const lock = new DatabaseSync(resolve(stateDir, 'lifecycle.sqlite'))
  try {
    lock.exec('BEGIN EXCLUSIVE')
  } catch (e) {
    lock.close()
    throw new Error('本地数据库正在使用，请先停止对应的开发服务或初始化程序。', { cause: e })
  }
  process.once('exit', () => lock.close())
}
