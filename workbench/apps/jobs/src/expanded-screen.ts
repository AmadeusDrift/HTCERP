import type { WorkflowStep } from 'cloudflare:workers'
import { AmazonUS } from '../../../packages/amazon/adapter'
import { providerCredentials, type ConnectionBindings } from '../../../packages/connections/credentials'

export interface Seed { productId: string; query: string }
export async function expandedScreen(env: ConnectionBindings, runId: string, seeds: Seed[], step: WorkflowStep) {
  if (!seeds.length || seeds.length > 50 || seeds.some(s => !s.query.trim() || s.query.length > 160) ||
    new Set(seeds.map(s=>s.productId)).size !== seeds.length) throw new Error('Invalid expansion request')
  const known = await env.DB.prepare(`SELECT COUNT(*) n FROM job_seen WHERE run_id=? AND product_id IN
    (SELECT json_extract(value,'$.productId') FROM json_each(?))`).bind(runId,JSON.stringify(seeds)).first<{n:number}>()
  if(known?.n!==seeds.length) throw new Error('Source product outside archived discovery')
  const source=await env.DB.prepare('SELECT actor FROM job_runs WHERE id=?').bind(runId).first<{actor:string}>()
  const api = new AmazonUS((await providerCredentials(env,'amazon')).credentials, undefined, env.DB,{owner:source!.actor,runId})
  const matches = []
  const retry = { retries: {limit:3,delay:'15 seconds' as const,backoff:'exponential' as const} }
  for(const seed of seeds){
    const items=await step.do('catalog-'+seed.productId,retry,async()=>(await api.search(seed.query,10)).items.map(({asin,title})=>({asin,title})))
    matches.push({...seed,items})
  }
  const ids=[...new Set(matches.flatMap(m=>m.items.map(p=>p.asin)))]
  const offers=[]
  for(let offset=0;offset<ids.length;offset+=20){
    offers.push(...await step.do('offers-'+offset,retry,async()=>Array.from(await api.batchOffers(ids.slice(offset,offset+20)),([asin,offer])=>({asin,...offer}))))
  }
  return { runId, checkedAt:new Date().toISOString(), matches, offers }
}
