/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q6 — adversarial real PostgreSQL acceptance.
 * The source scan must not silently drop the 501st eligible AI answer, or
 * include facts recorded AFTER the first real human response.
 *
 * Real Prisma, real PostgreSQL, tenant-scoped service, no mocked records.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const seed=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
const tenants:string[]=[]
let humanId='',counter=0

beforeAll(async()=>{
  await ensurePlansSeeded()
  humanId=(await globalDb.user.create({data:{
    email:'q6-adversarial-'+seed+'@test.com',
  },select:{id:true}})).id
})
afterAll(async()=>{
  for(const id of tenants.reverse())await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  if(humanId)await globalDb.user.delete({where:{id:humanId}}).catch(()=>{})
})
async function fixture(){
  const i=++counter
  const tenantId=(await globalDb.tenant.create({data:{
    slug:'q6-adv-'+seed+'-'+i,name:'Q6 Adversarial '+i,plan:'pro',
  },select:{id:true}})).id
  tenants.push(tenantId)
  const contactId=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-adv-visitor-'+seed+'-'+i,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  return {tenantId,conversationId}
}
const message=async(
  f:Awaited<ReturnType<typeof fixture>>,
  senderType:'contact'|'ai'|'agent',
  text:string,
  createdAt:Date,
)=>{
  return globalDb.message.create({data:{
    tenantId:f.tenantId,conversationId:f.conversationId,
    senderType,senderUserId:senderType==='agent'?humanId:null,
    contentType:'text',status:'sent',content:{text},createdAt,
  }})
}
const summary=async(f:Awaited<ReturnType<typeof fixture>>)=>
  withTenant(f.tenantId,()=>ensureConversationHandoffSummary(f.conversationId))
const stored=async(f:Awaited<ReturnType<typeof fixture>>)=>
  globalDb.conversationHandoffSummary.findMany({where:{
    tenantId:f.tenantId,conversationId:f.conversationId,
  }})

describe('Reviewer AI-Q6 — full-history eligibility and first human cut-off',()=>{
  test('501st message is the first AI reply: must discover it rather than silently report no handoff',async()=>{
    const f=await fixture()
    const t=Date.parse('2026-11-04T00:00:00.000Z')
    const data=Array.from({length:500},(_,i)=>({
      tenantId:f.tenantId,conversationId:f.conversationId,
      senderType:'contact',contentType:'text',status:'sent',
      content:{text:'VISITOR_QUESTION_'+i},
      createdAt:new Date(t+i*1000),
    }))
    await globalDb.message.createMany({data})
    const ai=await message(f,'ai','REAL_AI_REPLY_AT_MESSAGE_501',new Date(t+550000))
    await globalDb.conversation.update({where:{id:f.conversationId},
      data:{assignedUserId:humanId}})
    const result=await summary(f)
    expect(result,'A legitimate first AI reply at message 501 must be found').not.toBeNull()
    const records=await stored(f)
    expect(records).toHaveLength(1)
    expect(records[0].summaryText).toContain('REAL_AI_REPLY_AT_MESSAGE_501')
    expect(records[0].sourceMessageIds).toContain(ai.id)
    expect(records[0].sourceMessageIds.length).toBeLessThanOrEqual(30)
  },20000)

  test('first human agent message is authoritative cut-off even if firstResponseAt was populated later',async()=>{
    const f=await fixture()
    const t=Date.parse('2026-11-04T00:00:00.000Z')
    const visitor=await message(f,'contact','EARLY_CUSTOMER',new Date(t))
    const ai=await message(f,'ai','EARLY_REAL_AI_PRICE_240000',new Date(t+1000))
    await message(f,'agent','HUMAN_TAKEOVER',new Date(t+2000))
    const laterVisitor=await message(f,'contact','PRIVATE_AFTER_HUMAN',new Date(t+3000))
    const laterAi=await message(f,'ai','MISLEADING_AI_AFTER_HUMAN',new Date(t+4000))
    await globalDb.conversation.update({where:{id:f.conversationId},
      data:{firstResponseAt:new Date(t+5000)}})
    expect(await summary(f)).not.toBeNull()
    const records=await stored(f)
    expect(records).toHaveLength(1)
    expect(records[0].summaryText).toContain('EARLY_REAL_AI_PRICE_240000')
    expect(records[0].summaryText).not.toContain('PRIVATE_AFTER_HUMAN')
    expect(records[0].summaryText).not.toContain('MISLEADING_AI_AFTER_HUMAN')
    expect(records[0].sourceMessageIds).toEqual([visitor.id,ai.id])
    expect(records[0].sourceMessageIds).not.toContain(laterVisitor.id)
    expect(records[0].sourceMessageIds).not.toContain(laterAi.id)
  },15000)
})
