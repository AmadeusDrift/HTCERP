import { z } from 'zod'
import type { Bindings } from '../../apps/api/src/bindings'
import { PublicError } from '../contracts/errors'
import { currentStrategy } from '../operations/model'

const filters = z.object({
  platform:z.enum(['temu','amazon']), keyword:z.string().trim().max(150),
  maxPrice:z.number().min(0).max(1_000_000).nullable(),
  minSold:z.number().int().min(0).max(1_000_000_000),
  category:z.enum(['all','home']),
}).strict()
export const planSchema=filters.extend({pages:z.number().int().min(1).max(20),mode:z.enum(['cache','live'])})
export type AgentPlan=z.infer<typeof planSchema>
type Result={answer:string;plan?:AgentPlan;jobId?:string}
const properties={
  platform:{type:'string',enum:['temu','amazon']},keyword:{type:'string',description:'未指定时为空字符串'},
  maxPrice:{type:['number','null'],description:'来源平台美元价格上限，未指定时为 null'},
  minSold:{type:'integer',description:'累计销量下限，未指定为 0'},
  category:{type:'string',enum:['all','home'],description:'home 仅用于 Temu 家居'},
}
function tool(name:string,description:string,fields:Record<string,unknown>){
  return {type:'function',function:{name,description,parameters:{type:'object',properties:fields,required:Object.keys(fields),additionalProperties:false}}}
}
export const agentTools=[
  tool('search_inventory','按用户条件实际查询美国站商品库，不消耗供应商积分。',properties),
  tool('my_jobs','查当前用户自己的选品任务、进度和最近结果。',{}),
  tool('prepare_discovery','把明确的选品需求整理为待确认的任务。用户未指定实时查询时选 cache，不自行扩大范围。',{
    ...properties,pages:{type:'integer',minimum:1,maximum:20},mode:{type:'string',enum:['cache','live']},
  }),
]
export async function runAgentTool(env:Bindings,actor:{email:string;role:string},name:string,args:unknown):Promise<Result>{
  if(name==='my_jobs'){
    const rows=await env.DB.prepare(`SELECT id,title,status,summary FROM job_runs WHERE actor=? ORDER BY created_at DESC LIMIT 5`)
      .bind(actor.email).all<{id:string;title:string;status:string;summary:string}>()
    const labels:Record<string,string>={queued:'排队中',running:'执行中',succeeded:'已完成',partial:'部分完成',failed:'未完成',paused:'已暂停',cancelled:'已取消'}
    return {answer:rows.results.map(r=>r.title+' · '+(labels[r.status]??r.status)+(r.summary?'\n'+r.summary:'')).join('\n\n')||'你还没有选品任务。',jobId:rows.results[0]?.id}
  }
  if(name!=='prepare_discovery' && name!=='search_inventory') throw new PublicError('INVALID_INPUT','这项操作暂不支持。',400)
  const f=filters.parse(name==='prepare_discovery'?filters.strip().parse(args):args)
  if(f.platform==='amazon' && f.category==='home') throw new PublicError('INVALID_INPUT','请提供 Amazon 商品关键词；Temu 家居类目不能跨平台套用。',400)
  if(name==='search_inventory'){
    const where=` FROM products WHERE platform=? AND market='US' AND (?='' OR instr(lower(coalesce(title_cn,'')||' '||title),lower(?))>0)
      AND (? IS NULL OR (currency='USD' AND min_price<=?)) AND (?=0 OR total_sold>=?)
      AND (?='all' OR category_id IN (SELECT category_id FROM category_mappings WHERE group_key='home' AND platform=?))`
    const binds=[f.platform,f.keyword,f.keyword,f.maxPrice,f.maxPrice,f.minSold,f.minSold,f.category,f.platform]
    const rows=await env.DB.prepare("SELECT COUNT(*) OVER() n,coalesce(nullif(title_cn,''),title) title,min_price,total_sold"+where+' ORDER BY total_sold DESC,id LIMIT 5')
      .bind(...binds).all<{n:number;title:string;min_price:number|null;total_sold:number|null}>()
    return {answer:'已查商品库，符合条件 '+(rows.results[0]?.n??0)+' 款。'+rows.results.map((r,i)=>'\n'+(i+1)+'. '+r.title.slice(0,64)+' · '+(r.min_price==null?'价格待核':'$'+r.min_price)+' · 累计销量 '+(r.total_sold??'未知')).join('')}
  }
  if(actor.role==='viewer') throw new PublicError('FORBIDDEN','当前账号仅可查询，不能创建选品任务。',403)
  const plan=planSchema.parse(args)
  if(plan.platform==='amazon'&&plan.pages>10) throw new PublicError('INVALID_INPUT','Amazon 每组条件最多查 10 页。',400)
  if(plan.mode==='live'&&plan.platform==='temu'&&!plan.keyword&&plan.category==='all') throw new PublicError('INVALID_INPUT','在线查 Temu 需要一个关键词或类目。',400)
  const {settings}=await currentStrategy(env.DB)
  const cap=plan.mode==='live'?plan.pages*10:0
  return {plan,answer:[plan.platform==='temu'?'Temu 美国站':'Amazon 美国站',plan.category==='home'?'家居':'全部类目',plan.keyword||'不限关键词',
    plan.maxPrice===null?'不限价格':'不超过 $'+plan.maxPrice,'累计销量至少 '+plan.minSold+' 件',
    plan.mode==='live'?'在线检索最多 '+plan.pages+' 页，数据上限 '+cap+' 积分，团队每日上限 '+settings.dataDailyPoints+' 积分':'使用已有商品资料，0 积分'].join(' · ')}
}
