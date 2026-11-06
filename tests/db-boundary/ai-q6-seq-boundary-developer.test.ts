/// <reference types="bun-types" />
/**
 * AI-Q6 — developer-owned concurrency and boundary integrity tests.
 *
 * These tests are NOT reviewer-owned (not pinned by blob hash). They
 * complement the reviewer suite by testing the selected event-ordering
 * design under concurrency and delayed-summary scenarios.
 *
 * Tests:
 *   1. Same-millisecond pre-takeover AI messages are INCLUDED (seq boundary
 *      does not exclude legitimately earlier messages sharing the ms).
 *   2. Same-millisecond post-assignment messages are EXCLUDED by seq boundary.
 *   3. Same-millisecond post-agent-reply messages are EXCLUDED by seq boundary.
 *   4. Delayed summary generation preserves the original boundary.
 *   5. Reassignment does not overwrite the original handoffSourceSeq.
 *   6. Concurrent summary attempts all see the same authoritative boundary.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const seed=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
const tenantIds:string[]=[]
let agentId='',counter=0

beforeAll(async()=>{
  await ensurePlansSeeded()
  agentId=(await globalDb.user.create({data:{
    email:'q6-dev-boundary-'+seed+'@test.com',
  },select:{id:true}})).id
})
afterAll(async()=>{
  for(const tid of tenantIds.reverse())
    await globalDb.tenant.delete({where:{id:tid}}).catch(()=>{})
  if(agentId)await globalDb.user.delete({where:{id:agentId}}).catch(()=>{})
})

async function fixture(){
  const n=++counter
  const tenantId=(await globalDb.tenant.create({data:{
    slug:'q6-dev-bnd-'+seed+'-'+n,name:'Q6 Dev Boundary '+n,plan:'pro',
  },select:{id:true}})).id
  tenantIds.push(tenantId)
  const contactId=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-dev-bnd-'+seed+'-'+n,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  return {tenantId,conversationId}
}
type F=Awaited<ReturnType<typeof fixture>>

async function add(
  f:F,senderType:'contact'|'ai'|'agent',text:string,createdAt:Date,
){
  return globalDb.message.create({data:{
    tenantId:f.tenantId,conversationId:f.conversationId,senderType,
    senderUserId:senderType==='agent'?agentId:null,
    contentType:'text',status:'sent',content:{text},createdAt,
  }})
}
async function assign(f:F){
  return globalDb.conversation.update({where:{id:f.conversationId},
    data:{assignedUserId:agentId}})
}
async function summarize(f:F){
  return withTenant(f.tenantId,
    ()=>ensureConversationHandoffSummary(f.conversationId))
}
async function stored(f:F){
  return globalDb.conversationHandoffSummary.findMany({where:{
    tenantId:f.tenantId,conversationId:f.conversationId,
  }})
}
async function conv(f:F){
  return globalDb.conversation.findUnique({where:{id:f.conversationId},
    select:{firstHandoffAt:true,handoffSourceSeq:true}})
}

describe('Developer AI-Q6 — seq boundary integrity and concurrency',()=>{
  test('same-millisecond pre-takeover AI reply is included by seq boundary',async()=>{
    const f=await fixture()
    const t=new Date('2026-10-01T10:00:00.000Z')
    // AI and visitor share the same millisecond — both are pre-takeover.
    const visitor=await add(f,'contact','SAME_MS_VISITOR_QUESTION',t)
    const ai=await add(f,'ai','SAME_MS_AI_PRICE_420000',t)
    await assign(f)
    expect(await summarize(f)).not.toBeNull()
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('SAME_MS_AI_PRICE_420000')
    expect(r[0].sourceMessageIds).toContain(visitor.id)
    expect(r[0].sourceMessageIds).toContain(ai.id)
  })

  test('post-assignment same-millisecond messages excluded by seq',async()=>{
    const f=await fixture()
    const early=new Date('2026-10-01T10:00:00.000Z')
    await add(f,'contact','PRE_ASSIGN_VISITOR',early)
    await add(f,'ai','PRE_ASSIGN_AI_500000',early)
    const assigned=await assign(f)
    const boundary=assigned.firstHandoffAt!
    // Messages written AFTER assignment with the same ms timestamp.
    const leakedV=await add(f,'contact','POST_ASSIGN_SAME_MS_VISITOR_999000',boundary)
    const leakedA=await add(f,'ai','POST_ASSIGN_SAME_MS_AI_FALSE_999000',boundary)
    expect(await summarize(f)).not.toBeNull()
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('PRE_ASSIGN_AI_500000')
    expect(r[0].summaryText).not.toContain('POST_ASSIGN_SAME_MS_VISITOR_999000')
    expect(r[0].summaryText).not.toContain('POST_ASSIGN_SAME_MS_AI_FALSE_999000')
    expect(r[0].sourceMessageIds).not.toContain(leakedV.id)
    expect(r[0].sourceMessageIds).not.toContain(leakedA.id)
  })

  test('post-agent-reply same-millisecond messages excluded by seq',async()=>{
    const f=await fixture()
    const early=new Date('2026-10-01T10:00:00.000Z')
    await add(f,'contact','PRE_AGENT_VISITOR',early)
    await add(f,'ai','PRE_AGENT_AI_300000',early)
    const takeover=new Date('2026-10-01T10:00:02.000Z')
    await add(f,'agent','AGENT_TAKEOVER',takeover)
    // Messages written AFTER agent reply with the same ms timestamp.
    const leakedV=await add(f,'contact','POST_AGENT_SAME_MS_VISITOR_777000',takeover)
    const leakedA=await add(f,'ai','POST_AGENT_SAME_MS_AI_FALSE_777000',takeover)
    expect(await summarize(f)).not.toBeNull()
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('PRE_AGENT_AI_300000')
    expect(r[0].summaryText).not.toContain('POST_AGENT_SAME_MS_VISITOR_777000')
    expect(r[0].summaryText).not.toContain('POST_AGENT_SAME_MS_AI_FALSE_777000')
    expect(r[0].sourceMessageIds).not.toContain(leakedV.id)
    expect(r[0].sourceMessageIds).not.toContain(leakedA.id)
  })

  test('delayed summary generation preserves the original boundary',async()=>{
    const f=await fixture()
    const early=new Date('2026-10-01T10:00:00.000Z')
    await add(f,'contact','DELAYED_PRE_VISITOR',early)
    await add(f,'ai','DELAYED_PRE_AI_650000',early)
    await assign(f)
    // Simulate delay: new messages arrive after the boundary.
    const later=new Date(Date.now()+1000)
    await add(f,'contact','DELAYED_POST_VISITOR_111000',later)
    await add(f,'ai','DELAYED_POST_AI_FALSE_111000',later)
    // Summary runs later — must use the original boundary.
    expect(await summarize(f)).not.toBeNull()
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('DELAYED_PRE_AI_650000')
    expect(r[0].summaryText).not.toContain('DELAYED_POST_VISITOR_111000')
    expect(r[0].summaryText).not.toContain('DELAYED_POST_AI_FALSE_111000')
  })

  test('reassignment does not overwrite the original handoffSourceSeq',async()=>{
    const f=await fixture()
    const early=new Date('2026-10-01T10:00:00.000Z')
    await add(f,'contact','REASSIGN_PRE_VISITOR',early)
    await add(f,'ai','REASSIGN_PRE_AI_550000',early)
    await assign(f)
    const originalConv=await conv(f)
    expect(originalConv?.handoffSourceSeq).not.toBeNull()
    const originalSeq=originalConv!.handoffSourceSeq!
    // Unassign then reassign.
    await globalDb.conversation.update({where:{id:f.conversationId},
      data:{assignedUserId:null}})
    await add(f,'contact','REASSIGN_LATE_VISITOR',new Date())
    await assign(f)
    const afterReassign=await conv(f)
    // handoffSourceSeq must be unchanged — first assignment wins.
    expect(afterReassign?.handoffSourceSeq).toBe(originalSeq)
    expect(await summarize(f)).not.toBeNull()
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('REASSIGN_PRE_AI_550000')
    expect(r[0].summaryText).not.toContain('REASSIGN_LATE_VISITOR')
  })

  test('concurrent summary attempts all see the same authoritative boundary',async()=>{
    const f=await fixture()
    const early=new Date('2026-10-01T10:00:00.000Z')
    await add(f,'contact','CONCURRENT_PRE_VISITOR',early)
    await add(f,'ai','CONCURRENT_PRE_AI_800000',early)
    await assign(f)
    // Run 8 concurrent summary attempts.
    const results=await Promise.all(
      Array.from({length:8},()=>summarize(f)),
    )
    expect(results.every(r=>r!==null)).toBe(true)
    const r=await stored(f)
    expect(r).toHaveLength(1)
    expect(r[0].summaryText).toContain('CONCURRENT_PRE_AI_800000')
  })
})
