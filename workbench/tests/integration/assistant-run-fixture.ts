import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { vi } from 'vitest'
import type { AssistantBindings } from '../../packages/assistant/runs'

export function investigationFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync('migrations/' + file, 'utf8'))
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = db.prepare(sql)
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: (field?: string) => {
        const row = statement.get(...values)
        return (field ? row?.[field] : row) ?? null
      },
      all: () => ({ results: statement.all(...values) }),
      run: () =>
        /^\s*SELECT/i.test(sql)
          ? { results: statement.all(...values), meta: { changes: 0 } }
          : { meta: statement.run(...values) },
    }
  }
  const DB = {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) => {
      db.exec('BEGIN')
      try {
        const values = statements.map((s) => s.run())
        db.exec('COMMIT')
        return values
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  db.exec(
    "INSERT INTO accounts(id,username,role,salt,password_hash) VALUES('alice','alice','viewer','',''),('bob','bob','operator','',''); UPDATE strategy_versions SET settings_json=json_set(settings_json,'$.aiDailyMicros',1000000)",
  )
  const conversationId = crypto.randomUUID(),
    turnId = crypto.randomUUID()
  db.prepare("INSERT INTO assistant_conversations VALUES(?,'alice','调查',?)").run(
    conversationId,
    new Date().toISOString(),
  )
  db.prepare(
    "INSERT INTO assistant_turns(conversation_id,id,question,context_json,created_at) VALUES(?,?,'比较库存商品','{}',?)",
  ).run(conversationId, turnId, new Date().toISOString())
  const fetch = vi.fn<(request: Request) => Promise<Response>>()
  const archive = new Map<string, string>()
  const create = vi.fn(async (_value: unknown) => ({ id: 'workflow' }))
  const env = {
    DB,
    OPENROUTER_API_KEY: 'test-only-secret',
    OPENROUTER_US: { fetch },
    ARCHIVE: {
      get: vi.fn(async (key: string) =>
        archive.has(key)
          ? { size: archive.get(key)!.length, text: async () => archive.get(key)! }
          : null,
      ),
      put: vi.fn(async (key: string, value: string) => {
        archive.set(key, value)
        return { key }
      }),
    },
    ASSISTANT_RUNNER: { create },
    RUNNER: {},
  } as unknown as AssistantBindings
  return { db, env, fetch, archive, create, conversationId, turnId }
}
export function modelAction(action: unknown, cost: number | null = 0.00001) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(action) } }],
    ...(cost === null ? {} : { usage: { cost } }),
  })
}
