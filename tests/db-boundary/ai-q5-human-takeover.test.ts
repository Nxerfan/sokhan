/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q5: real PostgreSQL tenant-scoped human-takeover guard.
 * All tests must run in Full AND Lite, with real Prisma and no mocked models.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {db,globalDb,withTenant} from '../../src/lib/db'
import {canAutoReplyToConversation} from '../../src/lib/ai/human-takeover'

const seed=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
let tenantA='',tenantB='',userId=''
const ids:string[]=[]
async function newConversation(tenantId:string){
  const c=await globalDb.contact.create({data:{
    tenantId,identifier:'q5-'+seed+'-'+ids.length,identifierType:'visitorId',metadata:{},
  }})
  const conv=await globalDb.conversation.create({data:{
    tenantId,contactId:c.id,status:'open',channel:'widget',tags:[],
  }})
  ids.push(conv.id)
  return conv.id
}
async function humanReply(tenantId:string,conversationId:string,senderType='agent'){
  return globalDb.message.create({data:{
    tenantId,conversationId,senderType,senderUserId:senderType==='agent'?userId:null,
    contentType:'text',content:{text:'Human agent answer'},status:'sent',
  }})
}
async function eligible(tenantId:string,conversationId:string){
  return withTenant(tenantId,()=>canAutoReplyToConversation(conversationId))
}
beforeAll(async()=>{
  tenantA=(await globalDb.tenant.create({data:{
    slug:'q5-a-'+seed,name:'Q5-A '+seed,plan:'pro',
  },select:{id:true}})).id
  tenantB=(await globalDb.tenant.create({data:{
    slug:'q5-b-'+seed,name:'Q5-B '+seed,plan:'pro',
  },select:{id:true}})).id
  userId=(await globalDb.user.create({data:{email:'q5-'+seed+'@test.com'},select:{id:true}})).id
})
afterAll(async()=>{
  for(const id of [tenantB,tenantA])if(id)await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  if(userId)await globalDb.user.delete({where:{id:userId}}).catch(()=>{})
})
describe('Reviewer AI-Q5 — server-authoritative human takeover',()=>{
  test('unassigned open conversation with no human reply permits AI',async()=>{
    const conv=await newConversation(tenantA)
    expect(await eligible(tenantA,conv)).toBe(true)
  })
  test('manual assignment stops AI before any agent sends a message',async()=>{
    const conv=await newConversation(tenantA)
    await globalDb.conversation.update({where:{id:conv},data:{assignedUserId:userId}})
    expect(await eligible(tenantA,conv)).toBe(false)
  })
  test('historic agent message blocks AI even after assignment and timestamp cleared',async()=>{
    const conv=await newConversation(tenantA)
    await humanReply(tenantA,conv)
    await globalDb.conversation.update({where:{id:conv},data:{assignedUserId:null,firstResponseAt:null}})
    expect(await eligible(tenantA,conv)).toBe(false)
  })
  test('firstResponseAt alone blocks AI regardless of assignment',async()=>{
    const conv=await newConversation(tenantA)
    await globalDb.conversation.update({where:{id:conv},data:{firstResponseAt:new Date()}})
    expect(await eligible(tenantA,conv)).toBe(false)
  })
  test('prior AI/system messages do not represent human takeover',async()=>{
    const conv=await newConversation(tenantA)
    for(const senderType of ['ai','system'])await humanReply(tenantA,conv,senderType)
    expect(await eligible(tenantA,conv)).toBe(true)
  })
  test('closed or pending conversations cannot auto-reply',async()=>{
    const conv=await newConversation(tenantA)
    for(const status of ['closed','pending']){
      await globalDb.conversation.update({where:{id:conv},data:{status}})
      expect(await eligible(tenantA,conv)).toBe(false)
    }
  })
  test('cross-tenant conversation ID fails closed and never reveals foreign human state',async()=>{
    const conv=await newConversation(tenantB)
    expect(await eligible(tenantA,conv)).toBe(false)
    expect(await eligible(tenantB,conv)).toBe(true)
  })
  test('human reply in different tenant never suppresses AI in this tenant',async()=>{
    const own=await newConversation(tenantA),foreign=await newConversation(tenantB)
    await humanReply(tenantB,foreign)
    expect(await eligible(tenantA,own)).toBe(true)
    expect(await eligible(tenantB,foreign)).toBe(false)
  })
})
