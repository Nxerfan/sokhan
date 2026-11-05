import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * INDEPENDENT REVIEWER AI-Q3 acceptance.
 * REAL app + PostgreSQL + owner API + visitor HTTP + persisted thread + Billing.
 * Run independently in BOTH Full and Lite. No API mocks / fake LLM / sleeps.
 * Semantic provider validation is tested separately with injected server-only unit seam.
 */
const APP='http://127.0.0.1:3000'
const BASE='http://127.0.0.1:81'
const HEADERS={'Content-Type':'application/json'}

async function signup(page:Page,label:string) {
  const stamp=label+'-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7)
  const email='aiq3-'+stamp+'@test.com'
  const reg=await otpSignupPlaywright(page.request,APP,email,'AIQ3-'+stamp)
  expect(reg.ok).toBe(true)
  const csrf=await page.request.get(APP+'/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const {csrfToken}=await csrf.json()
  const login=await page.request.post(APP+'/api/auth/callback/credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data:'email='+encodeURIComponent(email)+'&password=password123&csrfToken='+encodeURIComponent(csrfToken)+'&json=true',
  })
  expect(login.status(),await login.text()).toBeLessThan(500)
  await page.goto(BASE)
  const me=await page.request.get(APP+'/api/tenants/me')
  expect(me.ok(),await me.text()).toBe(true)
  const slug=(await me.json()).tenant?.slug as string
  expect(slug).toBeTruthy()
  return slug
}
async function pro(page:Page) {
  const r=await page.request.post(BASE+'/api/invitations/dev/set-plan',{headers:HEADERS,data:{plan:'pro'}})
  expect(r.ok(),await r.text()).toBe(true)
}
async function faqToggle(page:Page,on:boolean) {
  const r=await page.request.patch(APP+'/api/ai-config',{headers:HEADERS,data:{faqEnabled:on}})
  expect(r.status(),await r.text()).toBe(200)
}
async function addFaq(page:Page,question:string,answer:string,enabled=true) {
  const r=await page.request.post(APP+'/api/faqs',{headers:HEADERS,data:{question,answer,enabled}})
  expect(r.status(),await r.text()).toBe(200)
  return (await r.json()).faq as {id:string,question:string,answer:string,enabled:boolean}
}
async function updateFaq(page:Page,id:string,fields:{answer?:string,enabled?:boolean}) {
  const r=await page.request.patch(APP+'/api/faqs',{headers:HEADERS,data:{id,...fields}})
  expect(r.status(),await r.text()).toBe(200)
}
async function removeFaq(page:Page,id:string) {
  const r=await page.request.delete(APP+'/api/faqs?id='+encodeURIComponent(id))
  expect(r.status(),await r.text()).toBe(200)
}
async function visitor(page:Page,slug:string) {
  await setAccessMode(page,'anonymous')
  const r=await page.request.post(BASE+'/api/widget/'+slug+'/contact',{
    headers:HEADERS,data:{visitorId:'ai-q3-'+Date.now()+'-'+Math.random().toString(36).slice(2)},
  })
  expect(r.status(),await r.text()).toBe(200)
  const token=(await r.json()).realtimeToken as string
  expect(token).toBeTruthy()
  return token
}
async function send(page:Page,slug:string,token:string,text:string,clientMessageId?:string) {
  const r=await page.request.post(BASE+'/api/widget/'+slug+'/messages',{
    headers:{...HEADERS,Authorization:'Bearer '+token},
    data:{text,...(clientMessageId?{clientMessageId}:{})},
  })
  expect(r.status(),await r.text()).toBe(200)
  return r.json() as Promise<{message:{id:string},conversationId:string,aiResponse:{text:string,source:string}|null}>
}
async function thread(page:Page,conversationId:string) {
  const r=await page.request.get(APP+'/api/conversations/'+conversationId+'/messages')
  expect(r.status(),await r.text()).toBe(200)
  return (await r.json()).messages as Array<{id:string,senderType:string,content:{text?:string,source?:string}}>
}
async function billed(page:Page,limit=1400) {
  const r=await page.request.get(APP+'/api/billing/subscription')
  expect(r.status(),await r.text()).toBe(200)
  const x=(await r.json()).usage.aiActions as {current:number,limit:number}
  expect(x.limit).toBe(limit)
  return x.current
}

test.describe('Reviewer AI-Q3 — strict real FAQ delivery, accounting and isolation',()=>{
  test('Pro Persian Arabic-yeh orthography + whitespace delivers exact owner answer and ONE charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'persian-normalization')
      await pro(p);await faqToggle(p,true)
      const answer='تحویل فقط روزهای کاری انجام می‌شود.'
      await addFaq(p,'آيا   ارسال   با كد   تخفيف داريد؟',answer)
      const token=await visitor(p,slug)
      const reply=await send(p,slug,token,'آیا ارسال با کد تخفیف دارید؟')
      expect(reply.aiResponse).toEqual({text:answer,source:'faq'})
      const messages=await thread(p,reply.conversationId)
      expect(messages.filter(m=>m.senderType==='contact')).toHaveLength(1)
      expect(messages.filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(messages.find(m=>m.senderType==='ai')?.content).toMatchObject({text:answer,source:'faq'})
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('Persian ZWNJ and regular spaces are the same exact FAQ intent',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'zwnj')
      await pro(p);await faqToggle(p,true)
      await addFaq(p,'کالا چه زمانی ارسال می‌شود؟','تا پایان امروز.')
      const token=await visitor(p,slug)
      const msg=await send(p,slug,token,'کالا چه زمانی ارسال می شود؟')
      expect(msg.aiResponse).toEqual({text:'تا پایان امروز.',source:'faq'})
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('English case variation is a deterministic exact FAQ with no answer rewriting',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'casefold')
      await pro(p);await faqToggle(p,true)
      await addFaq(p,'WHAT IS YOUR RETURN POLICY?','Only unopened items within seven days.')
      const token=await visitor(p,slug)
      const msg=await send(p,slug,token,'what is your return policy?')
      expect(msg.aiResponse?.text).toBe('Only unopened items within seven days.')
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('canonical duplicate FAQs with conflicting answers MUST NOT choose first row, AI count stays zero',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'ambiguity')
      await pro(p);await faqToggle(p,true)
      const first=await addFaq(p,'آیا خدمات حضوری داریم؟','بله')
      const second=await addFaq(p,'آيا  خدمات  حضوري داريم?', 'خیر')
      const token=await visitor(p,slug)
      const msg=await send(p,slug,token,'آیا خدمات حضوری داریم؟')
      expect(msg.aiResponse,'Ambiguous canonical duplicate MUST NOT bill or choose one answer').toBeNull()
      expect((await thread(p,msg.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(0)
      expect(await billed(p)).toBe(0)
      await updateFaq(p,second.id,{enabled:false})
      const next=await send(p,slug,token,'آیا خدمات حضوری داریم؟')
      expect(next.aiResponse).toEqual({text:'بله',source:'faq'})
      expect((await thread(p,next.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await billed(p)).toBe(1)
      expect(first.id).not.toBe(second.id)
    }finally{await ctx.close()}
  })

  test('disabled FAQ does not answer or spend quota even when text is exact',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'disabled')
      await pro(p);await faqToggle(p,true)
      const record=await addFaq(p,'آیا ارسال فوری دارید؟','بله',false)
      const token=await visitor(p,slug)
      const old=await send(p,slug,token,'آیا ارسال فوری دارید؟')
      expect(old.aiResponse).toBeNull()
      expect(await billed(p)).toBe(0)
      await updateFaq(p,record.id,{enabled:true})
      const active=await send(p,slug,token,'آیا ارسال فوری دارید؟')
      expect(active.aiResponse).toEqual({text:'بله',source:'faq'})
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('FAQ feature OFF on Pro never replies even when enabled FAQ matches',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'feature-off')
      await pro(p)
      await addFaq(p,'آیا هدیه دارید؟','بله')
      const token=await visitor(p,slug)
      const out=await send(p,slug,token,'آیا هدیه دارید؟')
      expect(out.aiResponse).toBeNull()
      expect(await billed(p)).toBe(0)
    }finally{await ctx.close()}
  })

  test('Free built-in AI remains zero, exact FAQ cannot bypass quota',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'free-zero')
      await faqToggle(p,true)
      await addFaq(p,'آیا برای من پاسخ AI دارید؟','این نباید ارسال شود')
      const token=await visitor(p,slug)
      const out=await send(p,slug,token,'آیا برای من پاسخ AI دارید؟')
      expect(out.aiResponse).toBeNull()
      expect((await thread(p,out.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(0)
      expect(await billed(p,0)).toBe(0)
    }finally{await ctx.close()}
  })

  test('editing stored answer immediately changes the delivered answer without stale caching',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'answer-edit')
      await pro(p);await faqToggle(p,true)
      const q='آیا ضمانت تعویض دارید؟'
      const rec=await addFaq(p,q,'پاسخ قدیمی')
      const token=await visitor(p,slug)
      const a=await send(p,slug,token,q)
      expect(a.aiResponse?.text).toBe('پاسخ قدیمی')
      await updateFaq(p,rec.id,{answer:'پاسخ جدید'})
      const b=await send(p,slug,token,q)
      expect(b.aiResponse?.text).toBe('پاسخ جدید')
      expect((await thread(p,b.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(2)
      expect(await billed(p)).toBe(2)
    }finally{await ctx.close()}
  })

  test('deleting the only FAQ prevents any subsequent automatic reply or charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'delete')
      await pro(p);await faqToggle(p,true)
      const q='آیا کتاب راهنما موجود است؟'
      const rec=await addFaq(p,q,'بله')
      const token=await visitor(p,slug)
      const first=await send(p,slug,token,q)
      expect(first.aiResponse?.text).toBe('بله')
      await removeFaq(p,rec.id)
      const second=await send(p,slug,token,q)
      expect(second.aiResponse).toBeNull()
      expect((await thread(p,second.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('two paid tenants with same question always receive OWN stored answer, separate billing',async({browser})=>{
    const ca=await browser.newContext(),cb=await browser.newContext()
    try{
      const a=await ca.newPage(),b=await cb.newPage()
      const slugA=await signup(a,'tenant-a'),slugB=await signup(b,'tenant-b')
      await pro(a);await pro(b)
      await faqToggle(a,true);await faqToggle(b,true)
      const q='آیا هزینه ارسال جداست؟'
      await addFaq(a,q,'پاسخ اختصاصی مشتری A')
      await addFaq(b,q,'پاسخ اختصاصی مشتری B')
      const tokenA=await visitor(a,slugA),tokenB=await visitor(b,slugB)
      const sentA=await send(a,slugA,tokenA,q)
      const sentB=await send(b,slugB,tokenB,q)
      expect(sentA.aiResponse?.text).toBe('پاسخ اختصاصی مشتری A')
      expect(sentB.aiResponse?.text).toBe('پاسخ اختصاصی مشتری B')
      expect(await billed(a)).toBe(1)
      expect(await billed(b)).toBe(1)
    }finally{await ca.close();await cb.close()}
  })

  test('same HTTP clientMessageId replay after canonical exact FAQ creates one AI row/charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'retry')
      await pro(p);await faqToggle(p,true)
      const answer='فقط یک پاسخ واقعی.'
      await addFaq(p,'آيا  تست  تكرار داريم؟',answer)
      const token=await visitor(p,slug)
      const key='q3-retry-'+Date.now()
      const first=await send(p,slug,token,'آیا تست تکرار داریم؟',key)
      const replay=await send(p,slug,token,'آیا تست تکرار داریم؟',key)
      expect(first.message.id).toBe(replay.message.id)
      expect(first.conversationId).toBe(replay.conversationId)
      expect(replay.aiResponse?.text).toBe(answer)
      const messages=await thread(p,first.conversationId)
      expect(messages.filter(m=>m.senderType==='contact')).toHaveLength(1)
      expect(messages.filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('six parallel first POSTs for same normalized FAQ+key leave precisely one visitor and AI reply',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'concurrent')
      await pro(p);await faqToggle(p,true)
      await addFaq(p,'آیا سوال مشترک دارید؟','پاسخ ثابت')
      const token=await visitor(p,slug)
      const key='q3-parallel-'+Date.now()
      const responses=await Promise.all(Array.from({length:6},()=>p.request.post(
        BASE+'/api/widget/'+slug+'/messages',{
          headers:{...HEADERS,Authorization:'Bearer '+token},
          data:{text:'آیا سوال مشترک دارید؟',clientMessageId:key},
        },
      )))
      for(const r of responses)expect(r.status(),await r.text()).toBe(200)
      const bodies=await Promise.all(responses.map(r=>r.json())) as Array<{message:{id:string},conversationId:string}>
      expect(new Set(bodies.map(x=>x.message.id)).size).toBe(1)
      expect(new Set(bodies.map(x=>x.conversationId)).size).toBe(1)
      const messages=await thread(p,bodies[0].conversationId)
      expect(messages.filter(m=>m.senderType==='contact')).toHaveLength(1)
      expect(messages.filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })

  test('same key with conflicting text must return 409 and not create a second AI charge',async({browser})=>{
    const ctx=await browser.newContext()
    try{
      const p=await ctx.newPage(),slug=await signup(p,'conflict')
      await pro(p);await faqToggle(p,true)
      await addFaq(p,'آیا سفارش تلفنی داریم؟','بله')
      const token=await visitor(p,slug)
      const key='q3-conflict-'+Date.now()
      const original=await send(p,slug,token,'آیا سفارش تلفنی داریم؟',key)
      const bad=await p.request.post(BASE+'/api/widget/'+slug+'/messages',{
        headers:{...HEADERS,Authorization:'Bearer '+token},
        data:{text:'یک پیام دیگر',clientMessageId:key},
      })
      expect(bad.status(),await bad.text()).toBe(409)
      expect((await thread(p,original.conversationId)).filter(m=>m.senderType==='contact')).toHaveLength(1)
      expect((await thread(p,original.conversationId)).filter(m=>m.senderType==='ai')).toHaveLength(1)
      expect(await billed(p)).toBe(1)
    }finally{await ctx.close()}
  })
})
