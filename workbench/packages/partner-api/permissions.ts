import { z } from 'zod'
import { PublicError } from '../contracts/errors'

export const marketplace = 'ATVPDKIKX0DER'
export const permissions = {
  'sales.read': { label: 'Haul 销量与销售额', mode: 'read', default: true },
  'orders.read': { label: 'Haul 订单商品同步', mode: 'read', default: false },
  'listings.read': { label: '商品 Listing 与上架数据', mode: 'read', default: true },
  'inventory.read': { label: '库存快照', mode: 'read', default: true },
  'catalog.read': { label: 'Amazon 商品目录', mode: 'read', default: false },
  'offers.read': { label: 'Amazon 报价', mode: 'read', default: false },
  'feedback.read': { label: '商品评论主题汇总', mode: 'read', default: false },
  'issues.read': { label: 'Listing 问题', mode: 'read', default: false },
  'reports.read': { label: '库存与 Listing 报告同步状态', mode: 'read', default: false },
  'inventory.request': { label: '提交库存调整申请', mode: 'write', default: false },
  'inventory.quantity.write': { label: '修改 SKU 库存数量', mode: 'write', default: false },
  'price.write': { label: '修改 SKU 价格', mode: 'write', default: false },
} as const
export type Permission = keyof typeof permissions
export type WritePermission = 'inventory.request' | 'inventory.quantity.write' | 'price.write'
export const permissionSchema = z.enum(permissionsKeys())

function permissionsKeys() {
  return Object.keys(permissions) as Permission[]
}

export const sku = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u)
export const asin = z.string().regex(/^[A-Z0-9]{10}$/)
export const day = z.iso.date()
export const cursor = z.uuid().optional()
export const stockInput = z
  .object({
    sku,
    quantity: z.number().int().min(0).max(10000),
    expectedQuantity: z.number().int().nonnegative().optional(),
  })
  .strict()
export const priceInput = z
  .object({
    sku,
    audience: z.enum(['ALL', 'BZR']),
    cents: z.number().int().min(1).max(1_000_000),
    expectedCents: z.number().int().min(1).max(1_000_000),
  })
  .strict()
export const quantityInput = stockInput.required({ expectedQuantity: true })
export type WriteInput = z.infer<typeof stockInput> | z.infer<typeof priceInput>

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new PublicError('INVALID_INPUT', '请检查业务接口的请求参数。', 400)
  return result.data
}

export const forbidden = () => new PublicError('FORBIDDEN', '此接入方没有该项权限。', 403)
export const missing = () => new PublicError('NOT_FOUND', '未找到记录。', 404)
export const conflict = () => new PublicError('CONFLICT', '请求状态或授权已改变，请重新检查。', 409)
export const unavailable = () =>
  new PublicError('DATA_UNAVAILABLE', '暂时没有可交付的数据。', 503, 'amazon', true)
