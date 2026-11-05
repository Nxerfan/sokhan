import {test,expect,type Page} from '@playwright/test'
import {globalDb} from '@/lib/db'
import {otpSignupPlaywright} from './helpers/otp-signup'
import {setAccessMode} from './helpers/set-access'

/**
 * Independent reviewer AI-Q4 REAL HTTP + PostgreSQL acceptance.
 * Pinned, reviewer-owned. Never delete, weaken, mock or skip.
 *
 * The widget currently uses db.product.findMany({ take: 500 }) without
 * orderBy. These tests dynamically select a row outside that exact
 * persisted 500-row slice so the bug is not dependent on insertion order.
 * A correct implementation must see all relevant facts without loading
 * an unbounded catalog in memory or silently dropping ambiguity.
 */
const APP='http://127.0.0.1:3000'
const BASE='http://127.0.0.1:81'
const H={'Content-Type':'application/json'}
const uid=()=> 'q4cap-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)
const arabicDigits=(s:string)=>s.replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x06f0))
  .replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x0660)).replace(/[٬،,\s]/g,'')

async function owner(page:Page){
  const marker=uid(),email=marker+'@test.com'
  const created=await otpSignupPlaywright(page.request,APP,email,'Q4 reviewer catalog '+marker)
  expect(created.ok).toBe(true)
  const csrf=await page.request.get(APP+'/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const {csrfToken}=await csrf.json()
  const login=await page.request.post(APP+'/api/auth/callback/credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data:'email='+encodeURIComponent(email)+'&password=password123&csrfToken='+encodeURIComponent(csrfToken)+'&json=true',
  })
  expect(login.status(),await login.text()).toBeLessThan(400)
  await page.goto(BASE)
  const me=await page.request.get(APP+'/api/tenants/me')
  expect(me.status(),await me.text()).toBe(200)
  const identity=await me.json()
  const tenantId=identity.tenant?.id as string
  const slug=identity.tenant?.slug as string
  expect(tenantId).toBeTruthy()
  expect(slug).toBeTruthy()
  const pro=await page.request.post(BASE+'/api/invitations/dev/set-plan',{
    headers:H,data:{plan:'pro'},
  })
  expect(pro.status(),await pro.text()).toBe(200)
  const flags=await page.request.patch(APP+'/api/ai-config',{
    headers:H,data:{faqEnabled:false,productQaEnabled:true},
  })
  expect(flags.status(),await flags.text()).toBe(200)
  await setAccessMode(page,'anonymous')
  const contact=await page.request.post(BASE+'/api/widget/'+slug+'/contact',{
    headers:H,data:{visitorId:uid()},
  })
  expect(contact.status(),await contact.text()).toBe(200)
  const token=(await contact.json()).realtimeToken as string
  expect(token).toBeTruthy()
  return {tenantId,slug,token}
}
async function seed501(tenantId:string,description:string,name:string,price=120000){
  const marker=uid()
  const products=Array.from({length:501},(_,i)=>({
    id:marker+'-'+String(i).padStart(3,'0'),
    tenantId,name,description,price,currency:'IRT',
    availability:'in_stock',metadata:{},
  }))
  const created=await globalDb.product.createMany({data:products})
  expect(created.count).toBe(501)
  const all=await globalDb.product.findMany({where:{tenantId},select:{id:true}})
  expect(all).toHaveLength(501)
  return all.map(x=>x.id)
}
async function findExcluded(tenantId:string,allIds:ReadonlyArray<string>){
  // Reproduce the production query at the reported SHA, without relying
  // on insertion order or specific auto-generated primary keys.
  const first500=await globalDb.product.findMany({
    where:{tenantId},
    select:{id:true,name:true,price:true,availability:true,currency:true},
    take:500,
  })
  expect(first500).toHaveLength(500)
  const seen=new Set(first500.map(x=>x.id))
  const excluded=allIds.filter(id=>!seen.has(id))
  expect(excluded).toHaveLength(1)
  return excluded[0]
}
async function send(page:Page,slug:string,token:string,message:string){
  const res=await page.request.post(BASE+'/api/widget/'+slug+'/messages',{
    headers:{...H,Authorization:'Bearer '+token},
    data:{text:message,clientMessageId:uid()},
  })
  expect(res.status(),await res.text()).toBe(200)
  return res.json() as Promise<{
    aiResponse:{source:string,text:string}|null,conversationId:string,
  }>
}
async function usage(page:Page){
  const res=await page.request.get(APP+'/api/billing/subscription')
  expect(res.status(),await res.text()).toBe(200)
  return (await res.json()).usage.aiActions.current as number
}
async function aiMessages(page:Page,conversationId:string){
  const res=await page.request.get(APP+'/api/conversations/'+conversationId+'/messages')
  expect(res.status(),await res.text()).toBe(200)
  const messages=(await res.json()).messages as Array<{senderType:string}>
  expect(Array.isArray(messages)).toBe(true)
  return messages.filter(m=>m.senderType==='ai')
}

test.describe('Reviewer AI-Q4 — catalog beyond first 500 product records',()=>{
  test('conflicting 501st same-name product MUST block a fabricated single price and charge',async({browser})=>{
    const ctx=await browser.newContext()
    let tenantId:string|undefined
    try{
      const p=await ctx.newPage(),o=await owner(p)
      tenantId=o.tenantId
      const name='قاب گوشی ارغوان'
      const all=await seed501(tenantId,'same canonical identity',name,120000)
      const excluded=await findExcluded(tenantId,all)
      await globalDb.product.update({where:{id:excluded},data:{price:990000}})
      // Confirm the changed row is real and differs from the bounded slice.
      const conflict=await globalDb.product.findUniqueOrThrow({where:{id:excluded}})
      expect(conflict.price).toBe(990000)
      const result=await send(p,o.slug,o.token,'قیمت قاب گوشی ارغوان چقدر است؟')
      expect(result.aiResponse,
        'Never bill or claim one price while another tenant-owned same-name price exists outside the first 500 records').toBeNull()
      expect(await aiMessages(p,result.conversationId)).toHaveLength(0)
      expect(await usage(p)).toBe(0)
    }finally{
      if(tenantId)await globalDb.product.deleteMany({where:{tenantId}})
      await ctx.close()
    }
  })

  test('real matching product outside the arbitrary first 500 MUST be discoverable',async({browser})=>{
    const ctx=await browser.newContext()
    let tenantId:string|undefined
    try{
      const p=await ctx.newPage(),o=await owner(p)
      tenantId=o.tenantId
      const all=await seed501(tenantId,'unrelated catalog items','لوازم آزمایش بی ارتباط',120000)
      const excluded=await findExcluded(tenantId,all)
      await globalDb.product.update({where:{id:excluded},data:{
        name:'پاور بانک شاهین',description:'',price:765432,
      }})
      const product=await globalDb.product.findUniqueOrThrow({where:{id:excluded}})
      expect(product.name).toBe('پاور بانک شاهین')
      const result=await send(p,o.slug,o.token,'قیمت پاور بانک شاهین چقدر است؟')
      expect(result.aiResponse?.source).toBe('product')
      expect(result.aiResponse?.text).toContain('پاور بانک شاهین')
      expect(arabicDigits(result.aiResponse?.text||'')).toContain('765432')
      expect(await aiMessages(p,result.conversationId)).toHaveLength(1)
      expect(await usage(p)).toBe(1)
    }finally{
      if(tenantId)await globalDb.product.deleteMany({where:{tenantId}})
      await ctx.close()
    }
  })
})
