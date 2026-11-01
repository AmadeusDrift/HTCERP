import { z } from 'zod'

export const productIdSchema = z
  .string()
  .regex(/^(?:amazon:US:[A-Z0-9]{10}|(?:temu|shein|tiktok|aliexpress):US:\d{1,32})$/)
export const coverageSchema = z.object({
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
})
export const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['product_snapshot', 'review_report', 'amazon_comparison', 'job_report']),
  objectId: z.string().min(1),
  observedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
})
export const readToolResultSchema = z.object({
  version: z.literal(1),
  status: z.enum(['ok', 'partial', 'empty', 'denied', 'unavailable']),
  data: z.record(z.string(), z.unknown()).nullable(),
  coverage: coverageSchema,
  evidence: z.array(evidenceSchema),
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
})
export type ReadToolResult = z.infer<typeof readToolResultSchema>
export type ToolEvidence = z.infer<typeof evidenceSchema>
