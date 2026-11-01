import { PublicError } from '../contracts/errors'

export type DispatchIdentity = {owner:string;runId?:string;attempt?:number}
type Lane = 'geekbi'|'ai'|'catalog'|'pricing'
const now = "unixepoch()"
const sleep = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

// Only one holder per service. A crashed holder expires; waiting requests renew their own ticket.
export async function dispatch<T>(db:D1Database,lane:Lane,who:DispatchIdentity,action:()=>Promise<T>):Promise<T>{
  const token=crypto.randomUUID()
  await db.prepare(`DELETE FROM service_tickets WHERE expires<=${now}`).run()
  await db.prepare(`INSERT INTO service_tickets(token,lane,owner,run_id,attempt,expires)
    VALUES(?,?,?,?,?,${now}+120)`).bind(token,lane,who.owner,who.runId??null,who.attempt??null).run()
  try{
    for(;;){
      const live=await db.prepare(`UPDATE service_tickets SET expires=${now}+120 WHERE token=? AND expires>${now}
        ${who.attempt===undefined?'':"AND EXISTS(SELECT 1 FROM job_runs j WHERE j.id=service_tickets.run_id AND j.status='running' AND j.attempt=service_tickets.attempt)"} RETURNING id`).bind(token).first()
      if(!live) throw new PublicError('CONFLICT','排队已结束，任务已暂停、取消或过期。',409)
      const grant=await db.prepare(`UPDATE service_tickets SET active=1 WHERE token=? AND
        NOT EXISTS(SELECT 1 FROM service_tickets WHERE lane=? AND active=1 AND expires>${now})
        AND id=(SELECT t.id FROM service_tickets t LEFT JOIN service_turns h ON h.lane=t.lane AND h.owner=t.owner
        WHERE t.lane=? AND t.active=0 AND t.expires>${now}
        ORDER BY t.priority DESC, COALESCE(h.turn,0),t.id LIMIT 1) RETURNING id`).bind(token,lane,lane).first()
      if(grant) break
      await sleep(1000)
    }
    const heartbeat=setInterval(()=>{void db.prepare(`UPDATE service_tickets SET expires=${now}+120 WHERE token=?`).bind(token).run().catch(()=>{})},30000)
    const started=Date.now()
    try{return await action()}finally{
      clearInterval(heartbeat)
      await db.batch([
        db.prepare('INSERT INTO dispatch_durations(lane,seconds) VALUES(?,?)').bind(lane,Math.max(1,Math.ceil((Date.now()-started)/1000))),
        db.prepare('DELETE FROM dispatch_durations WHERE lane=? AND id NOT IN (SELECT id FROM dispatch_durations WHERE lane=? ORDER BY id DESC LIMIT 20)').bind(lane,lane)
      ])
    }
  }finally{
    await db.prepare('DELETE FROM service_tickets WHERE token=?').bind(token).run()
  }
}
