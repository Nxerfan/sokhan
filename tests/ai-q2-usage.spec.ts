import {test,expect,type Page} from '@playwright/test'
import {otpSignupPlaywright} from './helpers/otp-signup'
import {setAccessMode} from './helpers/set-access'
/** Reviewer-owned AI-Q2 real Full/Lite API and dashboard acceptance.
 * No route mocks, fake LLM, test-only quota mutation endpoints, or sleeps.
 * Deterministic exact-FAQ replies come from the existing AI-Q1 fast path.
 */
const APP='http://127.0.0.1:3000'
const BASE='http://127.0.0.1:81'
const HEADERS={'Content-Type':'application/json'}
async function signup(page:Page,label:string){
  const stamp=label+'-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,6)
  const reg=await otpSignupPlaywright(page.request,APP,'q2-'+stamp+'@test.com','AIQ2-'+stamp)
  expect(reg.ok).toBe(true)
  const csrf=await page.request.get(APP+'/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const token=(await csrf.json()).csrfToken
  const login=await page.request.post(APP+'/api/auth/callback/credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data:'email=q2-'+stamp+'%40test.com&password=password123&csrfToken='+encodeURIComponent(token)+'&json=true',
  })
  expect(login.status()).toBeLessThan(500)
  await page.goto(BASE)
  const tenant=await page.request.get(APP+'/api/tenants/me')
  expect(tenant.ok(),await tenant.text()).toBe(true)
  const slug=(await tenant.json()).tenant?.slug as string|undefined
  expect(slug).toBeTruthy()
  return slug!
}
async function setPlan(page:Page,plan:'free'|'pro'|'max'){
  const r=await page.request.post(BASE+'/api/invitations/dev/set-plan',{data:{plan},headers:HEADERS})
  expect(r.ok(),await r.text()).toBe(true)
}
async function billing(page:Page){
  const r=await page.request.get(APP+'/api/billing/subscription')
  expect(r.ok(),await r.text()).toBe(true)
  return r.json() as Promise<{
    plan?:{slug:string,priceToman:number,limits:{aiActions:number}},
    usage:{aiActions:{current:number,limit:number},agents?:unknown,conversations?:unknown,departments?:unknown}
  }>
}
async function enableFaq(page:Page){
  const r=await page.request.patch(APP+'/api/ai-config',{data:{faqEnabled:true},headers:HEADERS})
  expect(r.ok(),await r.text()).toBe(true)
}
async function addFaq(page:Page,question:string,answer:string){
  const r=await page.request.post(APP+'/api/faqs',{data:{question,answer,enabled:true},headers:HEADERS})
  expect(r.ok(),await r.text()).toBe(true)
}
async function visitor(page:Page,slug:string){
  await setAccessMode(page,'anonymous')
  const r=await page.request.post(BASE+'/api/widget/'+slug+'/contact',{
    data:{visitorId:'q2-'+Date.now()+'-'+Math.random().toString(36).slice(2)},headers:HEADERS,
  })
  expect(r.ok(),await r.text()).toBe(true)
  const data=await r.json()
  expect(data.realtimeToken).toBeTruthy()
  return data.realtimeToken as string
}
async function send(page:Page,slug:string,token:string,text:string){
  const r=await page.request.post(BASE+'/api/widget/'+slug+'/messages',{
    headers:{...HEADERS,Authorization:'Bearer '+token},data:{text},
  })
  expect(r.status(),await r.text()).toBe(200)
  return r.json() as Promise<{conversationId:string,aiResponse?:{text:string,source:string}|null}>
}
async function getThread(page:Page,conversationId:string){
  const r=await page.request.get(APP+'/api/conversations/'+conversationId+'/messages')
  expect(r.ok(),await r.text()).toBe(true)
  return (await r.json()).messages as Array<{id:string,senderType:string,content:{text:string,source?:string}}>
}
function quota(x:Awaited<ReturnType<typeof billing>>){
  expect(x.usage?.aiActions).toBeTruthy()
  return x.usage.aiActions
}

test.describe('Reviewer AI-Q2 — real successful-reply quota in Full and Lite',()=>{
  test('public plan catalog exposes exact Pro/Max prices and monthly successful reply caps',async({request})=>{
    const r=await request.get(APP+'/api/billing/plans')
    expect(r.ok()).toBe(true)
    const plans=(await r.json()).plans as Array<{slug:string,priceToman:number,limits:{aiActions:number}}>
    expect(plans.find(x=>x.slug==='free')).toMatchObject({priceToman:0,limits:{aiActions:0}})
    expect(plans.find(x=>x.slug==='pro')).toMatchObject({priceToman:1200000,limits:{aiActions:1400}})
    expect(plans.find(x=>x.slug==='max')).toMatchObject({priceToman:7500000,limits:{aiActions:10000}})
    expect(plans.find(x=>x.slug==='self-hosted')?.limits.aiActions).toBe(-1)
  })
  test('unauthenticated Billing usage is not publicly accessible',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage()
      const r=await p.request.get(APP+'/api/billing/subscription')
      expect(r.status()).toBe(401)
    }finally{await ctx.close()}
  })
  test('Pro quota starts at ZERO used with limit 1400 in Billing API (not a fake zero hardcode)',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage()
      await signup(p,'pro-empty')
      await setPlan(p,'pro')
      const b=await billing(p)
      expect(quota(b)).toEqual({current:0,limit:1400})
      expect(b.usage.agents).toBeTruthy()
      expect(b.usage.conversations).toBeTruthy()
      expect(b.usage.departments).toBeTruthy()
    }finally{await ctx.close()}
  })
  test('successful Pro exact FAQ stores one deliverable AI reply and charges exactly one',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'one-paid')
      await setPlan(p,'pro')
      await enableFaq(p)
      const question='آیا امروز سفارش حضوری برای تست مصرف AI Q2 مجاز است؟'
      const answer='بله، پاسخ قطعی ثبت‌شده در FAQ برای تست مصرف.'
      await addFaq(p,question,answer)
      const token=await visitor(p,slug)
      const sent=await send(p,slug,token,question)
      expect(sent.aiResponse).toEqual({text:answer,source:'faq'})
      const thread=await getThread(p,sent.conversationId)
      const ai=thread.filter(x=>x.senderType==='ai')
      expect(ai).toHaveLength(1)
      expect(ai[0].content).toMatchObject({text:answer,source:'faq'})
      expect(quota(await billing(p))).toEqual({current:1,limit:1400})
    }finally{await ctx.close()}
  })
  test('two DISTINCT successful visitor turns create two AI rows, exactly two charged units',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'two-paid')
      await setPlan(p,'pro')
      await enableFaq(p)
      const question='کد تست جواب چندباره AI Q2 چیست؟'
      await addFaq(p,question,'پاسخ متنی تأییدشده.')
      const token=await visitor(p,slug)
      const one=await send(p,slug,token,question)
      const two=await send(p,slug,token,question)
      expect(one.aiResponse?.source).toBe('faq')
      expect(two.aiResponse?.source).toBe('faq')
      expect(quota(await billing(p))).toEqual({current:2,limit:1400})
      const msgs=await getThread(p,two.conversationId)
      expect(msgs.filter(x=>x.senderType==='ai')).toHaveLength(2)
    }finally{await ctx.close()}
  })
  test('disabled FAQ and visitor-only messages do not spend AI quota',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'nocharge')
      await setPlan(p,'pro')
      const q='آیا این FAQ بدون فعالسازی باید پاسخ بدهد؟'
      await addFaq(p,q,'خیر')
      const token=await visitor(p,slug)
      const one=await send(p,slug,token,q)
      expect(one.aiResponse).toBeNull()
      const two=await send(p,slug,token,'یک پیام دیگر بدون فعال بودن AI')
      expect(two.aiResponse).toBeNull()
      expect(quota(await billing(p))).toEqual({current:0,limit:1400})
    }finally{await ctx.close()}
  })
  test('Free keeps AI disabled, visitor messaging works and quota stays zero',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'free')
      await enableFaq(p)
      const q='تست رایگان سهمیه پاسخ هوش مصنوعی'
      await addFaq(p,q,'پاسخ نباید ارسال شود')
      const token=await visitor(p,slug)
      const sent=await send(p,slug,token,q)
      expect(sent.conversationId).toBeTruthy()
      expect(sent.aiResponse).toBeNull()
      expect((await getThread(p,sent.conversationId)).filter(x=>x.senderType==='ai')).toHaveLength(0)
      expect(quota(await billing(p))).toEqual({current:0,limit:0})
    }finally{await ctx.close()}
  })
  test('Max uses cap 10000 and bills an exact FAQ reply as one operation',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'max')
      await setPlan(p,'max')
      await enableFaq(p)
      const q='آیا برای Max این FAQ پاسخ دارد؟',answer='بله، پاسخ اختصاصی Max.'
      await addFaq(p,q,answer)
      const token=await visitor(p,slug)
      const sent=await send(p,slug,token,q)
      expect(sent.aiResponse?.text).toBe(answer)
      expect(quota(await billing(p))).toEqual({current:1,limit:10000})
    }finally{await ctx.close()}
  })
  test('different tenants never see or consume each others AI replies',async({browser})=>{
    const ca=await browser.newContext(),cb=await browser.newContext()
    try{
      const a=await ca.newPage(),b=await cb.newPage()
      const slug=await signup(a,'tenant-a')
      await signup(b,'tenant-b')
      await setPlan(a,'pro')
      await setPlan(b,'pro')
      await enableFaq(a)
      await addFaq(a,'آیا تست تفکیک مستأجر A انجام می‌شود؟','بله، فقط برای A')
      const token=await visitor(a,slug)
      await send(a,slug,token,'آیا تست تفکیک مستأجر A انجام می‌شود؟')
      expect(quota(await billing(a))).toEqual({current:1,limit:1400})
      expect(quota(await billing(b))).toEqual({current:0,limit:1400})
    }finally{await ca.close();await cb.close()}
  })
  test('Billing dashboard visually renders the actual AI usage numerator and denominator',async({browser})=>{
    const ctx=await browser.newContext({viewport:{width:1280,height:820}})
    try{
      const p=await ctx.newPage(),slug=await signup(p,'ui-billing')
      await setPlan(p,'pro')
      await enableFaq(p)
      const q='آیا شمارنده AI در پنل دیده می‌شود؟'
      await addFaq(p,q,'بله، شمارنده درست است.')
      const token=await visitor(p,slug)
      await send(p,slug,token,q)
      await p.goto(BASE)
      await p.getByRole('navigation',{name:'primary'}).getByRole('button',{name:/صورتحساب|Billing/}).click()
      await expect(p.getByTestId('billing-ai-usage')).toBeVisible()
      await expect(p.getByTestId('billing-ai-usage-current')).toHaveText(/1|۱/)
      await expect(p.getByTestId('billing-ai-usage-limit')).toHaveText(/1[,.٬]?400|۱[٬,]?۴۰۰/)
    }finally{await ctx.close()}
  })
  test('retrying the SAME clientMessageId cannot create another visitor message or bill a duplicate AI answer',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'idempotent-http')
      await setPlan(p,'pro')
      await enableFaq(p)
      const question='آیا درخواست تکراری باید دوبار از سهمیه کم کند؟'
      const answer='خیر، پاسخ تکراری فقط یک بار ثبت و محاسبه می‌شود.'
      await addFaq(p,question,answer)
      const token=await visitor(p,slug)
      const clientMessageId='cmsg_q2_http_retry_'+Date.now()
      const sendRetry=()=>p.request.post(BASE+'/api/widget/'+slug+'/messages',{
        headers:{...HEADERS,Authorization:'Bearer '+token},
        data:{text:question,clientMessageId},
      })
      const first=await sendRetry()
      expect(first.status(),await first.text()).toBe(200)
      const initial=await first.json() as {conversationId:string,message:{id:string}}
      expect(initial.message.id).toBeTruthy()
      const retry=await sendRetry()
      expect(retry.status(),await retry.text()).toBe(200)
      const again=await retry.json() as {conversationId:string,message:{id:string}}
      expect(again.message.id,'Same clientMessageId must resolve to the original persisted visitor message').toBe(initial.message.id)
      const concurrent=await Promise.all(Array.from({length:3},()=>sendRetry()))
      for(const response of concurrent)expect(response.status(),await response.text()).toBe(200)
      for(const response of concurrent){
        const body=await response.json() as {message:{id:string}}
        expect(body.message.id).toBe(initial.message.id)
      }
      const messages=await getThread(p,initial.conversationId)
      expect(messages.filter(x=>x.senderType==='contact'&&x.content.text===question)).toHaveLength(1)
      const replies=messages.filter(x=>x.senderType==='ai')
      expect(replies).toHaveLength(1)
      expect(replies[0].content).toMatchObject({text:answer,source:'faq'})
      expect(quota(await billing(p))).toEqual({current:1,limit:1400})
    }finally{await ctx.close()}
  })

})
