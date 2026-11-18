import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const source = new URL('../extensions/sellerflex-inventory/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Invalid extension version')
const zip = new JSZip()
for (const file of await readdir(source, { withFileTypes: true })) {
  if (!file.isFile() || !/\.(js|json|css|html|md|txt)$/.test(file.name)) continue
  zip.file('sellerflex-inventory/' + file.name, await readFile(new URL(file.name, source)))
}
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
const check = await JSZip.loadAsync(bytes)
if (
  JSON.parse(await check.file('sellerflex-inventory/manifest.json').async('string')).version !==
  manifest.version
)
  throw Error('Packaged manifest mismatch')
const downloads = new URL('../apps/web/public/downloads/', import.meta.url)
const output = new URL(`SellerFlex-Batch-Inventory-v${manifest.version}.zip`, downloads)
await mkdir(downloads, { recursive: true })
await writeFile(output, bytes)
console.log(
  JSON.stringify({
    version: manifest.version,
    files: Object.keys(check.files).length - 1,
    bytes: bytes.length,
    output: fileURLToPath(output),
  }),
)
