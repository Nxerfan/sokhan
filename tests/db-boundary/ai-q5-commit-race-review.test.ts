/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q5: atomic AI commit versus human takeover.
 * REVIEWER OWNED / IMMUTABLE after handoff.
 *
 * Unlike policy-only tests, these reproduce the critical interleaving
 * against actual PostgreSQL: reserve the AI slot, change persisted human
 * takeover state, THEN attempt to settle that old reservation.
 *
 * Passing the early eligibility check is NOT sufficient. Settlement must
 * fail closed on later human takeover, with no AI Message and no AI charge.
 * No mocked Prisma, artificial sleeps, testing bypasses or fake provider.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {reserveAiReply,commitAiReply,releaseAiReply,getAiUsageState}
  from '../../src/lib/ai/usage-service'

const seed=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
let tid='',humanId=''
let counter=0

beforeAll(async()=>{
  await ensurePlansSeeded()
  tid=(await globalDb.tenant.create({data:{
    slug:'q5-commit-race-'+seed,name:'Q5 Human/AI Commit Race '+seed,plan:'pro',
  },select:{id:true}})).id
  humanId=(await globalDb.user.create({data:{email:'q5-commit-race-'+seed+'@test.com'},select:{id:true}})).id
})

afterAll(async()=>{
  if(tid)await globalDb.tenant.delete({where:{id:tid}}).catch(()=>{})
  if(humanId)await globalDb.user.delete({where:{id:humanId}}).catch(()=>{})
})

async function beginReservedReply(){
  const n=++counter
  const contact=await globalDb.contact.create({data:{
    tenantId:tid,identifier:'q5-commit-race-'+seed+'-'+n,identifierType:'visitorId',metadata:{},
  },select:{id:true}})
  const conv=await globalDb.conversation.create({data:{
    tenantId:tid,contactId:contact.id,status:'open',tags:[],channel:'widget',
  },select:{id:true}})
  const message=await globalDb.message.create({data:{
    tenantId:tid,conversationId:conv.id,senderType:'contact',
    contentType:'text',content:{text:'قیمت محصول'},status:'sent',
  },select:{id:true}})
  const reservation=await reserveAiReply({
    tenantId:tid,conversationId:conv.id,visitorMessageId:message.id,
  })
  expect(reservation.status).toBe('reserved')
  if(reservation.status!=='reserved')throw Error('Failed to obtain AI reservation')
  return {convId:conv.id,reservationId:reservation.reservationId}
}
async function mustRejectAfterTakeover(convId:string,reservationId:string){
  const before=await getAiUsageState(tid)
  expect(before.reserved).toBeGreaterThan(0)
  const outcome=await commitAiReply({
    tenantId:tid,reservationId,conversationId:convId,
    text:'This AI message must never be committed after takeover',source:'product',
  })
  expect(outcome.status,'AI settlement after human takeover must be denied').toBe('not_found')
  expect(await globalDb.message.count({
    where:{tenantId:tid,conversationId:convId,senderType:'ai'},
  })).toBe(0)
  const after=await getAiUsageState(tid)
  expect(after.used,'No billable AI message should be charged').toBe(before.used)
  // A rejected reservation may be released inside the service or by its
  // route caller. Releasing twice must remain harmless/idempotent.
  await releaseAiReply({tenantId:tid,reservationId})
  const released=await getAiUsageState(tid)
  expect(released.used).toBe(before.used)
  expect(released.reserved).toBe(before.reserved-1)
}

describe('Reviewer AI-Q5 — no AI settlement after in-flight human takeover',()=>{
  test('human assignment AFTER reservation blocks final AI commit',async()=>{
    const {convId,reservationId}=await beginReservedReply()
    await globalDb.conversation.update({
      where:{id:convId},data:{assignedUserId:humanId},
    })
    await mustRejectAfterTakeover(convId,reservationId)
  })

  test('human reply AFTER reservation blocks AI commit, even if assignment and timestamp are null',async()=>{
    const {convId,reservationId}=await beginReservedReply()
    await globalDb.message.create({data:{
      tenantId:tid,conversationId:convId,senderType:'agent',senderUserId:humanId,
      contentType:'text',content:{text:'اپراتور پاسخ داد'},status:'sent',
    }})
    await globalDb.conversation.update({
      where:{id:convId},data:{assignedUserId:null,firstResponseAt:null},
    })
    await mustRejectAfterTakeover(convId,reservationId)
  })

  test('conversation closed AFTER reservation blocks final AI commit',async()=>{
    const {convId,reservationId}=await beginReservedReply()
    await globalDb.conversation.update({where:{id:convId},data:{status:'closed'}})
    await mustRejectAfterTakeover(convId,reservationId)
  })

  test('human firstResponseAt AFTER reservation blocks final AI commit',async()=>{
    const {convId,reservationId}=await beginReservedReply()
    await globalDb.conversation.update({
      where:{id:convId},data:{firstResponseAt:new Date()},
    })
    await mustRejectAfterTakeover(convId,reservationId)
  })
})
