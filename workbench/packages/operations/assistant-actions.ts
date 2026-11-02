import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../amazon/adapter'
import { assertAssistantChildActive, claimAssistantCall } from '../assistant/budget'
import { providerCredentials } from '../connections/credentials'
import { parseReviewSample, parseReviewSummary, reviewSummaryRequest } from '../connections/temu-reviews'
import { researchProducts, runAmazonComparison } from './amazon-comparison'
import { activeContext, archived, finish, refreshFocus, stepOnce, storedResult } from './execution'
import type { OpsBindings } from './model'
import { bounds, geekRequest } from './providers'
import { dispatch } from './service-queue'

export async function runAssistantOperation(
  env: OpsBindings,
  id: string,
  instance: string,
  step: WorkflowStep,
) {
  const data = await step.do('load-specialized-context', async () => {
    const c = await activeContext(env, id, instance)
    if (!c) return null
    const { env: _, ...rest } = c
    return rest
  })
  if (!data) return
  const c = { ...data, env },
    operation = c.input.operation,
    productId = c.input.productId
  let issue = '',
    summary = ''
  const execute = async (
    key: string,
    title: string,
    action: () => Promise<import('./model').StepResult>,
  ) => {
    const json = await step.do(
      key,
      { retries: { limit: 0, delay: '1 second' }, timeout: '20 minutes' },
      async () => JSON.stringify(await stepOnce(c, key, title, action)),
    )
    return JSON.parse(json) as Record<string, unknown>
  }
  try {
    if (!productId) throw new Error('在线补查缺少明确商品。')
    if (operation === 'product_refresh') {
      const result = await execute('product-refresh', '更新指定商品资料', () =>
        refreshFocus(c, productId),
      )
      summary = '已保存指定商品详情与历史。' + String(result.summary ?? '')
    } else if (operation === 'amazon_backfill') {
      const result = await execute('amazon-compare', 'Amazon 美国站补查', async () => {
        const plan = await storedResult(env.DB, id, 'plan')
        if (!plan) throw new Error('缺少锁定商品快照')
        const products = researchProducts(plan)
        return runAmazonComparison(env, c.job, plan, {
          choice: 'review',
          products: products.map((v) => v.id),
        })
      })
      summary = String(result.summary ?? 'Amazon 对比已保存。')
    } else if (operation === 'reviews_refresh') {
      const platform = productId.split(':')[0],
        externalId = productId.split(':')[2],
        key = 'product-reviews/v1/US/' + platform + '/' + externalId
      await step.do('claim-review-report', async () => {
        await assertAssistantChildActive(env.DB, id)
        const saved = await env.DB.prepare(
          `INSERT INTO product_review_reports(product_key,lease_id,lease_until) VALUES(?,?,?) ON CONFLICT(product_key) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until WHERE lease_until<=? OR lease_id=?`,
        )
          .bind(key, id, Date.now() + 1200000, Date.now(), id)
          .run()
        if (!saved.meta.changes) throw new Error('这件商品的评论正在更新，请等待原分析完成。')
      })
      let reportData: Record<string, unknown>
      if (platform === 'temu') {
        const sample = await execute('reviews-source', '读取指定商品低星评论', async () => {
          const { result, ref } = await archived(
            c,
            'reviews-source',
            'points',
            bounds.geekbi,
            (credentials) =>
              geekRequest(credentials, 'temu', 'reviews', {
                goodsId: externalId,
                regionId: '211',
                scoreMin: '1',
                scoreMax: '2',
                page: '1',
                size: '30',
              }),
          )
          return {
            summary: '已保存一页低星评论',
            result: parseReviewSample(result, externalId),
            evidenceRef: ref,
          }
        })
        if (Array.isArray(sample.comments) && sample.comments.length) {
          reportData = await execute('reviews-summary', '总结已保存低星评论', async () => {
            const { result, ref } = await archived(
              c,
              'reviews-summary',
              'micros',
              bounds.terra,
              (credentials) =>
                reviewSummaryRequest(
                  { ...env, ...credentials },
                  sample as ReturnType<typeof parseReviewSample>,
                ),
            )
            return {
              summary: '低星评论总结已保存',
              result: parseReviewSummary(result, sample as ReturnType<typeof parseReviewSample>),
              evidenceRef: ref,
            }
          })
        } else reportData = { ...sample, summary: null }
      } else {
        reportData = await execute('reviews-source', '读取 Amazon 已授权评论主题', async () => {
          const { credentials } = await providerCredentials(env, 'amazon')
          const caller = {
            owner: c.job.actor,
            runId: id,
            attempt: c.attempt,
            shouldContinue: async () => {
              await assertAssistantChildActive(env.DB, id)
              return true
            },
            beforeSend: () => claimAssistantCall(env.DB, id),
          }
          const result = await dispatch(env.DB, 'catalog', caller, () =>
            new AmazonUS(credentials, undefined, env.DB, caller).reviewTopics(externalId),
          )
          const ref = 'jobs/' + id + '/v1/reviews-source.json'
          await env.ARCHIVE.put(ref, JSON.stringify(result), {
            httpMetadata: { contentType: 'application/json' },
          })
          return { summary: 'Amazon 评论主题已保存', result, evidenceRef: ref }
        })
      }
      await step.do('save-review-report', async () => {
        const report = {
          platform,
          id: externalId,
          updatedAt: new Date().toISOString(),
          data: reportData,
        }
        const saved = await env.DB.prepare(
          'UPDATE product_review_reports SET report_json=?,updated_at=?,lease_id=NULL,lease_until=0 WHERE product_key=? AND lease_id=?',
        )
          .bind(JSON.stringify(report), Date.now(), key, id)
          .run()
        if (!saved.meta.changes) throw new Error('评论报告保存权已变化，费用与步骤已保留。')
      })
      if (reportData.modelIssue) issue = String(reportData.modelIssue)
      summary = issue
        ? '评论样本已保存，总结资料不足；未写入观察池。'
        : '已保存指定商品的评论资料与分析；未写入观察池。'
    } else throw new Error('不支持的在线补查动作。')
  } catch (error) {
    issue = error instanceof Error ? error.message : '在线动作未完成，已保留费用和归档。'
  }
  if (operation === 'reviews_refresh' && productId)
    await step.do('release-review-report-lease', async () => {
      await env.DB.prepare(
        'UPDATE product_review_reports SET lease_id=NULL,lease_until=0 WHERE lease_id=?',
      )
        .bind(id)
        .run()
      return true
    })
  await step.do('finish-specialized-operation', () =>
    finish(env, id, c.attempt, !issue, issue || summary),
  )
  return { summary, issue }
}
