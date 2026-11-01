import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { screenReportProduct } from './report-price-screen'
import { expandedScreen, type Seed } from './expanded-screen'
import { runAmazonComparison } from '../../../packages/operations/amazon-comparison'
import {
  activeContext,
  discoverPage,
  finish,
  followDecision,
  refreshFocus,
  researchStep,
  stepOnce,
  storedResult,
} from '../../../packages/operations/execution'
import { runSchedule } from '../../../packages/operations/jobs'
import type { OpsBindings } from '../../../packages/operations/model'
import { Stop } from '../../../packages/operations/providers'
import { advanceQueue } from '../../../packages/operations/queue'

type WorkflowInput = { runId: string; reportScreen?: { productId: string; query: string }; expandSeeds?:Seed[] }
export class ResearchWorkflow extends WorkflowEntrypoint<OpsBindings, WorkflowInput> {
  async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
    const id = event.payload.runId
    if(event.payload.expandSeeds) return expandedScreen(this.env,id,event.payload.expandSeeds,step)
    const screen = event.payload.reportScreen
    if (screen) return step.do('screen-archived-product', { retries: { limit: 2, delay: '20 seconds' } }, () =>
      screenReportProduct(this.env, id, screen.productId, screen.query))
    const data = await step.do('load-pinned-strategy-v1', async () => {
      const context = await activeContext(this.env, id, event.instanceId)
      if (!context) return null
      const { env, ...rest } = context
      const plan = await storedResult(env.DB, id, 'plan')
      if (!plan) throw new Error('缺少缓存证据计划')
      return {
        ...rest,
        ids: plan.categoryIds as string[],
        focus: (plan.focus as { id: string }[]).map((p) => p.id),
      }
    })
    if (!data) return
    const c = { ...data, env: this.env }
    let summary = '',
      stop = ''
    // Every possible paid request has its own Workflow checkpoint and persistent D1 reservation.
    const execute = async (key: string, title: string, fn: Parameters<typeof stepOnce>[3]) => {
      const outcome = await step.do(
        key,
        { retries: { limit: 0, delay: '1 second' }, timeout: '3 minutes' },
        async () => {
          try {
            const result = await stepOnce(c, key, title, fn)
            return {
              stop: '',
              exhausted: result.exhausted === true,
              route: String(result.choice ?? ''),
              summary: String(result.summary ?? ''),
            }
          } catch (error) {
            return {
              stop: error instanceof Stop ? error.message : '步骤执行异常，请检查后补跑',
              exhausted: false,
              route: '',
              summary: '',
            }
          }
        },
      )
      stop = outcome.stop
      return outcome
    }
    try {
      if (c.job.kind === 'discovery') {
        let pages = 0,
          tracked = 0
        for (let page = 1; page <= c.settings.pageLimit; page++) {
          const { exhausted } = await execute('search-' + page, '发现商品 · 第 ' + page + ' 页', () =>
            discoverPage(c, page, c.ids),
          )
          if (stop) break
          pages++
          if (exhausted) break
        }
        for (const product of c.focus) {
          if (stop) break
          await execute('focus-' + product.split(':')[2], '更新重点商品 ' + product.split(':')[2], () =>
            refreshFocus(c, product),
          )
          if (!stop) tracked++
        }
        const q = await step.do('queue-by-sales-tier-v1', async () =>
          advanceQueue(this.env, c.job, c.settings, c.input, stop),
        )
        const first = await step.do('catalog-first-observations-v1', async () => {
          // Immutable insertion order distinguishes a newly added product from a new snapshot.
          const row = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM job_seen q
            WHERE run_id=? AND tier IS NOT NULL AND (SELECT evidence_ref FROM product_snapshots p
              WHERE p.product_id=q.product_id ORDER BY p.rowid LIMIT 1) LIKE ?`)
            .bind(id, 'jobs/' + id + '/%')
            .first<{ n: number }>()
          return row?.n ?? 0
        })
        summary = `已处理 ${pages} 个发现页，${q.total} 件达标，首次入库 ${first} 件，复访 ${q.total - first} 件。更新 ${tracked} 件重点商品，关联 ${q.submitted} 个本轮研究任务。`
        if (q.legacyComparisonsPending)
          summary += `另有 ${q.legacyComparisonsPending} 份复用的既有研究尚缺 Amazon 对照，可进入原研究补查。`
      } else {
        const modelStep = (kind: 'decision' | 'terra') =>
          execute(kind, kind === 'decision' ? 'Decisions 证据分流' : 'Terra 机会研究', async () => {
            const plan = await storedResult(this.env.DB, id, 'plan')
            if (!plan) throw new Stop('缺少缓存研究快照')
            return researchStep(c, kind, plan)
          })
        const { route } = await modelStep('decision')
        if (!stop && (route === 'research' || route === 'observe' || route === 'review')) {
          const amazon = await execute('amazon-compare', 'Amazon 美国站竞品对照', async () => {
            const [plan, decision] = await Promise.all([
              storedResult(this.env.DB, id, 'plan'),
              storedResult(this.env.DB, id, 'decision'),
            ])
            if (!plan || !decision) throw new Stop('缺少锁定的研究快照或分流结果')
            return runAmazonComparison(this.env, c.job, plan, decision)
          })
          if (!stop && route === 'research') await modelStep('terra')
          if (!stop) await execute('review-task', '人工复核与观察', () => followDecision(c, route))
          summary =
            amazon.summary +
            (route === 'research'
              ? '已生成 Terra 研究报告，待人工复核。'
              : route === 'review'
                ? 'Decisions 判定需人工补证，已生成复核待办。'
                : 'Decisions 建议继续观察，已生成观察待办。')
        } else if (!stop) {
          stop = '缺少可识别的 Decisions 分流结果'
        }
      }
    } catch {
      stop = '后台工作流中断，已保留步骤及费用记录，请补跑'
    }
    await step.do('finalize-v1', async () => {
      await finish(
        this.env,
        id,
        c.attempt,
        !stop,
        stop ? [stop, c.job.kind === 'discovery' ? summary : ''].filter(Boolean).join('。') : summary,
      )
    })
  }
}
export default {
  async scheduled(event: ScheduledController, env: OpsBindings) {
    await runSchedule(env, event.scheduledTime)
  },
  fetch() {
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<OpsBindings>
