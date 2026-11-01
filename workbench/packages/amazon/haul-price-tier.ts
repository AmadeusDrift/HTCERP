// Internal selection rule for a US catalog listing's USD offer, before shipping.
export function haulPriceTier(price: number | null) {
  if (price === null || !Number.isFinite(price) || price <= 0) return '无有效报价，暂不判断'
  if (price < 4) return '大概率属于低价商城，优先考虑'
  if (price < 6) return 'Haul 很可能有'
  return '默认按普通商城处理'
}
