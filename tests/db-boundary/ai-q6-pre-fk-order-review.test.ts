/// <reference types="bun-types" />
/**
 * IMMUTABLE INDEPENDENT REVIEWER Q6 — message seq allocated BEFORE FK lock.
 *
 * A PostgreSQL SERIAL DEFAULT runs before BEFORE INSERT triggers and before
 * the AFTER INSERT foreign-key check that locks Conversation FOR KEY SHARE.
 * Holding an advisory lock in a narrowly scoped test-only BEFORE INSERT
 * trigger exposes this real interval without mocking Prisma or the database.
 *
 * The human action may either:
 * - COMMIT while that insert is still pending: exclude the late writer.
 * - BLOCK behind an earlier per-conversation writer lock: then the writer
 *   commits first and may legitimately appear in the handoff summary.
 *
 * Both assignment and first agent reply are covered. All PostgreSQL schema
 * test hooks are dropped in finally, including on assertion failure.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {globalDb,withTenant} from '../../src/lib/db'
import {ensurePlansSeeded} from '../../src/lib/payments/plans'
import {ensureConversationHandoffSummary} from '../../src/lib/ai/handoff-summary'

const label=Date.now().toString(36)+Math.random().toString(36).slice(2,8)
const tenantIds:string[]=[]
let humanId='',iteration=0
const EARLY=new Date('2026-10-01T11:00:00.000Z')

beforeAll(async()=>{
  await ensurePlansSeeded()
  humanId=(await globalDb.user.create({data:{
    email:'q6-before-fk-'+label+'@test.com',
  },select:{id:true}})).id
})
afterAll(async()=>{
  for(const id of tenantIds.reverse())
    await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  if(humanId)await globalDb.user.delete({where:{id:humanId}}).catch(()=>{})
})
async function fixture(){
  const index=++iteration
  const tenantId=(await globalDb.tenant.create({data:{
    slug:'q6-before-fk-'+label+'-'+index,name:'Q6 Before FK Reviewer',plan:'pro',
  },select:{id:true}})).id
  tenantIds.push(tenantId)
  const contactId=(await globalDb.contact.create({data:{
    tenantId,identifier:'q6-before-fk-contact-'+label+'-'+index,
    identifierType:'visitorId',metadata:{},
  },select:{id:true}})).id
  const conversationId=(await globalDb.conversation.create({data:{
    tenantId,contactId,status:'open',channel:'widget',tags:[],
  },select:{id:true}})).id
  await globalDb.message.createMany({data:[
    {tenantId,conversationId,senderType:'contact',contentType:'text',status:'sent',
      content:{text:'INITIAL_VISITOR_FACT'},createdAt:EARLY},
    {tenantId,conversationId,senderType:'ai',contentType:'text',status:'sent',
      content:{text:'INITIAL_AI_GROUNDED_220000'},createdAt:new Date(EARLY.getTime()+1000)},
  ]})
  return {tenantId,conversationId}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
type Row={id:string,seq:number}

function deferred<T>(){
  let resolve!:(value:T)=>void
  const promise=new Promise<T>(r=>resolve=r)
  return {promise,resolve}
}
async function blockingPids(pid:number):Promise<number[]>{
  const r=await globalDb.$queryRaw<Array<{pids:number[]}>>`
    SELECT pg_blocking_pids(${pid}::integer) AS pids
  `
  return r[0]?.pids||[]
}
async function observe(
  fn:()=>Promise<'ready'|'wait'|'pending'>,
  description:string,
):Promise<'ready'|'wait'>{
  const end=Date.now()+8000
  while(Date.now()<end){
    const result=await fn()
    if(result==='ready'||result==='wait')return result
    await Bun.sleep(30)
  }
  throw Error('Did not observe completion or database lock ordering: '+description)
}
async function race(kind:'assignment'|'agent'){
  const f=await fixture()
  const pendingText='PENDING_LOW_SEQ_BEFORE_FK_'+kind.toUpperCase()
  const highText='COMMITTED_HIGH_SEQ_CONTEXT_'+kind.toUpperCase()
  const hook='q6_review_before_fk_'+label.replace(/[^a-z0-9]/g,'')+'_'+iteration
  const lockNamespace=60466
  const lockKey=100000+((Date.now()+iteration*17)%100000000)
  // Test hook is narrowly restricted to this fixture's message content and
  // tenant, and runs AFTER a DEFAULT seq was allocated but BEFORE FK checks.
  const functionSql=`CREATE FUNCTION "${hook}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${lockNamespace}, ${lockKey});
      RETURN NEW;
    END
  $$`
  const triggerSql=`CREATE TRIGGER "${hook}" BEFORE INSERT ON "Message"
    FOR EACH ROW WHEN (
      NEW."tenantId" = '${f.tenantId}'
      AND NEW."content"->>'text' = '${pendingText}'
    ) EXECUTE FUNCTION "${hook}"()`
  await globalDb.$executeRawUnsafe(functionSql)
  await globalDb.$executeRawUnsafe(triggerSql)

  const hold=deferred<void>()
  const blockerReady=deferred<number>()
  const writerPidReady=deferred<number>()
  const highPidReady=deferred<number>()
  const humanPidReady=deferred<number>()
  let releaseHold=false
  function release(){if(!releaseHold){releaseHold=true;hold.resolve()}}
  let blockerTask:Promise<void>|undefined
  let writerTask:Promise<Row>|undefined
  let highTask:Promise<Row>|undefined
  let humanTask:Promise<unknown>|undefined
  let highCompleted=false,humanCompleted=false
  let highWasCommittedBeforeTakeover=false
  let humanFirst=false
  let writerFirst=false
  try{
    blockerTask=globalDb.$transaction(async tx=>{
      const pid=(await tx.$queryRaw<Array<{pid:number}>>`
        SELECT pg_backend_pid() AS pid
      `)[0].pid
      await tx.$queryRaw`SELECT 1::integer AS ok FROM
        pg_advisory_xact_lock(${lockNamespace}::integer,${lockKey}::integer)`
      blockerReady.resolve(pid)
      await hold.promise
    },{timeout:22000,maxWait:10000})
    const blockerPid=await blockerReady.promise

    writerTask=globalDb.$transaction(async tx=>{
      const pid=(await tx.$queryRaw<Array<{pid:number}>>`
        SELECT pg_backend_pid() AS pid
      `)[0].pid
      writerPidReady.resolve(pid)
      return tx.message.create({data:{
        tenantId:f.tenantId,conversationId:f.conversationId,
        senderType:'ai',contentType:'text',status:'sent',
        content:{text:pendingText},createdAt:new Date(EARLY.getTime()+2000),
      },select:{id:true,seq:true}})
    },{timeout:22000,maxWait:10000})
    const writerPid=await writerPidReady.promise
    await observe(async()=>(
      (await blockingPids(writerPid)).includes(blockerPid)?'wait':'pending'
    ),'writer held in test BEFORE INSERT trigger before FK check')

    highTask=globalDb.$transaction(async tx=>{
      const pid=(await tx.$queryRaw<Array<{pid:number}>>`
        SELECT pg_backend_pid() AS pid
      `)[0].pid
      highPidReady.resolve(pid)
      return tx.message.create({data:{
        tenantId:f.tenantId,conversationId:f.conversationId,
        senderType:'ai',contentType:'text',status:'sent',
        content:{text:highText},createdAt:new Date(EARLY.getTime()+3000),
      },select:{id:true,seq:true}})
    },{timeout:22000,maxWait:10000})
    highTask.then(()=>{highCompleted=true},()=>{})
    const highPid=await highPidReady.promise

    // Old implementation lets a later sequence commit while the earlier
    // sequence is blocked before its FK check. A correct per-conversation
    // writer lock instead forces the later writer to wait.
    await observe(async()=>{
      if(highCompleted)return 'ready'
      const pids=await blockingPids(highPid)
      if(pids.includes(writerPid))return 'wait'
      return 'pending'
    },'higher-sequence writer completion or serializing lock')
    highWasCommittedBeforeTakeover=highCompleted

    humanTask=globalDb.$transaction(async tx=>{
      const pid=(await tx.$queryRaw<Array<{pid:number}>>`
        SELECT pg_backend_pid() AS pid
      `)[0].pid
      humanPidReady.resolve(pid)
      if(kind==='assignment')
        return tx.conversation.update({where:{id:f.conversationId},
          data:{assignedUserId:humanId}})
      return tx.message.create({data:{
        tenantId:f.tenantId,conversationId:f.conversationId,
        senderType:'agent',senderUserId:humanId,
        contentType:'text',status:'sent',content:{text:'FIRST_AGENT_TAKEOVER'},
        createdAt:new Date(EARLY.getTime()+4000),
      }})
    },{timeout:22000,maxWait:10000})
    humanTask.then(()=>{humanCompleted=true},()=>{})
    const humanPid=await humanPidReady.promise
    const outcome=await observe(async()=>{
      if(humanCompleted)return 'ready'
      const humanBlocking=await blockingPids(humanPid)
      if(humanBlocking.includes(writerPid)||humanBlocking.includes(highPid))
        return 'wait'
      return 'pending'
    },'human takeover committing or blocking behind pending message writer')
    humanFirst=outcome==='ready'
    writerFirst=outcome==='wait'
  } finally {
    release()
    // Do not leave SQL transaction handles alive on failed assertions.
    await Promise.allSettled([blockerTask,writerTask,highTask,humanTask].filter(Boolean))
    await globalDb.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${hook}" ON "Message"`)
    await globalDb.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${hook}"()`)
  }

  if(!writerTask||!highTask||!humanTask||(!humanFirst&&!writerFirst))
    throw Error('Could not establish real PG commit-order outcome')
  const [lower,higher]=await Promise.all([writerTask,highTask])
  expect(lower.seq).toBeLessThan(higher.seq)
  const source=await globalDb.conversation.findUniqueOrThrow({
    where:{id:f.conversationId},select:{handoffSourceSeq:true},
  })
  expect(source.handoffSourceSeq).not.toBeNull()
  const generated=await withTenant(f.tenantId,
    ()=>ensureConversationHandoffSummary(f.conversationId))
  expect(generated).not.toBeNull()
  const result=await globalDb.conversationHandoffSummary.findUniqueOrThrow({
    where:{tenantId_conversationId:{tenantId:f.tenantId,conversationId:f.conversationId}},
  })
  expect(result.summaryText).toContain('INITIAL_AI_GROUNDED_220000')
  if(humanFirst){
    // Human transaction committed while writer's allocated seq was held
    // BEFORE FK lock. That writer committed AFTER takeover: must exclude.
    expect(highWasCommittedBeforeTakeover).toBe(true)
    expect(result.sourceMessageIds).not.toContain(lower.id)
    expect(result.summaryText).not.toContain(pendingText)
  }else{
    // Proper serialization: earlier message transaction completed before
    // takeover. It can legitimately be included as pre-handoff evidence.
    expect(result.sourceMessageIds).toContain(lower.id)
    expect(result.summaryText).toContain(pendingText)
  }
}

describe('Reviewer AI-Q6 — seq allocation before FK check is not commit order',()=>{
  test('pending BEFORE-FK insert then assignment, with later seq committed first',async()=>{
    await race('assignment')
  },40000)
  test('pending BEFORE-FK insert then first agent reply, with later seq committed first',async()=>{
    await race('agent')
  },40000)
})
