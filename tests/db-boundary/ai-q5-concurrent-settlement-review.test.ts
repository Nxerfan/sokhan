/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q5: real concurrent PostgreSQL transaction order.
 * IMMUTABLE reviewer acceptance. No mocks, no test-only app bypass.
 *
 * Earlier Q5 tests modify human state BEFORE calling commitAiReply. Those
 * checks do NOT prove safety when assignment or human reply commits AFTER
 * the AI settlement transaction has already checked eligibility but BEFORE
 * the AI Message / billing transaction commits.
 *
 * The tests use an actual PostgreSQL row lock on the usage-period record.
 * The test waits for pg_stat_activity to prove that the AI settlement has
 * reached its final usage UPDATE and is blocked by our exact lock-holder PID.
 * Then it completes the real human action before letting settlement finish.
 * No timing-only success or background race assumptions.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {reserveAiReply,commitAiReply,getAiUsageState}
  from '../../src/lib/ai/usage-service'

const marker=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
const tenants:string[]=[]
let personId=''
let seq=0

beforeAll(async()=>{
  await ensurePlansSeeded()
  personId=(await globalDb.user.create({data:{email:'q5-review-concurrent-'+marker+'@test.com'},
    select:{id:true}})).id
})
afterAll(async()=>{
  for(const tid of tenants.reverse())await globalDb.tenant.delete({where:{id:tid}}).catch(()=>{})
  if(personId)await globalDb.user.delete({where:{id:personId}}).catch(()=>{})
})
async function fixture(){
  const idx=++seq
  const tid=(await globalDb.tenant.create({data:{
    name:'Q5 Concurrent Reviewer '+marker+' '+idx,
    slug:'q5-concurrent-'+marker+'-'+idx,plan:'pro',
  },select:{id:true}})).id
  tenants.push(tid)
  const contact=(await globalDb.contact.create({data:{
    tenantId:tid,identifier:'q5-reviewer-'+marker+'-'+idx,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const convId=(await globalDb.conversation.create({data:{
    tenantId:tid,contactId:contact,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  const visitorMessageId=(await globalDb.message.create({data:{
    tenantId:tid,conversationId:convId,senderType:'contact',
    contentType:'text',content:{text:'قیمت چراغ مطالعه'},status:'sent',
  },select:{id:true}})).id
  const r=await reserveAiReply({tenantId:tid,conversationId:convId,visitorMessageId})
  expect(r.status).toBe('reserved')
  if(r.status!=='reserved')throw Error('AI reservation not available')
  const stored=await globalDb.aiReplyReservation.findUniqueOrThrow({
    where:{id:r.reservationId},select:{usagePeriodId:true},
  })
  return {tid,convId,reservationId:r.reservationId,periodId:stored.usagePeriodId}
}
type Fixture=Awaited<ReturnType<typeof fixture>>

async function waitForRealDbBlock(blockerPid:number){
  const deadline=Date.now()+8000
  while(Date.now()<deadline){
    const rows=await globalDb.$queryRaw<Array<{pid:number,query:string}>>`
      SELECT pid, query FROM pg_stat_activity
      WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
        AND wait_event_type = 'Lock'
    `
    if(rows.some(x=>x.query.includes('AiUsagePeriod')))return
    // Poll the DB-observed lock dependency, never infer sequencing from time.
    await Bun.sleep(25)
  }
  throw Error('AI commit did not reach its blocked usage-period UPDATE')
}
async function raceHumanAction(
  f:Fixture,
  mutate:()=>Promise<unknown>,
){
  let announceLock!: (pid:number)=>void
  let unlock!:()=>void
  const acquired=new Promise<number>(resolve=>{announceLock=resolve})
  const released=new Promise<void>(resolve=>{unlock=resolve})
  const lockTask=globalDb.$transaction(async tx=>{
    const pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid
    const locked=await tx.$queryRaw<Array<{id:string}>>`
      SELECT "id" FROM "AiUsagePeriod" WHERE "id" = ${f.periodId} FOR UPDATE
    `
    expect(locked).toHaveLength(1)
    announceLock(pid)
    await released
  },{timeout:15000,maxWait:10000})

  const blockerPid=await acquired
  let attempted=false
  let attempt:Promise<Awaited<ReturnType<typeof commitAiReply>>>|undefined
  try{
    attempt=commitAiReply({
      tenantId:f.tid,reservationId:f.reservationId,conversationId:f.convId,
      text:'AI reply must not be committed AFTER human takeover',source:'product',
    })
    attempted=true
    await waitForRealDbBlock(blockerPid)
    // The AI guard has already passed and its transaction is unable to
    // commit while our lock is held. Mutate HUMAN state NOW, then unlock.
    await mutate()
  }finally{
    unlock()
    await lockTask
  }
  if(!attempted || !attempt)throw Error('AI commit not attempted')
  const result=await attempt
  expect(result.status,'AI settlement must be serialized behind committed human takeover').toBe('not_found')
  const aiMessages=await globalDb.message.findMany({
    where:{tenantId:f.tid,conversationId:f.convId,senderType:'ai'},
    select:{id:true},
  })
  expect(aiMessages).toEqual([])
  const usage=await getAiUsageState(f.tid)
  expect(usage.used).toBe(0)
}

describe('Reviewer AI-Q5 — actual overlapping human/AI transaction race',()=>{
  test('human assignment commits while AI settlement is blocked, AI must not subsequently commit',async()=>{
    const f=await fixture()
    await raceHumanAction(f,async()=>{
      const changed=await globalDb.conversation.update({where:{id:f.convId},
        data:{assignedUserId:personId}})
      expect(changed.assignedUserId).toBe(personId)
    })
  })
  test('human message commits while AI settlement is blocked, AI must not subsequently commit',async()=>{
    const f=await fixture()
    await raceHumanAction(f,async()=>{
      const msg=await globalDb.message.create({data:{
        tenantId:f.tid,conversationId:f.convId,senderType:'agent',
        senderUserId:personId,contentType:'text',content:{text:'انسان پاسخ داد'},status:'sent',
      }})
      expect(msg.senderType).toBe('agent')
    })
  })
  test('rejected AI settlement immediately frees reserved quota, not only after 5-minute lease',async()=>{
    const f=await fixture()
    const before=await getAiUsageState(f.tid)
    expect(before).toMatchObject({used:0,reserved:1})
    await globalDb.conversation.update({where:{id:f.convId},
      data:{assignedUserId:personId}})
    const result=await commitAiReply({
      tenantId:f.tid,reservationId:f.reservationId,conversationId:f.convId,
      text:'Must never commit after agent assignment',source:'product',
    })
    expect(result.status).toBe('not_found')
    expect(await globalDb.message.count({
      where:{tenantId:f.tid,conversationId:f.convId,senderType:'ai'},
    })).toBe(0)
    const after=await getAiUsageState(f.tid)
    expect(after).toMatchObject({used:0,reserved:0})
    const reservation=await globalDb.aiReplyReservation.findUniqueOrThrow({
      where:{id:f.reservationId},select:{status:true},
    })
    expect(reservation.status).toBe('released')
  })
})
