/// <reference types="bun-types" />
/** Reviewer-owned AI-Q2 real PostgreSQL tests. Runs in BOTH Full and Lite.
 * Implementation agent must not edit this file.
 *
 * Service contract:
 * getAiUsageState(tenantId, now?)
 * reserveAiReply({tenantId,conversationId,visitorMessageId,now?})
 * commitAiReply({tenantId,reservationId,conversationId,text,source,now?})
 * releaseAiReply({tenantId,reservationId})
 *
 * Models: AiUsagePeriod (tenantId,periodStart,periodEnd,used,reserved)
 * and AiReplyReservation (tenantId,visitorMessageId,conversationId,status).
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb} from '@/lib/db'
import {ensurePlansSeeded} from '@/lib/payments/plans'
import {getTenantUsage} from '@/lib/payments/gating'
import {resolveAiUsageWindow} from '@/lib/ai/usage-policy'
import {getAiUsageState,reserveAiReply,commitAiReply,releaseAiReply} from '@/lib/ai/usage-service'
const run=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
let seq=0
const owned:string[]=[]
const next=()=>run+'-'+(++seq)
async function tenant(plan:'free'|'pro'|'max'|'self-hosted'='pro') {
  const row=await globalDb.tenant.create({data:{name:'AI Q2 '+next(),slug:'ai-q2-'+next(),plan},select:{id:true}})
  owned.push(row.id)
  return row.id
}
async function conversation(tenantId:string) {
  const contact=await globalDb.contact.create({data:{
    tenantId,identifier:'visitor-'+next(),identifierType:'visitorId',metadata:{},
  },select:{id:true}})
  const row=await globalDb.conversation.create({data:{tenantId,contactId:contact.id,tags:[]},select:{id:true}})
  return row.id
}
async function inbound(tenantId:string,conversationId:string,text='Real visitor message') {
  const m=await globalDb.message.create({data:{
    tenantId,conversationId,senderType:'contact',contentType:'text',content:{text},status:'sent',
  },select:{id:true}})
  return m.id
}
const reserve=(tenantId:string,conversationId:string,visitorMessageId:string,now?:Date)=>
  reserveAiReply({tenantId,conversationId,visitorMessageId,now})
const commit=(tenantId:string,reservationId:string,conversationId:string,text='Actual stored FAQ answer',now?:Date)=>
  commitAiReply({tenantId,reservationId,conversationId,text,source:'faq',now})
beforeAll(async()=>{await ensurePlansSeeded()})
afterAll(async()=>{for(const id of owned.reverse())await globalDb.tenant.delete({where:{id}}).catch(()=>{})})

describe('Reviewer AI-Q2 — real database and atomic billable replies',()=>{
  test('Pro has 1400 capacity and starts with zero charges',async()=>{
    const tid=await tenant('pro')
    expect(await getAiUsageState(tid)).toMatchObject({planSlug:'pro',used:0,reserved:0,limit:1400,remaining:1400})
  })
  test('one persisted AI reply charges one unit and Billing reports exactly the same count',async()=>{
    const tid=await tenant(),conv=await conversation(tid),mid=await inbound(tid,conv)
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    expect(await getAiUsageState(tid)).toMatchObject({used:0,reserved:1,remaining:1399})
    const c=await commit(tid,r.reservationId,conv)
    expect(c.status).toBe('committed')
    if(c.status!=='committed')throw Error('Commit not persisted')
    const m=await globalDb.message.findUnique({where:{id:c.messageId}})
    expect(m).toMatchObject({tenantId:tid,conversationId:conv,senderType:'ai',status:'sent'})
    expect(m?.content).toMatchObject({text:'Actual stored FAQ answer',source:'faq'})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,reserved:0,remaining:1399})
    expect((await getTenantUsage(tid)).usage.aiActions).toEqual({current:1,limit:1400})
  })
  test('failed generation releases capacity and does not charge or persist AI answer',async()=>{
    const tid=await tenant(),conv=await conversation(tid),mid=await inbound(tid,conv)
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await releaseAiReply({tenantId:tid,reservationId:r.reservationId})
    await releaseAiReply({tenantId:tid,reservationId:r.reservationId})
    expect(await getAiUsageState(tid)).toMatchObject({used:0,reserved:0,remaining:1400})
    expect(await globalDb.message.count({where:{tenantId:tid,senderType:'ai'}})).toBe(0)
  })
  test('same visitor message cannot reserve twice or create/charge twice on retry',async()=>{
    const tid=await tenant(),conv=await conversation(tid),mid=await inbound(tid,conv)
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    const again=await reserve(tid,conv,mid)
    expect(['reserved','in_progress'].includes(again.status)).toBe(true)
    expect(await globalDb.aiReplyReservation.count({where:{tenantId:tid,visitorMessageId:mid}})).toBe(1)
    const one=await commit(tid,r.reservationId,conv)
    const two=await commit(tid,r.reservationId,conv)
    expect(one.status).toBe('committed')
    expect(two.status).toBe('committed')
    if(one.status!=='committed'||two.status!=='committed')throw Error('Non-idempotent')
    expect(one.messageId).toBe(two.messageId)
    expect((await reserve(tid,conv,mid)).status).toBe('already_committed')
    expect(await globalDb.message.count({where:{tenantId:tid,senderType:'ai'}})).toBe(1)
    expect(await getAiUsageState(tid)).toMatchObject({used:1,reserved:0})
  })
  test('Free AI quota 0 blocks automatic reply but preserves the visitor message',async()=>{
    const tid=await tenant('free'),conv=await conversation(tid),mid=await inbound(tid,conv)
    expect((await reserve(tid,conv,mid)).status).toBe('limit_reached')
    expect(await getAiUsageState(tid)).toMatchObject({limit:0,remaining:0,used:0})
    expect(await globalDb.message.count({where:{tenantId:tid,senderType:'contact'}})).toBe(1)
  })
  test('Max capacity is 10000, not the Pro limit',async()=>{
    const tid=await tenant('max'),conv=await conversation(tid),mid=await inbound(tid,conv)
    expect(await getAiUsageState(tid)).toMatchObject({planSlug:'max',limit:10000,remaining:10000})
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv)
    expect(await getAiUsageState(tid)).toMatchObject({used:1,reserved:0,remaining:9999})
  })
  test('12 real concurrent reservations for ONE remaining Pro slot admit exactly ONE',async()=>{
    const tid=await tenant(),conv=await conversation(tid),now=new Date()
    const p=resolveAiUsageWindow(now,null)!
    await globalDb.aiUsagePeriod.create({data:{
      tenantId:tid,periodStart:p.start,periodEnd:p.end,used:1399,reserved:0,
    }})
    const ids=await Promise.all(Array.from({length:12},(_,i)=>inbound(tid,conv,'Race '+i)))
    const results=await Promise.all(ids.map(id=>reserve(tid,conv,id,now)))
    expect(results.filter(x=>x.status==='reserved')).toHaveLength(1)
    expect(results.filter(x=>x.status==='limit_reached')).toHaveLength(11)
    expect(await getAiUsageState(tid,now)).toMatchObject({used:1399,reserved:1,remaining:0})
    const winner=results.find(x=>x.status==='reserved')
    if(!winner||winner.status!=='reserved')throw Error('No winner')
    await commit(tid,winner.reservationId,conv)
    expect(await getAiUsageState(tid,now)).toMatchObject({used:1400,reserved:0,remaining:0})
    expect(await globalDb.message.count({where:{tenantId:tid,senderType:'ai'}})).toBe(1)
  })
  test('tenant B cannot settle a reservation belonging to tenant A',async()=>{
    const a=await tenant(),b=await tenant(),conv=await conversation(a),mid=await inbound(a,conv)
    const r=await reserve(a,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    const fake=await commit(b,r.reservationId,conv)
    expect(fake.status).toBe('not_found')
    expect(await getAiUsageState(b)).toMatchObject({used:0,reserved:0})
    await commit(a,r.reservationId,conv)
    expect(await getAiUsageState(a)).toMatchObject({used:1,reserved:0})
  })
  test('historical AI messages are backfilled exactly once, not reset on deployment',async()=>{
    const tid=await tenant(),conv=await conversation(tid)
    await globalDb.message.create({data:{
      tenantId:tid,conversationId:conv,senderType:'ai',contentType:'text',
      content:{text:'Legacy response',source:'faq'},status:'sent',
    }})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,remaining:1399})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,remaining:1399})
    const mid=await inbound(tid,conv),r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv)
    expect(await getAiUsageState(tid)).toMatchObject({used:2,remaining:1398})
  })
  test('a future UTC calendar month starts fresh while previous consumption remains recorded',async()=>{
    const tid=await tenant(),conv=await conversation(tid),now=new Date()
    const nextMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,2))
    const mid=await inbound(tid,conv),r=await reserve(tid,conv,mid,now)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv,'Current period response',now)
    expect(await getAiUsageState(tid,now)).toMatchObject({used:1})
    expect(await getAiUsageState(tid,nextMonth)).toMatchObject({used:0,reserved:0,remaining:1400})
  })
  test('active subscription dates override calendar month and expiry fails closed',async()=>{
    const tid=await tenant(),now=new Date()
    const start=new Date(now.getTime()-86400000),end=new Date(now.getTime()+35*86400000)
    const p=await globalDb.plan.findUnique({where:{slug:'pro'},select:{id:true}})
    expect(p).toBeTruthy()
    await globalDb.subscription.create({data:{
      tenantId:tid,planId:p!.id,status:'active',gateway:'zarinpal',
      currentPeriodStart:start,currentPeriodEnd:end,
    }})
    const usage=await getAiUsageState(tid,now)
    expect(usage.periodStart).toEqual(start)
    expect(usage.periodEnd).toEqual(end)
    expect(usage.planSlug).toBe('pro')
    expect((await getAiUsageState(tid,new Date(end.getTime()))).remaining).toBe(0)
  })
  test('Pro to Free and back in the same calendar window preserves used count',async()=>{
    const tid=await tenant(),conv=await conversation(tid),mid=await inbound(tid,conv)
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv)
    await globalDb.tenant.update({where:{id:tid},data:{plan:'free'}})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,limit:0,remaining:0})
    await globalDb.tenant.update({where:{id:tid},data:{plan:'pro'}})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,limit:1400,remaining:1399})
  })
  test('visitor and human-agent messages never increase AI consumption',async()=>{
    const tid=await tenant(),conv=await conversation(tid)
    await inbound(tid,conv)
    await globalDb.message.create({data:{
      tenantId:tid,conversationId:conv,senderType:'agent',contentType:'text',
      content:{text:'Human message'},status:'sent',
    }})
    expect(await getAiUsageState(tid)).toMatchObject({used:0,reserved:0,remaining:1400})
  })
  test('releasing an already committed reservation never refunds a delivered reply',async()=>{
    const tid=await tenant(),conv=await conversation(tid),mid=await inbound(tid,conv)
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv)
    await releaseAiReply({tenantId:tid,reservationId:r.reservationId})
    expect(await getAiUsageState(tid)).toMatchObject({used:1,reserved:0})
  })
  test('self-hosted unlimited still records successful replies for diagnostics',async()=>{
    const tid=await tenant('self-hosted'),conv=await conversation(tid),mid=await inbound(tid,conv)
    expect(await getAiUsageState(tid)).toMatchObject({limit:-1,remaining:null})
    const r=await reserve(tid,conv,mid)
    expect(r.status).toBe('reserved')
    if(r.status!=='reserved')throw Error('No reservation')
    await commit(tid,r.reservationId,conv)
    expect(await getAiUsageState(tid)).toMatchObject({used:1,reserved:0,remaining:null})
  })
})
