/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q6 — unobserved large-history, delayed handoff,
 * and effective-subscription entitlement acceptance (real PostgreSQL).
 *
 * REVIEWER-OWNED and immutable once pinned in CI. No mocked DB, no shortcut
 * around Q2 accounting. Tests only Q6, not duplicate Q1-Q5 suites.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const seed=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)
const tenants:string[]=[]
let agentId='',n=0
beforeAll(async()=>{
  await ensurePlansSeeded()
  agentId=(await globalDb.user.create({data:{email:'q6-handoff-invariant-'+seed+'@test.com'},select:{id:true}})).id
})
afterAll(async()=>{
  for(const id of tenants.reverse())await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  if(agentId)await globalDb.user.delete({where:{id:agentId}}).catch(()=>{})
})
async function fixture(plan:'pro'|'free'='pro'){
  const i=++n
  const tenantId=(await globalDb.tenant.create({data:{
    slug:'q6-handoff-invariant-'+seed+'-'+i,
    name:'Q6 Handoff Invariant '+i,plan,
  },select:{id:true}})).id
  tenants.push(tenantId)
  const contactId=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-invariant-contact-'+seed+'-'+i,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  return {tenantId,conversationId}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
async function add(f:Fixture,senderType:'ai'|'contact',text:string,createdAt?:Date){
  return globalDb.message.create({data:{
    tenantId:f.tenantId,conversationId:f.conversationId,senderType,
    contentType:'text',status:'sent',content:{text},
    ...(createdAt?{createdAt}:{}),
  }})
}
async function assign(f:Fixture){
  return globalDb.conversation.update({where:{id:f.conversationId},
    data:{assignedUserId:agentId}})
}
async function summarize(f:Fixture){
  return withTenant(f.tenantId,()=>ensureConversationHandoffSummary(f.conversationId))
}
async function stored(f:Fixture){
  return globalDb.conversationHandoffSummary.findMany({where:{
    tenantId:f.tenantId,conversationId:f.conversationId,
  }})
}
async function subscribe(f:Fixture,planSlug:'pro'|'free'){
  const p=await globalDb.plan.findUniqueOrThrow({where:{slug:planSlug},select:{id:true}})
  await globalDb.subscription.create({data:{
    tenantId:f.tenantId,planId:p.id,status:'active',
    currentPeriodStart:new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd:new Date('2026-12-01T00:00:00.000Z'),
  }})
}
describe('Reviewer AI-Q6 — bounded history, exact first assignment cutoff, effective plan',()=>{
  test('AI answer at row 5001 must not vanish behind a silent 5000-record cutoff',async()=>{
    const f=await fixture()
    const origin=Date.parse('2026-01-01T00:00:00.000Z')
    const batch=Array.from({length:5000},(_,i)=>({
      tenantId:f.tenantId,conversationId:f.conversationId,
      senderType:'contact',contentType:'text',status:'sent',
      content:{text:'VISITOR_'+i},
      createdAt:new Date(origin+i*1000),
    }))
    await globalDb.message.createMany({data:batch})
    const target=await add(f,'ai','TRUE_AI_FACT_AT_MESSAGE_5001',new Date(origin+5001*1000))
    await assign(f)
    const result=await summarize(f)
    expect(result,'A completed eligible handoff cannot mistake a partial page scan for no AI history').not.toBeNull()
    const rows=await stored(f)
    expect(rows).toHaveLength(1)
    expect(rows[0].summaryText).toContain('TRUE_AI_FACT_AT_MESSAGE_5001')
    expect(rows[0].sourceMessageIds).toContain(target.id)
  },60000)

  test('delayed first-assignment summary must exclude messages created after assignment, before summary retry',async()=>{
    const f=await fixture()
    const first=await add(f,'contact','BEFORE_ASSIGNMENT_VISITOR')
    const originalAi=await add(f,'ai','BEFORE_ASSIGNMENT_AI_PRICE_321000')
    const assigned=await assign(f)
    expect(assigned.assignedUserId).toBe(agentId)
    // Ensure distinct database millisecond timestamps; sequence is not a
    // probabilistic concurrency assertion: the write order is serialized.
    await Bun.sleep(35)
    const lateVisitor=await add(f,'contact','LEAKED_AFTER_ASSIGNMENT_VISITOR')
    const lateAi=await add(f,'ai','LEAKED_AFTER_ASSIGNMENT_AI_PRICE_999000')
    const result=await summarize(f)
    expect(result).not.toBeNull()
    const rows=await stored(f)
    expect(rows).toHaveLength(1)
    expect(rows[0].summaryText).toContain('BEFORE_ASSIGNMENT_AI_PRICE_321000')
    expect(rows[0].summaryText).not.toContain('LEAKED_AFTER_ASSIGNMENT_VISITOR')
    expect(rows[0].summaryText).not.toContain('LEAKED_AFTER_ASSIGNMENT_AI_PRICE_999000')
    expect(rows[0].sourceMessageIds).toContain(first.id)
    expect(rows[0].sourceMessageIds).toContain(originalAi.id)
    expect(rows[0].sourceMessageIds).not.toContain(lateVisitor.id)
    expect(rows[0].sourceMessageIds).not.toContain(lateAi.id)
  })

  test('active Free subscription overrides stale tenant.plan=pro: Q6 must not create summary',async()=>{
    const f=await fixture('pro')
    await subscribe(f,'free')
    await add(f,'contact','CUSTOMER_PRE_HANDOFF')
    await add(f,'ai','AI_PRE_HANDOFF_VALID_750000')
    await assign(f)
    expect(await summarize(f)).toBeNull()
    expect(await stored(f)).toHaveLength(0)
  })

  test('active Pro subscription overrides stale tenant.plan=free: Q6 can create summary without billing',async()=>{
    const f=await fixture('free')
    await subscribe(f,'pro')
    await add(f,'contact','CUSTOMER_PRE_HANDOFF')
    const ai=await add(f,'ai','AI_PRE_HANDOFF_VALID_750000')
    await assign(f)
    const result=await summarize(f)
    expect(result).not.toBeNull()
    const rows=await stored(f)
    expect(rows).toHaveLength(1)
    expect(rows[0].summaryText).toContain('AI_PRE_HANDOFF_VALID_750000')
    expect(rows[0].sourceMessageIds).toContain(ai.id)
    expect(await globalDb.aiReplyReservation.count({where:{tenantId:f.tenantId}})).toBe(0)
  })
})
