/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q6 real PostgreSQL acceptance — IMMUTABLE.
 * Requires an additive ConversationHandoffSummary model and real tenant-safe
 * ensureConversationHandoffSummary(conversationId) service.
 * Never mock Prisma or AI usage. No LLM, no reserveAiReply or commitAiReply.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {getAiUsageState} from '../../src/lib/ai/usage-service'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const stamp=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)
const tenants:string[]=[]
let userId='',counter=0
const oldTime=new Date('2026-11-05T09:00:00.000Z')
const aiTime=new Date('2026-11-05T09:00:01.000Z')
const laterTime=new Date('2026-11-05T09:01:00.000Z')

beforeAll(async()=>{
  await ensurePlansSeeded()
  userId=(await globalDb.user.create({data:{email:'q6-reviewer-'+stamp+'@test.com'},select:{id:true}})).id
})
afterAll(async()=>{
  for(const tenantId of tenants.reverse())await globalDb.tenant.delete({where:{id:tenantId}}).catch(()=>{})
  if(userId)await globalDb.user.delete({where:{id:userId}}).catch(()=>{})
})
async function setup(plan:'pro'|'max'|'self-hosted'|'free'='pro',withAi=true){
  const n=++counter
  const tenantId=(await globalDb.tenant.create({data:{
    slug:'q6-reviewer-'+stamp+'-'+n,name:'Q6 REVIEW '+n,plan,
  },select:{id:true}})).id
  tenants.push(tenantId)
  const contact=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-review-'+stamp+'-'+n,identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId:contact,status:'open',tags:[],channel:'widget',
  },select:{id:true}})).id
  const visitor=await globalDb.message.create({data:{
    tenantId,conversationId,senderType:'contact',contentType:'text',
    content:{text:'موجودی ماوس اطلس چطور است؟'},status:'sent',createdAt:oldTime,
  }})
  let aiId:string|null=null
  if(withAi){
    const reply=await globalDb.message.create({data:{
      tenantId,conversationId,senderType:'ai',contentType:'text',
      content:{text:'ماوس اطلس موجود است، قیمت ۲۴۰۰۰۰ تومان',source:'product'},
      status:'sent',createdAt:aiTime,
    }})
    aiId=reply.id
  }
  return {tenantId,conversationId,visitorId:visitor.id,aiId}
}
async function assignment(cid:string){
  await globalDb.conversation.update({where:{id:cid},data:{assignedUserId:userId}})
}
async function summarize(f:Awaited<ReturnType<typeof setup>>){
  return withTenant(f.tenantId,()=>ensureConversationHandoffSummary(f.conversationId))
}
async function rows(f:Awaited<ReturnType<typeof setup>>){
  return globalDb.conversationHandoffSummary.findMany({where:{
    tenantId:f.tenantId,conversationId:f.conversationId,
  }})
}

describe('Reviewer AI-Q6 — real, free-of-charge handoff persistence',()=>{
  test('assigned Pro conversation generates one persisted grounded summary with source IDs',async()=>{
    const f=await setup('pro');await assignment(f.conversationId)
    const out=await summarize(f)
    expect(out).not.toBeNull()
    const r=await rows(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('ماوس اطلس')
    expect(r[0].summaryText).toContain('۲۴۰۰۰۰')
    expect(r[0].sourceMessageIds).toEqual([f.visitorId,f.aiId])
    expect(r[0].tenantId).toBe(f.tenantId)
  })
  test('no summary before a verified human takeover, despite existing AI messages',async()=>{
    const f=await setup()
    expect(await summarize(f)).toBeNull()
    expect(await rows(f)).toHaveLength(0)
  })
  test('no summary when AI has not answered; no fabricated AI portion',async()=>{
    const f=await setup('pro',false);await assignment(f.conversationId)
    expect(await summarize(f)).toBeNull()
    expect(await rows(f)).toHaveLength(0)
  })
  test('Free plan cannot create Q6 summary; Max and Self-hosted are eligible',async()=>{
    const free=await setup('free');await assignment(free.conversationId)
    expect(await summarize(free)).toBeNull()
    expect(await rows(free)).toHaveLength(0)
    for(const plan of ['max','self-hosted'] as const){
      const f=await setup(plan);await assignment(f.conversationId)
      expect(await summarize(f)).not.toBeNull()
      expect(await rows(f)).toHaveLength(1)
    }
  })
  test('actual first human reply is a takeover event even without assignment or firstResponseAt',async()=>{
    const f=await setup('pro')
    await globalDb.message.create({data:{
      tenantId:f.tenantId,conversationId:f.conversationId,
      senderType:'agent',senderUserId:userId,contentType:'text',status:'sent',
      content:{text:'اپراتور پاسخ می‌دهد و این متن نباید در خلاصه باشد'},createdAt:laterTime,
    }})
    const out=await summarize(f)
    expect(out).not.toBeNull()
    const r=await rows(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).not.toContain('اپراتور پاسخ می‌دهد')
  })
  test('takeover cut-off excludes visitor and AI messages persisted AFTER takeover',async()=>{
    const f=await setup('pro');await assignment(f.conversationId)
    const original=await summarize(f)
    expect(original).not.toBeNull()
    await globalDb.message.createMany({data:[
      {tenantId:f.tenantId,conversationId:f.conversationId,senderType:'contact',
       contentType:'text',content:{text:'AFTER_TAKEOVER_PRIVATE_VISITOR'},status:'sent',createdAt:laterTime},
      {tenantId:f.tenantId,conversationId:f.conversationId,senderType:'ai',
       contentType:'text',content:{text:'AFTER_TAKEOVER_FORGED_AI'},status:'sent',createdAt:laterTime},
    ]})
    await summarize(f)
    const r=await rows(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).not.toContain('AFTER_TAKEOVER_PRIVATE_VISITOR')
    expect(r[0].summaryText).not.toContain('AFTER_TAKEOVER_FORGED_AI')
    expect(r[0].sourceMessageIds).toEqual([f.visitorId,f.aiId])
  })
  test('parallel competing takeover attempts persist exactly one summary, unchanged',async()=>{
    const f=await setup('pro');await assignment(f.conversationId)
    const attempts=await Promise.all(Array.from({length:12},()=>summarize(f)))
    expect(attempts.every(x=>x!==null)).toBe(true)
    const r=await rows(f)
    expect(r).toHaveLength(1)
    const before={summaryText:r[0].summaryText,sourceMessageIds:r[0].sourceMessageIds}
    await summarize(f)
    const after=await rows(f)
    expect(after).toHaveLength(1)
    expect(after[0].summaryText).toBe(before.summaryText)
    expect(after[0].sourceMessageIds).toEqual(before.sourceMessageIds)
  })
  test('foreign conversation ID is denied; no cross-tenant summary access or mutation',async()=>{
    const own=await setup('pro'),foreign=await setup('pro')
    await assignment(foreign.conversationId)
    expect(await withTenant(own.tenantId,
      ()=>ensureConversationHandoffSummary(foreign.conversationId))).toBeNull()
    expect(await rows(foreign)).toHaveLength(0)
    expect(await summarize(foreign)).not.toBeNull()
    expect(await rows(own)).toHaveLength(0)
  })
  test('Q6 never creates AI/agent Messages or AI reservations and never consumes or blocks Q2 quota',async()=>{
    const f=await setup('pro');await assignment(f.conversationId)
    const before=await getAiUsageState(f.tenantId)
    const originalMessages=await globalDb.message.count({where:{tenantId:f.tenantId,conversationId:f.conversationId}})
    const reservationCount=await globalDb.aiReplyReservation.count({where:{tenantId:f.tenantId}})
    expect(await summarize(f)).not.toBeNull()
    const after=await getAiUsageState(f.tenantId)
    expect(after.used).toBe(before.used)
    expect(after.reserved).toBe(before.reserved)
    expect(await globalDb.message.count({where:{tenantId:f.tenantId,conversationId:f.conversationId}})).toBe(originalMessages)
    expect(await globalDb.aiReplyReservation.count({where:{tenantId:f.tenantId}})).toBe(reservationCount)
  })
  test('reassignment or reopened conversation never rewrites the first handoff summary',async()=>{
    const f=await setup('pro');await assignment(f.conversationId)
    expect(await summarize(f)).not.toBeNull()
    const initial=(await rows(f))[0]
    await globalDb.conversation.update({where:{id:f.conversationId},
      data:{assignedUserId:null,status:'open'}})
    await globalDb.message.create({data:{
      tenantId:f.tenantId,conversationId:f.conversationId,senderType:'contact',
      contentType:'text',content:{text:'LATE_VISITOR_TEXT'},status:'sent',
      createdAt:laterTime,
    }})
    await assignment(f.conversationId)
    await summarize(f)
    const r=await rows(f)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(initial.id)
    expect(r[0].summaryText).toBe(initial.summaryText)
    expect(r[0].sourceMessageIds).toEqual(initial.sourceMessageIds)
  })
})
