import { connect } from 'node:net'
import { devControl } from './local-state.mjs'

const connection = connect(devControl)
connection.once('connect', () => connection.end('stop'))
connection.once('error', () => {
  console.error('未找到此工作目录启动的开发服务。')
  process.exitCode = 1
})
connection.on('data', (data) => process.stdout.write(data))
