/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER Q6 — true concurrent PostgreSQL commit-order boundary.
 * Immutable once hash pinned. No mocks, artificial waits as proof, or bypasses.
 *
 * A PostgreSQL SERIAL/nextval allocation order is NOT a transaction commit
 * order. A writer can allocate seq=K and remain uncommitted, while another
 * writer commits seq=K+1. MAX(seq) during takeover sees K+1; if the first
 * writer then commits AFTER takeover, seq<=MAX wrongly includes its facts.
 *
 * Both legitimate serial orders are accepted:
 * 1. Takeover commits first: still-pending message MUST be excluded.
 * 2. Message's transaction commits first because takeover waited for it:
 *    its content MAY be included as pre-handoff.
 */
import {afterAll,beforeAll,describe,expect,test} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const token=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)
const tenants:string[]=[]
let userId='',n=0
const OLD=new Date('2026-10-01T11:00:00.000Z')

beforeAll(async()=>{
  await ensurePlansSeeded()
  userId=(await globalDb.user.create({
    data:{email:'q6-commit-order-'+token+'@test.com'},select:{id:true},
  })).id
})
afterAll(async()=>{
  for(const id of tenants.reverse())await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  if(userId)await globalDb.user.delete({where:{id:userId}}).catch(()=>{})
})
async function setup(){
  const num=++n
  const tenantId=(await globalDb.tenant.create({
    data:{name:'Q6 Commit Ordering '+num,slug:'q6-order-'+token+'-'+num,plan:'pro'},
    select:{id:true},
  })).id
  tenants.push(tenantId)
  const contactId=(await globalDb.contact.create({
    data:{
      tenantId,identifier:'q6-order-contact-'+token+'-'+num,
      identifierType:'visitorId',metadata:{},
    },select:{id:true},
  })).id
  const conversationId=(await globalDb.conversation.create({
    data:{tenantId,contactId,status:'open',channel:'widget',tags:[]},
    select:{id:true},
  })).id
  const first=await globalDb.message.create({
    data:{
      tenantId,conversationId,senderType:'contact',contentType:'text',
      content:{text:'INITIAL_VISITOR_QUESTION'},status:'sent',createdAt:OLD,
    },
  })
  const ai=await globalDb.message.create({
    data:{
      tenantId,conversationId,senderType:'ai',contentType:'text',
      content:{text:'INITIAL_VALID_AI_RESPONSE_200000'},status:'sent',
      createdAt:new Date(OLD.getTime()+1000),
    },
  })
  return {tenantId,conversationId,firstId:first.id,aiId:ai.id}
}
type F=Awaited<ReturnType<typeof setup>>

async function waitForHumanCompletionOrDbBlocking(
  writerPid:number,
  isHumanCommitted:()=>boolean,
):Promise<'human-first'|'writer-first'>{
  const deadline=Date.now()+7000
  while(Date.now()<deadline){
    if(isHumanCommitted())return 'human-first'

    // A human action blocked by the uncommitted message writer is evidence
    // of correct serialization, not a timing assumption. The human action
    // will complete only after the writer is released.
    const blocked=await globalDb.$queryRaw<Array<{pid:number}>>`
      SELECT pid FROM pg_stat_activity
      WHERE ${writerPid} = ANY(pg_blocking_pids(pid))
        AND wait_event_type='Lock'
    `
    if(blocked.length>0)return 'writer-first'
    await Bun.sleep(25)
  }
  throw Error('Human operation neither committed nor demonstrably blocked by in-flight message writer')
}

async function runCommitOrderRace(f:F,kind:'assignment'|'agent'){
  const pendingText=kind==='assignment'
    ?'PENDING_AI_COMMITTED_AFTER_ASSIGNMENT_990000'
    :'PENDING_AI_COMMITTED_AFTER_AGENT_REPLY_990000'

  let releaseWriter!:()=>void
  const holdWriter=new Promise<void>(resolve=>{releaseWriter=resolve})
  let signalWriter!: (x:{id:string,seq:number,pid:number})=>void
  const writerReady=new Promise<{id:string,seq:number,pid:number}>(resolve=>{signalWriter=resolve})

  const writerTask=globalDb.$transaction(async tx=>{
    const pid=(await tx.$queryRaw<Array<{pid:number}>>`
      SELECT pg_backend_pid() AS pid
    `)[0].pid
    const inserted=await tx.message.create({
      data:{
        tenantId:f.tenantId,conversationId:f.conversationId,
        senderType:'ai',contentType:'text',status:'sent',
        content:{text:pendingText},
        createdAt:new Date(OLD.getTime()+3000),
      },select:{id:true,seq:true},
    })
    signalWriter({...inserted,pid})
    await holdWriter
    return inserted
  },{timeout:18000,maxWait:10000})

  let pending:{id:string,seq:number,pid:number}|undefined
  let finished=false
  let action:Promise<unknown>|undefined
  let order:'human-first'|'writer-first'|undefined
  try{
    pending=await writerReady

    // This row's seq is HIGHER than the uncommitted writer's, but it is
    // durably committed BEFORE the human takeover. MAX(seq) sees it while
    // remaining blind to the earlier still-uncommitted seq.
    const committed=await globalDb.message.create({
      data:{
        tenantId:f.tenantId,conversationId:f.conversationId,
        senderType:'ai',contentType:'text',status:'sent',
        content:{text:'COMMITTED_HIGHER_SEQ_AI_330000'},
        createdAt:new Date(OLD.getTime()+4000),
      },select:{id:true,seq:true},
    })
    expect(committed.seq).toBeGreaterThan(pending.seq)

    action=(
      kind==='assignment'
        ?globalDb.conversation.update({
          where:{id:f.conversationId},
          data:{assignedUserId:userId},
        })
        :globalDb.message.create({
          data:{
            tenantId:f.tenantId,conversationId:f.conversationId,
            senderType:'agent',senderUserId:userId,contentType:'text',
            content:{text:'FIRST_HUMAN_REPLY'},status:'sent',
            createdAt:new Date(OLD.getTime()+5000),
          },
        })
    ).then(v=>{finished=true;return v})

    order=await waitForHumanCompletionOrDbBlocking(pending.pid,()=>finished)
  }finally{
    // Always release the writer even on assertion failure. Avoid leaving a
    // 18-second live transaction that contaminates subsequent DB suites.
    releaseWriter()
    await writerTask
  }
  if(!pending||!action||!order)throw Error('Commit-order test was not synchronized')
  await action

  // If takeover committed before writer's release, the in-flight AI message
  // MUST NOT be treated as pre-handoff despite its smaller allocated seq.
  const conversation=await globalDb.conversation.findUniqueOrThrow({
    where:{id:f.conversationId},
    select:{handoffSourceSeq:true},
  })
  expect(conversation.handoffSourceSeq).not.toBeNull()
  const result=await withTenant(f.tenantId,
    ()=>ensureConversationHandoffSummary(f.conversationId))
  expect(result).not.toBeNull()
  const saved=await globalDb.conversationHandoffSummary.findUniqueOrThrow({
    where:{tenantId_conversationId:{
      tenantId:f.tenantId,conversationId:f.conversationId,
    }},
  })
  expect(saved.summaryText).toContain('INITIAL_VALID_AI_RESPONSE_200000')
  expect(saved.summaryText).toContain('COMMITTED_HIGHER_SEQ_AI_330000')
  if(order==='human-first'){
    // The other AI write committed AFTER human takeover. A sequence value
    // allocated before takeover is NOT sufficient proof of committed order.
    expect(saved.sourceMessageIds).not.toContain(pending.id)
    expect(saved.summaryText).not.toContain(pendingText)
  }else{
    // A valid serialization solution blocks takeover until the pending AI
    // writer completes; including it is then legitimate.
    expect(saved.sourceMessageIds).toContain(pending.id)
    expect(saved.summaryText).toContain(pendingText)
  }
}

describe('Reviewer AI-Q6 — committed order defeats allocated SERIAL order',()=>{
  test('in-flight lower-seq AI write vs first human assignment',async()=>{
    await runCommitOrderRace(await setup(),'assignment')
  },30000)
  test('in-flight lower-seq AI write vs first agent reply trigger',async()=>{
    await runCommitOrderRace(await setup(),'agent')
  },30000)
})
