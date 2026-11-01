export const positions = [
  'product_lead',
  'general_manager',
  'operations_lead',
  'operations_assistant',
  'amazon_operator',
] as const
export type Position = (typeof positions)[number]
