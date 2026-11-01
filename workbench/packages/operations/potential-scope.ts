export const potentialScope = { platform: 'temu', categoryId: 'home', keyword: '', maxPrice: 4 } as const
export const dayMs = 86400000
export const newProductDays = 30
export function potentialWindow(at: string) {
  return new Date(Date.parse(at) - newProductDays * dayMs).toISOString()
}
