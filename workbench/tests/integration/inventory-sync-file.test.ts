import { expect, it } from 'vitest'
import { receiveFile } from '../../packages/inventory-sync/receive-file'

it('creates a new CSV with exactly the 818 effective rows and no former workbook tail', async () => {
  const file = await receiveFile(
    Array.from({ length: 818 }, (_, i) => ({
      rowId: 'row-' + i,
      sku: 'ITEM-JIT-' + i,
      binCode: 'Default',
      quantity: 2,
      disposition: 'GOOD' as const,
    })),
  )
  expect(file.csv.split('\r\n')).toHaveLength(820) // Header + 818 rows + final newline.
  expect(file.rowMap).toHaveLength(818)
  expect(file.rowMap[817]).toEqual({ rowId: 'row-817', fileRow: 819 })
  expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(file.csv).not.toContain('ITEM-JIT-818')
})

it('escapes commas and quotes, leaves optional dates empty and produces repeatable bytes', async () => {
  const rows = [
    { rowId: 'a', sku: 'A,"JIT"', binCode: 'Default', quantity: 3, disposition: 'GOOD' as const },
  ]
  const file = await receiveFile(rows)
  expect(file.csv).toContain('Default,"A,""JIT""",3,GOOD,,\r\n')
  expect(await receiveFile(rows)).toEqual(file)
})

it('rejects zero quantities, blank SKUs, duplicate business rows and empty files', async () => {
  const row = {
    rowId: 'a',
    sku: 'SKU-JIT',
    binCode: 'Default',
    quantity: 2,
    disposition: 'GOOD' as const,
  }
  await expect(receiveFile([])).rejects.toThrow()
  await expect(receiveFile([{ ...row, quantity: 0 }])).rejects.toThrow()
  await expect(receiveFile([{ ...row, sku: ' ' }])).rejects.toThrow()
  await expect(receiveFile([row, row])).rejects.toThrow()
})
