import type { ConnectionBindings } from '../../../packages/connections/credentials'
import type { AccessBindings, Actor } from './access'
export interface Bindings extends AccessBindings, ConnectionBindings {
  ARCHIVE: R2Bucket
  RUNNER: Workflow<{ runId: string }>
  ASSETS: Fetcher
}
export type AppEnv = { Bindings: Bindings; Variables: { actor: Actor; requestId: string } }
