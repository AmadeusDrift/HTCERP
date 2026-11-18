import { describe, expect, it } from 'vitest'
import {
  type AttributeRow,
  matchAttribute,
  type OrderRow,
  productCode,
  sortOrders,
  specificGroup,
} from '../../packages/order-sorting/rules'

const attr = (group: string | null, code: string, sku: string | null = null): AttributeRow => [
  group,
  null,
  code,
  sku,
  '名称',
  '颜色',
  '规格',
  3,
  '备注',
  '工艺',
  '供应商',
]
const order = (sku: string, units = 1, fnsku = 'FN'): OrderRow => [
  '标题',
  sku,
  fnsku,
  'same-transfer',
  units,
]

describe('LENI compatible sorting', () => {
  it('keeps specific keyword priority and product code normalization', () => {
    expect(specificGroup('HUNI-HX-JA')).toBe('HUJA-SS')
    expect(specificGroup('HUNI-HX-TLB')).toBe('HUNI-SS')
    expect(specificGroup('NI-ZB-VT-YKL')).toBe('HUNI-YW')
    expect(productCode('ABC.JA-red')).toBe('ABC')
    expect(productCode('ABC-JIT-red')).toBe('ABC')
    expect(productCode('ABC-123')).toBe('ABC')
    expect(productCode('ABC-red')).toBe('ABC-red')
  })
  it('prefers exact SKU then longest product code and detects tied group conflicts', () => {
    const short = attr('exact', 'A', 'ABC-LONG-1')
    const long = attr('long', 'ABC-LONG')
    expect(matchAttribute('abc-long-1', [long, short])).toBe(short)
    expect(matchAttribute('ABC-LONG-2', [attr('short', 'ABC'), long])).toBe(long)
    expect(() => matchAttribute('ABC-1', [attr('one', 'ABC'), attr('two', 'ABC')])).toThrow(
      '属性清单有冲突分类',
    )
    const known = attr('known', 'ABC')
    expect(matchAttribute('ABC-1', [attr(null, 'ABC'), known])).toBe(known)
  })
  it('uses known groups ahead of keywords, fills blank rows, and retains original SKU aggregation', () => {
    const attributes = [attr('manual', 'HUNI-HX'), Array(11).fill(null), attr(null, 'TLB')]
    const input = {
      date: '2026-11-16',
      rows: [
        order('HUNI-HX-1', 2),
        order('TLB-1', -1),
        order('TLB-1', 0.5),
        order(' TLB-1 ', 0),
        order('TLB-1', 2, 'OTHER'),
      ],
    }
    const plan = sortOrders(input, attributes)
    expect(plan.groups.map((g) => g.name)).toEqual(['HUNI-YW', 'manual'])
    expect(plan.groups[0].raw).toHaveLength(4)
    expect(plan.groups[0].detail.map((row) => [row[5], row[6], row[7]])).toEqual([
      ['TLB-1', 'FN', -0.5],
      [' TLB-1 ', 'FN', 0],
      ['TLB-1', 'OTHER', 2],
    ])
    expect(plan.groups[0].detail[0]).toEqual([
      1,
      '名称',
      '颜色',
      '规格',
      null,
      'TLB-1',
      'FN',
      -0.5,
      3,
      '=IF(I4="","",H4*I4)',
      '备注',
      '工艺',
      '供应商',
      '2026/11/16',
    ])
    expect(plan.attributes[2][0]).toBe('HUNI-YW')
    expect(plan.attributes[1]).toEqual(Array(11).fill(null))
    expect(attributes[2][0]).toBeNull()
    expect(plan.filled).toBe(1)
    expect(plan.totalUnits).toBe(3.5)
  })
  it('adds each unknown code once, reuses trailing blank rows, and leaves conflicting suggestions blank', () => {
    const plan = sortOrders(
      {
        date: '2026-11-16',
        rows: [
          order('NEW-1'),
          order('new-2'),
          order('ITEM.JA-HX'),
          order('ITEM.JA-TLB'),
          order('HUC-X'),
        ],
      },
      [Array(11).fill(null), Array(11).fill(null)],
    )
    expect(plan.additions).toEqual([
      { code: 'NEW', sku: 'NEW-1', group: null },
      { code: 'ITEM', sku: 'ITEM.JA-HX', group: null },
      { code: 'HUC', sku: 'HUC-X', group: null },
    ])
    expect(plan.attributes).toHaveLength(3)
    expect(plan.groups.map((g) => g.name)).toEqual(['HUJA-SS', 'HUNI-YW', 'HUC', '待确认'].sort())
    expect(plan.filled).toBe(0)
  })
  it('uses unambiguous attribute suggestions before fallback and refuses unsafe filenames', () => {
    const plan = sortOrders(
      { date: '2026-11-16', rows: [order('OTHER-1'), order('HUVT-1'), order('CUSTOM-JA')] },
      [attr(null, 'OTHER', 'TLB')],
    )
    expect(plan.groups.map((g) => g.name)).toEqual(['HUJA', 'HUNI-YW', 'HUVT'])
    expect(() =>
      sortOrders({ date: '2026-11-16', rows: [order('A-1')] }, [attr('../bad', 'A')]),
    ).toThrow('分类不能用作文件名')
  })
})
