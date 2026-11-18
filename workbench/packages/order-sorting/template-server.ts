import { templateWorkbookContent } from './workbook'

export async function serverTemplateContent(bytes: Uint8Array): Promise<string> {
  // The browser bundle caches request-bound schedulers. On Workers use the
  // document entry with native streams (see wrangler.api.jsonc's alias).
  const { default: Workbook } = await import('exceljs/lib/doc/workbook.js')
  const book = new Workbook()
  await book.xlsx.load(bytes as never)
  return templateWorkbookContent(book)
}
