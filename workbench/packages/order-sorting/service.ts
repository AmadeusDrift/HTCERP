import { z } from 'zod'
import { PublicError } from '../contracts/errors'
import { type AttributeRow, type OrderInput, type SortPlan, sortOrders } from './rules'
import { serverTemplateContent } from './template-server'

const invalid = (message: string) => new PublicError('INVALID_INPUT', message, 400)
const conflict = (message: string) => new PublicError('CONFLICT', message, 409)
const scalar = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])
const attributeRows = z.array(z.array(scalar).length(11)).max(10000)
const orderSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s + 'T00:00:00Z')
        return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
      }),
    rows: z
      .array(
        z.tuple([
          scalar,
          z.string().min(1).max(512),
          z.string().min(1).max(512),
          z.string().min(1).max(1000),
          z.number(),
        ]),
      )
      .min(1)
      .max(10000),
  })
  .strict()
const revision = z.number().int().nonnegative()
const sourceFile = z
  .object({
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\\/]+\.xlsx$/i)
      .refine((name) => !Array.from(name).some((char) => char.charCodeAt(0) < 32)),
    base64: z
      .string()
      .min(8)
      .max(8_000_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict()
const configSchema = z
  .object({
    revision,
    rows: attributeRows,
    attributeFile: sourceFile.optional(),
    templateFile: sourceFile.optional(),
  })
  .strict()
const previewSchema = z.object({ revision, order: orderSchema }).strict()
const runSchema = previewSchema.extend({ id: z.uuid(), filename: z.string().min(1).max(250) }).strict()
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) throw invalid('文件内容或参数无效，请检查日期、列数、数量和文件大小。')
  return r.data
}
async function hash(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('')
}
type Env = { DB: D1Database; ARCHIVE: R2Bucket }
type ConfigRow = {
  revision: number
  rows_json: string
  attribute_key: string
  template_key: string
  updated_at: number
}
export type SortConfig = {
  revision: number
  rows: AttributeRow[]
  attributeKey: string
  templateKey: string
  updatedAt: number
}
export type RunResult = {
  id: string
  createdAt: number
  filename: string
  revision: number
  attributeKey: string
  templateKey: string
  plan: SortPlan
}
export type RunSummary = {
  id: string
  createdAt: number
  filename: string
  date: string
  groups: number
  rows: number
  units: number
}
export type SortingState = { config: SortConfig | null; runs: RunSummary[] }
export type RunPage = { runs: RunSummary[]; next: { time: number; id: string } | null }

export class OrderSorting {
  constructor(private env: Env) {}
  private async config(): Promise<SortConfig | null> {
    const r = await this.env.DB.prepare(
      'SELECT * FROM order_sorting_config WHERE singleton=1',
    ).first<ConfigRow>()
    return r
      ? {
          revision: r.revision,
          rows: JSON.parse(r.rows_json),
          attributeKey: r.attribute_key,
          templateKey: r.template_key,
          updatedAt: r.updated_at,
        }
      : null
  }
  async state(): Promise<SortingState> {
    const config = await this.config()
    const runs = await this.env.DB.prepare(
      'SELECT id,created_at AS createdAt,filename,order_date AS date,groups_count AS groups,rows_count AS rows,units FROM order_sorting_runs ORDER BY created_at DESC,id DESC LIMIT 30',
    ).all<RunSummary>()
    return { config, runs: runs.results }
  }
  async history(input: unknown): Promise<RunPage> {
    const cursor = parse(
      z.object({ time: z.number().int().nonnegative(), id: z.uuid() }).strict().nullable(),
      input,
    )
    const where = cursor ? 'WHERE created_at < ? OR (created_at = ? AND id < ?)' : ''
    const statement = this.env.DB.prepare(
      `SELECT id,created_at AS createdAt,filename,order_date AS date,groups_count AS groups,rows_count AS rows,units FROM order_sorting_runs ${where} ORDER BY created_at DESC,id DESC LIMIT 31`,
    )
    const rows = await (cursor
      ? statement.bind(cursor.time, cursor.time, cursor.id)
      : statement
    ).all<RunSummary>()
    const runs = rows.results.slice(0, 30),
      last = runs.at(-1)
    return {
      runs,
      next: rows.results.length > 30 && last ? { time: last.createdAt, id: last.id } : null,
    }
  }
  private async current(expected: number) {
    const config = await this.config()
    if (!config) throw conflict('请先由管理员导入产品属性清单和分拣模板。')
    if (config.revision !== expected) throw conflict('属性清单版本已变化，请刷新后重新预览。')
    return config
  }
  private rowsJson(rows: AttributeRow[]) {
    const s = JSON.stringify(rows)
    if (new TextEncoder().encode(s).length > 900_000)
      throw invalid('属性清单内容超过900 KB，请减少无关空行或过长文本。')
    return s
  }
  private async upload(file: z.infer<typeof sourceFile>, kind: 'attributes' | 'template', now: number) {
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(file.base64), (s) => s.charCodeAt(0))
    } catch {
      throw invalid('Excel 文件编码无效。')
    }
    if (bytes.length < 8 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
      throw invalid('请上传有效的 .xlsx 工作簿。')
    const id = crypto.randomUUID(),
      sha = await hash(bytes)
    let contentHash = sha
    if (kind === 'template') {
      try {
        contentHash = await hash(await serverTemplateContent(bytes))
      } catch {
        throw invalid('分拣模板无法读取，请上传包含两张工作表的有效 .xlsx 文件。')
      }
    }
    await this.env.ARCHIVE.put('order-sorting/assets/' + id, bytes, {
      httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    })
    return {
      id,
      statement: this.env.DB.prepare('INSERT INTO order_sorting_assets VALUES(?,?,?,?,?,?)').bind(
        id,
        file.name,
        kind,
        sha,
        contentHash,
        now,
      ),
    }
  }
  private versionStatements(config: SortConfig, expected: number, actor: string, now: number) {
    const rows = this.rowsJson(config.rows)
    return [
      this.env.DB.prepare(`INSERT INTO order_sorting_versions(revision,rows_json,attribute_key,template_key,actor,created_at,guard)
        VALUES(?,?,?,?,?,?,CASE WHEN COALESCE((SELECT revision FROM order_sorting_config WHERE singleton=1),0)=? THEN 1 ELSE 0 END)`).bind(
        config.revision,
        rows,
        config.attributeKey,
        config.templateKey,
        actor,
        now,
        expected,
      ),
      this.env.DB.prepare(
        `INSERT INTO order_sorting_config VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,rows_json=excluded.rows_json,attribute_key=excluded.attribute_key,template_key=excluded.template_key,updated_at=excluded.updated_at WHERE order_sorting_config.revision=?`,
      ).bind(config.revision, rows, config.attributeKey, config.templateKey, now, expected),
    ]
  }
  async configure(role: string, input: unknown, actor: string): Promise<SortingState> {
    if (role !== 'admin') throw new PublicError('FORBIDDEN', '仅管理员可维护属性清单和模板。', 403)
    const data = parse(configSchema, input),
      old = await this.config()
    if ((old?.revision ?? 0) !== data.revision) throw conflict('属性清单版本已变化，请刷新后重试。')
    if (!old && (!data.attributeFile || !data.templateFile))
      throw invalid('首次使用请同时导入属性清单和分拣模板。')
    this.rowsJson(data.rows)
    const now = Date.now(),
      attr = data.attributeFile ? await this.upload(data.attributeFile, 'attributes', now) : null,
      template = data.templateFile ? await this.upload(data.templateFile, 'template', now) : null
    const next: SortConfig = {
      revision: data.revision + 1,
      rows: data.rows,
      attributeKey: attr?.id ?? old!.attributeKey,
      templateKey: template?.id ?? old!.templateKey,
      updatedAt: now,
    }
    try {
      await this.env.DB.batch([
        ...(attr ? [attr.statement] : []),
        ...(template ? [template.statement] : []),
        ...this.versionStatements(next, data.revision, actor, now),
      ])
    } catch {
      throw conflict('属性清单版本已变化，未覆盖其他人的修改，请刷新后重试。')
    }
    return this.state()
  }
  async preview(input: unknown): Promise<SortPlan> {
    const data = parse(previewSchema, input),
      config = await this.current(data.revision)
    try {
      return sortOrders(data.order as OrderInput, config.rows)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : '分拣数据无效。')
    }
  }
  async getRun(id: string): Promise<RunResult> {
    const r = await this.env.DB.prepare('SELECT result_key FROM order_sorting_runs WHERE id=?')
      .bind(id)
      .first<{ result_key: string }>()
    if (!r) throw new PublicError('NOT_FOUND', '没有找到这次分拣记录。', 404)
    const object = await this.env.ARCHIVE.get(r.result_key)
    if (!object) throw new PublicError('INTERNAL', '分拣结果暂时无法读取，请重试。', 503)
    return object.json<RunResult>()
  }
  async run(input: unknown, actor: string): Promise<RunResult> {
    const data = parse(runSchema, input),
      requestHash = await hash(JSON.stringify(data))
    const existing = await this.env.DB.prepare('SELECT request_hash FROM order_sorting_runs WHERE id=?')
      .bind(data.id)
      .first<{ request_hash: string }>()
    if (existing) {
      if (existing.request_hash !== requestHash) throw conflict('同一请求编号不能对应不同订单。')
      return this.getRun(data.id)
    }
    const config = await this.current(data.revision)
    let plan: SortPlan
    try {
      plan = sortOrders(data.order as OrderInput, config.rows)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : '订单数据无效。')
    }
    this.rowsJson(plan.attributes)
    const template = await this.env.DB.prepare(
      'SELECT content_hash FROM order_sorting_assets WHERE id=?',
    )
      .bind(config.templateKey)
      .first<{ content_hash: string }>()
    if (!template) throw new PublicError('INTERNAL', '分拣模板暂时无法读取，请重试。', 503)
    const fingerprints = await Promise.all(
      plan.groups.map(async (group) => ({
        name: group.filename,
        key: group.filename.toLowerCase(),
        hash: await hash(
          JSON.stringify({
            template: template.content_hash,
            date: plan.date,
            name: group.name,
            raw: group.raw,
            detail: group.detail,
          }),
        ),
      })),
    )
    for (const file of fingerprints) {
      const old = await this.env.DB.prepare(
        'SELECT fingerprint FROM order_sorting_outputs WHERE filename_key=?',
      )
        .bind(file.key)
        .first<{ fingerprint: string }>()
      if (old && old.fingerprint !== file.hash)
        throw conflict('同名订单内容不同：' + file.name + '。未生成本批文件或修改属性清单。')
    }
    const now = Date.now(),
      result: RunResult = {
        id: data.id,
        createdAt: now,
        filename: data.filename,
        revision: config.revision,
        attributeKey: config.attributeKey,
        templateKey: config.templateKey,
        plan,
      }
    const resultKey = 'order-sorting/results/' + crypto.randomUUID() + '.json'
    await this.env.ARCHIVE.put(resultKey, JSON.stringify(result), {
      httpMetadata: { contentType: 'application/json' },
    })
    try {
      await this.env.DB.batch([
        ...this.versionStatements(
          { ...config, revision: config.revision + 1, rows: plan.attributes },
          config.revision,
          actor,
          now,
        ),
        this.env.DB.prepare('INSERT INTO order_sorting_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(
          data.id,
          requestHash,
          resultKey,
          data.filename,
          plan.date,
          plan.groups.length,
          plan.totalRows,
          plan.totalUnits,
          config.revision,
          actor,
          now,
        ),
        ...fingerprints.map((file) =>
          this.env.DB.prepare(
            `INSERT INTO order_sorting_outputs VALUES(?,?,?,?) ON CONFLICT(filename_key) DO UPDATE SET fingerprint=CASE WHEN order_sorting_outputs.fingerprint=excluded.fingerprint THEN order_sorting_outputs.fingerprint ELSE NULL END`,
          ).bind(file.key, file.hash, file.name, data.id),
        ),
      ])
    } catch {
      const saved = await this.env.DB.prepare('SELECT request_hash FROM order_sorting_runs WHERE id=?')
        .bind(data.id)
        .first<{ request_hash: string }>()
      if (saved?.request_hash === requestHash) return this.getRun(data.id)
      if (saved) throw conflict('同一请求编号不能对应不同订单。')
      throw conflict('清单版本或同名订单已变化，本次未覆盖，请刷新后重新预览。')
    }
    return result
  }
  async asset(id: string) {
    const record = await this.env.DB.prepare('SELECT name FROM order_sorting_assets WHERE id=?')
      .bind(id)
      .first<{ name: string }>()
    if (!record) throw new PublicError('NOT_FOUND', '找不到这个工作簿。', 404)
    const object = await this.env.ARCHIVE.get('order-sorting/assets/' + id)
    if (!object) throw new PublicError('NOT_FOUND', '工作簿暂时无法读取。', 404)
    return { name: record.name, object }
  }
}
