/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q6 — exact-cutoff ambiguity, actual PostgreSQL.
 * Immutable after pinning. Tests that an equal millisecond timestamp does
 * NOT prove a message was recorded before human takeover.
 *
 * The tests explicitly write new rows AFTER committed takeover, with a
 * persisted createdAt equal to its authoritative timestamp (valid under
 * millisecond precision). The summary must not treat them as old evidence.
 * No mocked Prisma or artificial production hooks.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const nonce=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
const tenantIds:string[]=[]
let agentId='',n=0
const EARLY=new Date('2026-10-01T10:00:00.000Z')
const EARLY_AI=new Date('2026-10-01T10:00:01.000Z')
beforeAll(async()=>{
  await ensurePlansSeeded()
  agentId=(await globalDb.user.create({data:{
    email:'q6-equal-boundary-'+nonce+'@test.com',
  },select:{id:true}})).id
})
afterAll(async()=>{
  for(const tenantId of tenantIds.reverse())
    await globalDb.tenant.delete({where:{id:tenantId}}).catch(()=>{})
  if(agentId)await globalDb.user.delete({where:{id:agentId}}).catch(()=>{})
})
async function fixture(){
  const suffix=++n
  const tenantId=(await globalDb.tenant.create({data:{
    name:'Q6 Millisecond Reviewer '+suffix,
    slug:'q6-same-ms-'+nonce+'-'+suffix,
    plan:'pro',
  },select:{id:true}})).id
  tenantIds.push(tenantId)
  const contactId=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-same-ms-'+nonce+'-'+suffix,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  const visitor=await add(tenantId,conversationId,'contact',
    'VALID_PRE_HANDOFF_VISITOR_QUESTION',EARLY)
  const ai=await add(tenantId,conversationId,'ai',
    'VALID_PRE_HANDOFF_AI_ANSWER_230000',EARLY_AI)
  return {tenantId,conversationId,visitorId:visitor.id,aiId:ai.id}
}
async function add(tenantId:string,conversationId:string,senderType:'contact'|'ai'|'agent',
  text:string,createdAt:Date){
  return globalDb.message.create({data:{
    tenantId,conversationId,senderType,
    senderUserId:senderType==='agent'?agentId:null,
    contentType:'text',status:'sent',content:{text},createdAt,
  }})
}
type Fixture=Awaited<ReturnType<typeof fixture>>
async function render(f:Fixture){
  const result=await withTenant(f.tenantId,
    ()=>ensureConversationHandoffSummary(f.conversationId))
  expect(result,'Existing eligible pre-takeover AI reply must still be summarized').not.toBeNull()
  const saved=await globalDb.conversationHandoffSummary.findUniqueOrThrow({
    where:{tenantId_conversationId:{
      tenantId:f.tenantId,conversationId:f.conversationId,
    }},
  })
  expect(saved.summaryText).toContain('VALID_PRE_HANDOFF_AI_ANSWER_230000')
  expect(saved.sourceMessageIds).toContain(f.visitorId)
  expect(saved.sourceMessageIds).toContain(f.aiId)
  return saved
}

describe('Reviewer AI-Q6 — equal millisecond is not proven pre-handoff',()=>{
  test('post-assignment messages with createdAt equal firstHandoffAt MUST be excluded',async()=>{
    const f=await fixture()
    const assigned=await globalDb.conversation.update({
      where:{id:f.conversationId},data:{assignedUserId:agentId},
    })
    expect(assigned.firstHandoffAt).toBeInstanceOf(Date)
    const boundary=assigned.firstHandoffAt!
    // BOTH records are written strictly AFTER assignment has committed.
    // They can share exactly the same rounded millisecond as its cutoff.
    const lateVisitor=await add(f.tenantId,f.conversationId,'contact',
      'AFTER_ASSIGNMENT_CONTACT_PRIVATE_880000',boundary)
    const lateAi=await add(f.tenantId,f.conversationId,'ai',
      'AFTER_ASSIGNMENT_AI_FALSE_PRICE_990000',boundary)
    const saved=await render(f)
    expect(saved.summaryText).not.toContain('AFTER_ASSIGNMENT_CONTACT_PRIVATE_880000')
    expect(saved.summaryText).not.toContain('AFTER_ASSIGNMENT_AI_FALSE_PRICE_990000')
    expect(saved.sourceMessageIds).not.toContain(lateVisitor.id)
    expect(saved.sourceMessageIds).not.toContain(lateAi.id)
  })

  test('post-first-agent-message rows with equal createdAt MUST be excluded',async()=>{
    const f=await fixture()
    const takeover=new Date('2026-10-01T10:00:02.000Z')
    const agentReply=await add(f.tenantId,f.conversationId,'agent',
      'HUMAN_TAKEOVER_AT_BOUNDARY',takeover)
    expect(agentReply.createdAt.getTime()).toBe(takeover.getTime())
    // firstResponseAt and assignment intentionally null: agent message is
    // the only authoritative takeover signal.
    const lateVisitor=await add(f.tenantId,f.conversationId,'contact',
      'AFTER_AGENT_CONTACT_PRIVATE_880000',takeover)
    const lateAi=await add(f.tenantId,f.conversationId,'ai',
      'AFTER_AGENT_AI_FALSE_PRICE_990000',takeover)
    const saved=await render(f)
    expect(saved.summaryText).not.toContain('AFTER_AGENT_CONTACT_PRIVATE_880000')
    expect(saved.summaryText).not.toContain('AFTER_AGENT_AI_FALSE_PRICE_990000')
    expect(saved.sourceMessageIds).not.toContain(lateVisitor.id)
    expect(saved.sourceMessageIds).not.toContain(lateAi.id)
  })
})
