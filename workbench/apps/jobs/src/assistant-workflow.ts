import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { advanceAssistantRun } from '../../../packages/assistant/loop'
import type { AssistantBindings } from '../../../packages/assistant/runs'

export class AssistantWorkflow extends WorkflowEntrypoint<
  AssistantBindings,
  { runId: string; attempt: number }
> {
  async run(event: WorkflowEvent<{ runId: string; attempt: number }>, step: WorkflowStep) {
    // 12 model + 24 tool checkpoints, plus report delivery. The D1 limits remain authoritative.
    for (let index = 0; index < 600; index++) {
      const outcome = await step.do(
        'assistant-action-' + index,
        // Paid sends are protected by persisted markers; retries recover failed D1/wake handoffs.
        { retries: { limit: 2, delay: '5 seconds' }, timeout: '25 minutes' },
        () => advanceAssistantRun(this.env, event.payload.runId, event.payload.attempt),
      )
      if (!outcome.continue) return outcome
      if (outcome.sleep) await step.sleep('assistant-wait-' + index, '10 seconds')
    }
    return { continue: false, status: 'partial' }
  }
}
