import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const [stage, databaseId, databaseName, bucket, hostname] = process.argv.slice(2)
if (
  !['staging', 'production'].includes(stage) ||
  !/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(databaseId ?? '') ||
  databaseId === '00000000-0000-4000-8000-000000000001' ||
  !/^[a-z][a-z0-9-]{1,60}$/.test(databaseName ?? '') ||
  !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
  isIP(hostname ?? '') ||
  !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname ?? '')
) {
  throw new Error('参数依次为 staging 或 production、该环境 D1 UUID、D1 名称、R2 名称及工作台域名。')
}
const units = ['jobs', 'api']
const workersDev = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.[a-z0-9-]+\.workers\.dev$/.exec(hostname)
if (hostname.endsWith('.workers.dev') && !workersDev) throw new Error('请填写完整的 Worker 默认域名。')
const prefix = workersDev?.[1]
for (const unit of units) {
  if (existsSync('wrangler.' + unit + '.' + stage + '.local.jsonc'))
    throw new Error('该环境已有本地配置，请核对配置文件。')
}
for (const unit of units) {
  const config = JSON.parse(readFileSync('wrangler.' + unit + '.jsonc', 'utf8'))
  config.name = prefix ? (unit === 'api' ? prefix : prefix + '-jobs') : config.name + '-' + stage
  Object.assign(config.d1_databases[0], { database_name: databaseName, database_id: databaseId })
  config.r2_buckets[0].bucket_name = bucket
  for (const flow of config.workflows) {
    flow.name = prefix
      ? prefix + (flow.binding === 'ASSISTANT_RUNNER' ? '-assistant' : '-run')
      : flow.name + '-' + stage
    if (unit === 'api') flow.script_name = prefix ? prefix + '-jobs' : 'selection-jobs-' + stage
  }
  if (unit === 'jobs') config.triggers = { crons: [] }
  if (unit === 'api') {
    config.workflows[0].script_name = prefix
      ? prefix + '-jobs'
      : config.workflows[0].script_name + '-' + stage
    if (prefix) config.workers_dev = true
    else config.routes = [{ pattern: hostname, custom_domain: true }]
  }
  const filename = 'wrangler.' + unit + '.' + stage + '.local.jsonc'
  writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
  console.log(filename)
}
