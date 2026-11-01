import { z } from 'zod'
import { memberDiagnostic } from '../contracts/presentation'
import { businessClock, parse } from '../operations/model'

export interface DailyTask {
  id: string
  title: string
  status: string
  summary: string
  selected: number
  steps: number
  latestStep: string | null
  updatedAt: string
}
export async function dailyTasks(db: D1Database, day?: string) {
  const date = parse(z.iso.date(), day ?? businessClock().slice(0, 10))
  const task = await db
    .prepare(`SELECT id,title,status,summary,updated_at updatedAt,
    (SELECT COUNT(*) FROM job_steps WHERE run_id=r.id AND status='succeeded') steps,
    (SELECT title FROM job_steps WHERE run_id=r.id ORDER BY updated_at DESC,rowid DESC LIMIT 1) latestStep,
    (SELECT COUNT(*) FROM job_seen WHERE run_id=r.id AND tier IS NOT NULL) selected
    FROM job_runs r WHERE actor='scheduler' AND kind='discovery' AND parent_id IS NULL AND request_key=?`)
    .bind('cron:daily:US:' + date)
    .first<DailyTask>()
  return {
    date,
    task: task
      ? {
          ...task,
          summary: memberDiagnostic(task.summary),
          latestStep: task.latestStep && memberDiagnostic(task.latestStep),
        }
      : null,
  }
}
