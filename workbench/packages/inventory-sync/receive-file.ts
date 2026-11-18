import { z } from 'zod'

const text = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => s.trim() === s && !Array.from(s).some((c) => c.charCodeAt(0) < 32))
const rowSchema = z
  .object({
    rowId: text,
    sku: text,
    binCode: text,
    quantity: z.number().int().min(1).max(5),
    disposition: z.enum(['GOOD', 'BAD']),
    expiryDate: z.iso.date().nullish(),
    manufacturingDate: z.iso.date().nullish(),
  })
  .strict()
export type ReceiveRow = z.infer<typeof rowSchema>
export const receiveFileMaxRows = 3000
export const automaticFileMaxRows = 2900
const header =
  'BIN,Merchant SKU,Quantity,Disposition (GOOD/BAD),Expiration Date (DD/MM/YYYY),Manufacturing Date (DD/MM/YYYY)'
const cell = (value: string) => (/[",]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value)
const date = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '')

/** Generates new UTF-8 content exclusively from effective business rows; never edits a prior workbook. */
export async function receiveFile(input: ReceiveRow[]) {
  const rows = z.array(rowSchema).min(1).max(receiveFileMaxRows).parse(input)
  if (new Set(rows.map((r) => r.rowId)).size !== rows.length) throw new Error('文件包含重复业务行。')
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.binCode,
        r.sku,
        String(r.quantity),
        r.disposition,
        date(r.expiryDate),
        date(r.manufacturingDate),
      ]
        .map(cell)
        .join(','),
    ),
    '',
  ].join('\r\n')
  const bytes = new TextEncoder().encode(csv)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return {
    csv,
    sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
    rowMap: rows.map((r, index) => ({ rowId: r.rowId, fileRow: index + 2 })),
  }
}
