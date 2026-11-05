import {test,expect,type Page} from '@playwright/test'
import {globalDb} from '@/lib/db'
import {otpSignupPlaywright} from './helpers/otp-signup'
import {setAccessMode} from './helpers/set-access'

/**
 * Independent reviewer AI-Q5 real HTTP/PostgreSQL/AI billing acceptance.
 * No fake provider, no mocked Prisma and no disabling prior Q4 behavior.
 * Tenant owner acts as agent through the REAL dashboard messages endpoint.
 */
const APP='http://127.0.0.1:3000'
const BASE='http://127.0.0.1:81'
const H={'Content-Type':'application/json'}
const unique=()=> 'q5-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)
type Owner={page:Page,tenantId:string,slug:string,agentUserId:string}
type Visitor={token:string,contactId:string}
type SendResult={message:{id:string},conversationId:string,aiResponse:{source:string,text:string}|null}
async function owner(page:Page,label:string):Promise<Owner>{
  const stamp=label+'-'+unique(),email=stamp+'@test.com'
  expect((await otpSignupPlaywright(page.request,APP,email,'AIQ5 '+stamp)).ok).toBe(true)
  const csrf=await page.request.get(APP+'/api/auth/csrf')
  expect(csrf.status()).toBe(200)
  const {csrfToken}=await csrf.json()
  const login=await page.request.post(APP+'/api/auth/callback/credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data:'email='+encodeURIComponent(email)+'&password=password123&csrfToken='+encodeURIComponent(csrfToken)+'&json=true',
  })
  expect(login.status(),await login.text()).toBeLessThan(400)
  await page.goto(BASE)
  const me=await page.request.get(APP+'/api/tenants/me')
  expect(me.status(),await me.text()).toBe(200)
  const {tenant}=await me.json() as {tenant:{id:string,slug:string}}
  expect(tenant.id).toBeTruthy();expect(tenant.slug).toBeTruthy()
  const membership=await globalDb.membership.findFirst({
    where:{tenantId:tenant.id,status:'active',role:'owner'},
    select:{userId:true},
  })
  expect(membership?.userId).toBeTruthy()
  const pro=await page.request.post(BASE+'/api/invitations/dev/set-plan',{headers:H,data:{plan:'pro'}})
  expect(pro.status(),await pro.text()).toBe(200)
  const ai=await page.request.patch(APP+'/api/ai-config',{headers:H,data:{faqEnabled:false,productQaEnabled:true}})
  expect(ai.status(),await ai.text()).toBe(200)
  const item=await page.request.post(APP+'/api/products',{
    headers:H,data:{name:'چراغ ویژه بهار',price:654321,availability:'in_stock',description:'نور ویژه'},
  })
  expect(item.status(),await item.text()).toBe(200)
  await setAccessMode(page,'anonymous')
  return {page,tenantId:tenant.id,slug:tenant.slug,agentUserId:membership!.userId}
}
async function visitor(o:Owner):Promise<Visitor>{
  const r=await o.page.request.post(BASE+'/api/widget/'+o.slug+'/contact',{
    headers:H,data:{visitorId:unique()},
  })
  expect(r.status(),await r.text()).toBe(200)
  const body=await r.json() as {contactId:string,realtimeToken:string}
  expect(body.contactId).toBeTruthy()
  expect(body.realtimeToken).toBeTruthy()
  return {contactId:body.contactId,token:body.realtimeToken}
}
async function openConversation(o:Owner,v:Visitor){
  const row=await globalDb.conversation.create({data:{
    tenantId:o.tenantId,contactId:v.contactId,status:'open',channel:'widget',tags:[],
  }})
  return row.id
}
async function send(o:Owner,v:Visitor,text='قیمت چراغ ویژه بهار',clientMessageId?:string):Promise<SendResult>{
  const r=await o.page.request.post(BASE+'/api/widget/'+o.slug+'/messages',{
    headers:{...H,Authorization:'Bearer '+v.token},
    data:{text,...(clientMessageId?{clientMessageId}:{})},
  })
  expect(r.status(),await r.text()).toBe(200)
  return r.json()
}
async function bill(o:Owner){
  const r=await o.page.request.get(APP+'/api/billing/subscription')
  expect(r.status(),await r.text()).toBe(200)
  return (await r.json()).usage.aiActions.current as number
}
async function persisted(conv:string){
  return globalDb.message.findMany({where:{conversationId:conv},orderBy:{createdAt:'asc'}})
}
async function assertNoAi(o:Owner,r:SendResult,expectedCharges=0){
  expect(r.aiResponse).toBeNull()
  expect((await persisted(r.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(expectedCharges)
  expect(await bill(o)).toBe(expectedCharges)
}

test.describe('Reviewer AI-Q5 — human takeover never double-replies or double-bills',()=>{
  test('1. unassigned conversation retains a truthful product AI response',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'baseline'),v=await visitor(o)
      const r=await send(o,v)
      expect(r.aiResponse?.source).toBe('product')
      expect(r.aiResponse?.text).toContain('چراغ ویژه بهار')
      expect(await bill(o)).toBe(1)
      expect((await persisted(r.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(1)
    }finally{await ctx.close()}
  })
  test('2. assigned agent blocks AI before human sends any message',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'assigned'),v=await visitor(o)
      const cid=await openConversation(o,v)
      await globalDb.conversation.update({where:{id:cid},data:{assignedUserId:o.agentUserId}})
      const r=await send(o,v)
      expect(r.conversationId).toBe(cid)
      await assertNoAi(o,r)
      expect((await persisted(cid)).filter(m=>m.senderType==='contact')).toHaveLength(1)
    }finally{await ctx.close()}
  })
  test('3. REAL human dashboard reply suppresses subsequent product AI',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'human'),v=await visitor(o)
      const first=await send(o,v,'سلام')
      expect(first.aiResponse).toBeNull()
      const human=await o.page.request.post(APP+'/api/conversations/'+first.conversationId+'/messages',{
        headers:H,data:{text:'اپراتور پاسخ می‌دهد'},
      })
      expect(human.status(),await human.text()).toBe(200)
      const response=await send(o,v)
      expect(response.conversationId).toBe(first.conversationId)
      await assertNoAi(o,response)
      const rows=await persisted(response.conversationId)
      expect(rows.filter(m=>m.senderType==='agent')).toHaveLength(1)
      expect(rows.filter(m=>m.senderType==='contact')).toHaveLength(2)
    }finally{await ctx.close()}
  })
  test('4. historic agent message blocks AI even when assignment and firstResponseAt are cleared',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'historic'),v=await visitor(o)
      const cid=await openConversation(o,v)
      await globalDb.message.create({data:{
        tenantId:o.tenantId,conversationId:cid,senderType:'agent',
        senderUserId:o.agentUserId,contentType:'text',
        content:{text:'Human answer'},status:'sent',
      }})
      await globalDb.conversation.update({where:{id:cid},data:{assignedUserId:null,firstResponseAt:null}})
      const r=await send(o,v)
      expect(r.conversationId).toBe(cid)
      await assertNoAi(o,r)
    }finally{await ctx.close()}
  })
  test('5. system routing message is NOT human takeover',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'system'),v=await visitor(o)
      const cid=await openConversation(o,v)
      await globalDb.message.create({data:{
        tenantId:o.tenantId,conversationId:cid,senderType:'system',
        contentType:'text',content:{text:'خوش آمدید'},status:'sent',
      }})
      const r=await send(o,v)
      expect(r.aiResponse?.source).toBe('product')
      expect(r.conversationId).toBe(cid)
      expect(await bill(o)).toBe(1)
    }finally{await ctx.close()}
  })
  test('6. AI may answer before takeover but never a new visitor message after takeover; retry stays idempotent',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'retry'),v=await visitor(o),key=unique()
      const first=await send(o,v,'قیمت چراغ ویژه بهار',key)
      expect(first.aiResponse?.source).toBe('product')
      expect(await bill(o)).toBe(1)
      const human=await o.page.request.post(APP+'/api/conversations/'+first.conversationId+'/messages',{
        headers:H,data:{text:'اکنون مسئول پاسخ‌گویی هستم'},
      })
      expect(human.status(),await human.text()).toBe(200)
      const retry=await send(o,v,'قیمت چراغ ویژه بهار',key)
      expect(retry.message.id).toBe(first.message.id)
      const later=await send(o,v,'موجودی چراغ ویژه بهار')
      expect(later.aiResponse).toBeNull()
      expect((await persisted(first.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await bill(o)).toBe(1)
    }finally{await ctx.close()}
  })
  test('7. another tenant\'s human reply cannot suppress this tenant AI',async({browser})=>{
    const ca=await browser.newContext(),cb=await browser.newContext()
    try{
      const a=await owner(await ca.newPage(),'tenant-a'),b=await owner(await cb.newPage(),'tenant-b')
      const va=await visitor(a),vb=await visitor(b)
      const cid=await openConversation(b,vb)
      await globalDb.message.create({data:{
        tenantId:b.tenantId,conversationId:cid,senderType:'agent',
        senderUserId:b.agentUserId,contentType:'text',
        content:{text:'Foreign human answer'},status:'sent',
      }})
      const aReply=await send(a,va)
      expect(aReply.aiResponse?.source).toBe('product')
      const bReply=await send(b,vb)
      expect(bReply.aiResponse).toBeNull()
      expect(await bill(a)).toBe(1)
      expect(await bill(b)).toBe(0)
    }finally{await ca.close();await cb.close()}
  })
})
