/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q6 — real PostgreSQL latest AI-answer freshness.
 * IMMUTABLE once committed. Q6 scoped only, never duplicate Q1-Q5 suites.
 *
 * Tests an authoritative correction at the tail of a long AI conversation.
 * Fetching the first 100 AI messages (and the first 400 surrounding messages)
 * must not silently erase the final, materially different AI reply.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const unique=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
let tid='',humanId='',convId=''
beforeAll(async()=>{
  await ensurePlansSeeded()
  tid=(await globalDb.tenant.create({data:{
    slug:'q6-latest-ai-review-'+unique,name:'Q6 Latest AI Reviewer '+unique,plan:'pro',
  },select:{id:true}})).id
  humanId=(await globalDb.user.create({data:{
    email:'q6-latest-review-'+unique+'@test.com',
  },select:{id:true}})).id
  const contactId=(await globalDb.contact.create({data:{
    tenantId:tid,identifier:'q6-latest-contact-'+unique,identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  convId=(await globalDb.conversation.create({data:{
    tenantId:tid,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
})
afterAll(async()=>{
  if(tid)await globalDb.tenant.delete({where:{id:tid}}).catch(()=>{})
  if(humanId)await globalDb.user.delete({where:{id:humanId}}).catch(()=>{})
})
describe('Reviewer AI-Q6 — latest material AI correction is not lost to the first-100 fetch',()=>{
  test('AI answer #101, after 450 intervening visitor rows, remains a visible grounded source at handoff',async()=>{
    const origin=Date.parse('2026-10-01T08:00:00.000Z')
    const historicalAi=Array.from({length:100},(_,i)=>({
      tenantId:tid,conversationId:convId,
      senderType:'ai',contentType:'text',status:'sent',
      content:{text:'OLD_AI_PRICE_100000 reply '+i},
      createdAt:new Date(origin+i*1000),
    }))
    const intervening=Array.from({length:450},(_,i)=>({
      tenantId:tid,conversationId:convId,
      senderType:'contact',contentType:'text',status:'sent',
      content:{text:'visitor update '+i},
      createdAt:new Date(origin+(i+100)*1000),
    }))
    await globalDb.message.createMany({data:[...historicalAi,...intervening]})
    const latest=await globalDb.message.create({data:{
      tenantId:tid,conversationId:convId,
      senderType:'ai',contentType:'text',status:'sent',
      content:{text:'CORRECTED_LATEST_AI_PRICE_990000 is the updated answer'},
      createdAt:new Date(origin+560000),
    }})
    await globalDb.conversation.update({where:{id:convId},data:{assignedUserId:humanId}})
    const result=await withTenant(tid,()=>ensureConversationHandoffSummary(convId))
    expect(result,'No valid handoff should hide the most recent AI correction').not.toBeNull()
    const saved=await globalDb.conversationHandoffSummary.findUniqueOrThrow({
      where:{tenantId_conversationId:{tenantId:tid,conversationId:convId}},
    })
    expect(saved.summaryText,'Must show the latest valid AI fact, not an old price').toContain('CORRECTED_LATEST_AI_PRICE_990000')
    expect(saved.sourceMessageIds).toContain(latest.id)
    expect(saved.summaryText.length).toBeLessThanOrEqual(3000)
    expect((saved.sourceMessageIds as string[]).length).toBeLessThanOrEqual(30)
  },30000)
})
