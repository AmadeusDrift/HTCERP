import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
const directory = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
it('allows only Pack top-frame documents to invoke narrow broker methods and does not leak credentials', async () => {
  let listener: any
  const calls: any[] = []
  const connector: any = { ready: async () => {}, pack: { resume: async (input: any, owner: string) => { calls.push({ input, owner }); return { requestId: 'request' } } } }
  const context: any = { URL, fetch: () => {}, crypto: {}, importScripts: () => {}, SellerFlexConnector: { create: () => connector }, SellerFlexLiveConnector: {}, SellerFlexErpConnection: {}, SellerFlexPackConnector: {},
    chrome: { runtime: { id: 'extension', getURL: (path: string) => 'chrome-extension://extension/' + path, onMessage: { addListener: (value: any) => { listener = value } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } }, alarms: { onAlarm: { addListener() {} } } } }
  runInNewContext(readFileSync(new URL('background.js', directory), 'utf8'), context)
  const sender = { id: 'extension', url: 'https://sellerflex.amazon.com/transshipments/pack', tab: { id: 4 }, frameId: 0, documentId: 'doc-one' }
  const invoke = (from: any, operation = 'resume') => new Promise(resolve => { if (!listener({ type: 'sf-pack', operation, input: { rows: [] } }, from, resolve)) resolve('rejected') })
  expect(await invoke(sender)).toEqual({ ok: true, value: { requestId: 'request' } })
  expect(calls[0].owner).toBe('tab:4:document:doc-one')
  for (const from of [{ ...sender, url: 'https://sellerflex.amazon.com/receive' }, { ...sender, frameId: 1 }, { ...sender, documentId: undefined }, { ...sender, url: 'https://evil.example/transshipments/pack' }, { ...sender, id: 'other' }, { ...sender, tab: undefined }]) expect(await invoke(from)).toBe('rejected')
  expect(await invoke(sender, 'synchronize')).toBe('rejected')
  expect(await invoke(sender, 'request')).toBe('rejected')
  expect(await invoke(sender, 'label')).toBe('rejected')
  expect(calls).toHaveLength(1)
})
it('ships Pack MAIN observer and isolated UI without extra permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
  expect(manifest.version).toBe('0.7.1')
  expect(manifest.permissions).toEqual(['storage', 'alarms'])
  expect(manifest.host_permissions).toEqual(['https://htcerp.app/*'])
  expect(manifest.content_scripts.find((item: any) => item.world === 'MAIN')).toMatchObject({ matches: ['https://sellerflex.amazon.com/*'], js: ['pack-export-main.js'], run_at: 'document_start', all_frames: false })
  expect(manifest.content_scripts[0].js).toContain('pack-content.js')
  expect(manifest.content_scripts[0].js.indexOf('pack-all.js')).toBeLessThan(manifest.content_scripts[0].js.indexOf('pack-content.js'))
})
