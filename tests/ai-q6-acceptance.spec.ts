import {test,expect,type Page} from '@playwright/test'
import {globalDb} from '@/lib/db'
import {otpSignupPlaywright} from './helpers/otp-signup'
import {setAccessMode} from './helpers/set-access'

/**
 * INDEPENDENT REVIEWER AI-Q6 — real HTTP + real PostgreSQL + real inbox DOM.
 * Immutable acceptance. Do not mock Prisma, responses, sessions or AI.
 * Tests Q6 only; focused cross-feature Q2/Q4/Q5 assertions are intentional.
 */
const APP='http://127.0.0.1:3000'
const BASE='http://127.0.0.1:81'
const H={'Content-Type':'application/json'}
const unique=()=> 'q6-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,9)
type Owner={page:Page,tenantId:string,slug:string,userId:string}
type Visitor={token:string,contactId:string,name:string}
type Sent={conversationId:string,message:{id:string},aiResponse:{source:string,text:string}|null}

async function owner(page:Page,tag:string,plan:'free'|'pro'='pro'):Promise<Owner>{
  const id=tag+'-'+unique(),email=id+'@test.com'
  expect((await otpSignupPlaywright(page.request,APP,email,'Q6 '+id)).ok).toBe(true)
  const csrf=await page.request.get(APP+'/api/auth/csrf')
  expect(csrf.status()).toBe(200)
  const {csrfToken}=await csrf.json()
  const login=await page.request.post(APP+'/api/auth/callback/credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data:'email='+encodeURIComponent(email)+'&password=password123&csrfToken='+encodeURIComponent(csrfToken)+'&json=true',
  })
  expect(login.status(),await login.text()).toBeLessThan(400)
  const me=await page.request.get(APP+'/api/tenants/me')
  expect(me.status(),await me.text()).toBe(200)
  const {tenant}=await me.json() as {tenant:{id:string,slug:string}}
  const membership=await globalDb.membership.findFirst({
    where:{tenantId:tenant.id,status:'active',role:'owner'},select:{userId:true},
  })
  expect(membership?.userId).toBeTruthy()
  if(plan!=='free'){
    const pro=await page.request.post(BASE+'/api/invitations/dev/set-plan',{headers:H,data:{plan}})
    expect(pro.status(),await pro.text()).toBe(200)
  }
  const conf=await page.request.patch(APP+'/api/ai-config',{
    headers:H,data:{faqEnabled:false,productQaEnabled:plan!=='free'},
  })
  expect(conf.status(),await conf.text()).toBe(200)
  if(plan!=='free'){
    const p=await page.request.post(APP+'/api/products',{
      headers:H,data:{name:'چراغ ویژه بهار',price:654321,availability:'in_stock',description:'نور ویژه'},
    })
    expect(p.status(),await p.text()).toBe(200)
  }
  await setAccessMode(page,'anonymous')
  await page.goto(BASE)
  return {page,tenantId:tenant.id,slug:tenant.slug,userId:membership!.userId}
}
async function visitor(o:Owner):Promise<Visitor>{
  const name='Q6Visitor-'+unique()
  const r=await o.page.request.post(BASE+'/api/widget/'+o.slug+'/contact',{
    headers:H,data:{visitorId:unique(),name},
  })
  expect(r.status(),await r.text()).toBe(200)
  const d=await r.json() as {contactId:string,realtimeToken:string}
  return {contactId:d.contactId,token:d.realtimeToken,name}
}
async function send(o:Owner,v:Visitor,text='قیمت چراغ ویژه بهار'):Promise<Sent>{
  const r=await o.page.request.post(BASE+'/api/widget/'+o.slug+'/messages',{
    headers:{...H,Authorization:'Bearer '+v.token},data:{text},
  })
  expect(r.status(),await r.text()).toBe(200)
  return r.json()
}
async function bill(o:Owner){
  const r=await o.page.request.get(APP+'/api/billing/subscription')
  expect(r.status(),await r.text()).toBe(200)
  return (await r.json()).usage.aiActions.current as number
}
async function handoff(o:Owner,id:string){
  const r=await o.page.request.get(APP+'/api/conversations/'+id+'/handoff-summary')
  expect(r.status(),await r.text()).toBe(200)
  return (await r.json()).summary as null|{text:string,sourceMessageIds:string[],createdAt:string}
}
async function assign(o:Owner,id:string){
  const r=await o.page.request.patch(APP+'/api/conversations/'+id,{
    headers:H,data:{assignedUserId:o.userId},
  })
  expect(r.status(),await r.text()).toBe(200)
}
async function agentReply(o:Owner,id:string,text='اپراتور پاسخ می‌دهد'){
  const r=await o.page.request.post(APP+'/api/conversations/'+id+'/messages',{
    headers:H,data:{text},
  })
  expect(r.status(),await r.text()).toBe(200)
}
async function countRows(o:Owner,id:string){
  return globalDb.conversationHandoffSummary.count({where:{tenantId:o.tenantId,conversationId:id}})
}
async function inboxSelect(o:Owner,preview:string){
  const nav=o.page.getByRole('navigation',{name:'primary'})
  await nav.getByRole('button',{name:/صندوق ورودی|Inbox/}).click()
  const item=o.page.locator('button').filter({hasText:preview}).first()
  await expect(item).toBeVisible({timeout:15000})
  await item.click()
}

test.describe('Reviewer AI-Q6 — no-cost grounded human handoff (real Full and Lite)',()=>{
  test('1. real Q4 product AI answer → real human assignment → dashboard-only summary, no extra charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'assign'),v=await visitor(o)
      const first=await send(o,v)
      expect(first.aiResponse?.source).toBe('product')
      expect(await bill(o)).toBe(1)
      expect(await handoff(o,first.conversationId)).toBeNull()
      await assign(o,first.conversationId)
      const summary=await handoff(o,first.conversationId)
      expect(summary).not.toBeNull()
      expect(summary!.text).toContain('چراغ ویژه بهار')
      expect(summary!.text.replace(/[\u066c\u060c,\s]/g,'')).toMatch(/654321|۶۵۴۳۲۱/)
      const rows=await globalDb.message.findMany({
        where:{tenantId:o.tenantId,conversationId:first.conversationId},
      })
      expect(summary!.sourceMessageIds.every(id=>rows.some(m=>m.id===id))).toBe(true)
      expect(await countRows(o,first.conversationId)).toBe(1)
      expect(await bill(o)).toBe(1)
      expect(rows.filter(x=>x.senderType==='ai')).toHaveLength(1)
      await inboxSelect(o,v.name)
      const panel=o.page.getByTestId('ai-q6-handoff-summary')
      await expect(panel).toBeVisible({timeout:10000})
      await expect(panel).toContainText('چراغ ویژه بهار')
    }finally{await ctx.close()}
  })

  test('2. real agent reply triggers summary, never another AI reply or charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'agent'),v=await visitor(o)
      const first=await send(o,v)
      expect(first.aiResponse?.source).toBe('product')
      await agentReply(o,first.conversationId)
      expect((await handoff(o,first.conversationId))?.text).toContain('چراغ ویژه بهار')
      const later=await send(o,v,'آیا چراغ موجود است؟')
      expect(later.aiResponse).toBeNull()
      expect(await bill(o)).toBe(1)
      expect(await countRows(o,first.conversationId)).toBe(1)
      const ai=await globalDb.message.count({where:{
        conversationId:first.conversationId,tenantId:o.tenantId,senderType:'ai',
      }})
      expect(ai).toBe(1)
    }finally{await ctx.close()}
  })

  test('3. no previous AI reply → no handoff record, no UI panel or AI charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'no-ai'),v=await visitor(o)
      const first=await send(o,v,'سلام')
      expect(first.aiResponse).toBeNull()
      await assign(o,first.conversationId)
      expect(await handoff(o,first.conversationId)).toBeNull()
      expect(await countRows(o,first.conversationId)).toBe(0)
      expect(await bill(o)).toBe(0)
      await inboxSelect(o,v.name)
      await expect(o.page.getByTestId('ai-q6-handoff-summary')).toHaveCount(0)
    }finally{await ctx.close()}
  })

  test('4. Free plan denies summary even for persisted historical AI source; no quota mutation',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'free','free'),v=await visitor(o)
      const first=await send(o,v,'سلام')
      expect(first.aiResponse).toBeNull()
      await globalDb.message.create({data:{
        tenantId:o.tenantId,conversationId:first.conversationId,senderType:'ai',
        contentType:'text',status:'sent',content:{text:'HISTORIC_AI_SHOULD_NOT_UNLOCK_FREE'},
        // Historical Q2 backfill correctly counts sent AI messages inside
        // the current billing period. This fixture must be historical in
        // TIME, not just by label; Q6 is still prohibited on Free.
        createdAt:new Date('2025-01-01T00:00:00.000Z'),
      }})
      await assign(o,first.conversationId)
      expect(await handoff(o,first.conversationId)).toBeNull()
      expect(await countRows(o,first.conversationId)).toBe(0)
      expect(await bill(o)).toBe(0)
    }finally{await ctx.close()}
  })

  test('5. unauthenticated visitor cannot read handoff data via dashboard API or widget reply',async({browser})=>{
    const ctx=await browser.newContext(),anonymous=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'privacy'),v=await visitor(o)
      const first=await send(o,v)
      await assign(o,first.conversationId)
      expect(await handoff(o,first.conversationId)).not.toBeNull()
      const unauth=await anonymous.request.get(APP+'/api/conversations/'+first.conversationId+'/handoff-summary')
      expect([401,403,404]).toContain(unauth.status())
      expect(await unauth.text()).not.toContain('چراغ ویژه بهار')
      const later=await send(o,v,'سلام مجدد')
      expect(JSON.stringify(later)).not.toContain('handoffSummary')
      expect(JSON.stringify(later)).not.toContain('sourceMessageIds')
      expect(await bill(o)).toBe(1)
    }finally{await ctx.close();await anonymous.close()}
  })

  test('6. another logged-in tenant cannot read or change this tenant handoff',async({browser})=>{
    const aCtx=await browser.newContext(),bCtx=await browser.newContext()
    try{
      const a=await owner(await aCtx.newPage(),'tenant-a'),b=await owner(await bCtx.newPage(),'tenant-b')
      const v=await visitor(a),first=await send(a,v)
      await assign(a,first.conversationId)
      expect(await handoff(a,first.conversationId)).not.toBeNull()
      const request=b.page.request
      const foreign=await request.get(APP+'/api/conversations/'+first.conversationId+'/handoff-summary')
      expect([403,404]).toContain(foreign.status())
      expect(await foreign.text()).not.toContain('چراغ ویژه بهار')
      const write=await request.post(APP+'/api/conversations/'+first.conversationId+'/handoff-summary',{headers:H,data:{text:'FORGED'}})
      expect([403,404,405]).toContain(write.status())
      expect(await countRows(a,first.conversationId)).toBe(1)
    }finally{await aCtx.close();await bCtx.close()}
  })

  test('7. repeated assignment and agent reply preserve the first handoff and exactly-once billing',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'repeat'),v=await visitor(o)
      const first=await send(o,v)
      expect(first.aiResponse).not.toBeNull()
      await assign(o,first.conversationId)
      const original=await handoff(o,first.conversationId)
      expect(original).not.toBeNull()
      await Promise.all([assign(o,first.conversationId),assign(o,first.conversationId)])
      await agentReply(o,first.conversationId,'اپراتور پاسخ داده است')
      const after=await handoff(o,first.conversationId)
      expect(after).toEqual(original)
      expect(await countRows(o,first.conversationId)).toBe(1)
      expect(await bill(o)).toBe(1)
    }finally{await ctx.close()}
  })

  test('8. hostile HTML in sourced message renders as text in the inbox, never executes',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const o=await owner(await ctx.newPage(),'xss'),v=await visitor(o)
      const first=await send(o,v)
      const hostile='<img src=x onerror=alert(42)>'
      await globalDb.message.create({data:{
        tenantId:o.tenantId,conversationId:first.conversationId,
        senderType:'contact',contentType:'text',status:'sent',content:{text:hostile},
      }})
      await assign(o,first.conversationId)
      await inboxSelect(o,v.name)
      const panel=o.page.getByTestId('ai-q6-handoff-summary')
      await expect(panel).toBeVisible({timeout:10000})
      expect(await panel.locator('script,img,iframe,svg,object,embed').count()).toBe(0)
      expect(await o.page.evaluate(()=> (window as unknown as {__q6Xss?:boolean}).__q6Xss)).toBeUndefined()
      expect(await bill(o)).toBe(1)
    }finally{await ctx.close()}
  })
})
