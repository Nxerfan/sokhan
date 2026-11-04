/// <reference types="bun-types" />
/**
 * Reviewer-owned AI-Q3 integration tests against REAL PostgreSQL in Full AND Lite.
 * No SQLite, no mocked Prisma, no source-only assertions, no public fake LLM.
 * This suite deliberately reads/writes real tenant-owned FAQ rows.
 */
import { beforeAll, afterAll, describe, test, expect } from 'bun:test'
import { globalDb, db, withTenant } from '@/lib/db'
import { resolveExactFaq } from '@/lib/ai/faq-policy'

const stamp=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)
const tenants:string[]=[]
let serial=0
async function makeTenant() {
  const n=++serial
  const t=await globalDb.tenant.create({
    data:{name:'AI-Q3 reviewer '+stamp+' '+n,slug:'aiq3-review-'+stamp+'-'+n,plan:'pro'},
    select:{id:true},
  })
  tenants.push(t.id)
  return t.id
}
async function addFaq(tenantId:string,question:string,answer:string,enabled=true) {
  return globalDb.faqPair.create({data:{tenantId,question,answer,enabled}})
}
async function eligible(tenantId:string) {
  return withTenant(tenantId,()=>db.faqPair.findMany({
    where:{enabled:true},select:{id:true,question:true,answer:true},orderBy:{createdAt:'asc'},
  }))
}
beforeAll(async()=>{})
afterAll(async()=>{
  for(const id of tenants.reverse()) await globalDb.tenant.delete({where:{id}}).catch(()=>{})
})

describe('Reviewer AI-Q3 — real PostgreSQL FAQ tenant boundary',()=>{
  test('two tenants with the same question MUST return ONLY their OWN answer',async()=>{
    const a=await makeTenant(),b=await makeTenant()
    const q='آیا ارسال با کد تخفیف امکان دارد؟'
    const rowA=await addFaq(a,q,'پاسخ فقط مستأجر A')
    const rowB=await addFaq(b,q,'پاسخ فقط مستأجر B')
    const resultA=resolveExactFaq(q,await eligible(a))
    const resultB=resolveExactFaq(q,await eligible(b))
    expect(resultA).toEqual({status:'matched',faqPairId:rowA.id,answer:'پاسخ فقط مستأجر A'})
    expect(resultB).toEqual({status:'matched',faqPairId:rowB.id,answer:'پاسخ فقط مستأجر B'})
    expect(resultA.answer).not.toBe(resultB.answer)
  })

  test('a disabled FAQ must not enter the eligible candidate set',async()=>{
    const a=await makeTenant()
    const q='ساعت کاری پشتیبانی؟'
    await addFaq(a,q,'پاسخ غیرفعال',false)
    expect(resolveExactFaq(q,await eligible(a))).toMatchObject({
      status:'none',faqPairId:null,answer:null,
    })
    const active=await addFaq(a,q,'پاسخ فعال',true)
    expect(resolveExactFaq(q,await eligible(a))).toEqual({
      status:'matched',faqPairId:active.id,answer:'پاسخ فعال',
    })
  })

  test('canonical duplicates with contradictory answers fail closed independent of DB order',async()=>{
    const a=await makeTenant()
    const q='آیا خدمات حضوری دارید؟'
    await addFaq(a,q,'بله')
    await addFaq(a,'آيا  خدمات   حضوري داريد?', 'خیر')
    const rows=await eligible(a)
    expect(rows).toHaveLength(2)
    for(const list of [rows,[...rows].reverse()]) {
      expect(resolveExactFaq(q,list)).toEqual({
        status:'ambiguous',faqPairId:null,answer:null,
      })
    }
  })

  test('disabling one of two canonical duplicates restores a unique answer',async()=>{
    const a=await makeTenant()
    const q='How does delivery work?'
    const first=await addFaq(a,q,'First')
    const second=await addFaq(a,'HOW DOES DELIVERY WORK؟','Second')
    expect(resolveExactFaq(q,await eligible(a)).status).toBe('ambiguous')
    await withTenant(a,()=>db.faqPair.updateMany({
      where:{id:first.id},data:{enabled:false},
    }))
    expect(resolveExactFaq(q,await eligible(a))).toEqual({
      status:'matched',faqPairId:second.id,answer:'Second',
    })
  })

  test('foreign ID read/update/delete is blocked by fail-closed tenant proxy',async()=>{
    const a=await makeTenant(),b=await makeTenant()
    const foreign=await addFaq(b,'Private customer FAQ','PRIVATE ANSWER')
    const attempt=await withTenant(a,async()=>{
      const read=await db.faqPair.findUnique({where:{id:foreign.id}})
      const update=await db.faqPair.updateMany({where:{id:foreign.id},data:{answer:'tampered'}})
      const deletion=await db.faqPair.deleteMany({where:{id:foreign.id}})
      return {read,update,deletion}
    })
    expect(attempt.read).toBeNull()
    expect(attempt.update.count).toBe(0)
    expect(attempt.deletion.count).toBe(0)
    expect(await globalDb.faqPair.findUnique({where:{id:foreign.id}})).toMatchObject({
      tenantId:b,answer:'PRIVATE ANSWER',
    })
  })

  test('parallel tenant-context execution never mixes FAQ IDs or answers',async()=>{
    const a=await makeTenant(),b=await makeTenant()
    const q='آیا تضمین کیفیت دارید؟'
    const one=await addFaq(a,q,'Tenant A only')
    const two=await addFaq(b,q,'Tenant B only')
    const runs=await Promise.all(Array.from({length:16},async(_,index)=>{
      const t=index%2===0?a:b
      return withTenant(t,async()=>{
        const rows=await db.faqPair.findMany({where:{enabled:true},select:{id:true,question:true,answer:true}})
        return resolveExactFaq(q,rows)
      })
    }))
    for(let i=0;i<runs.length;i++){
      expect(runs[i]).toEqual({
        status:'matched',
        faqPairId:i%2===0?one.id:two.id,
        answer:i%2===0?'Tenant A only':'Tenant B only',
      })
    }
  })

  test('a changed FAQ answer is served from CURRENT persisted state, not stale copy',async()=>{
    const a=await makeTenant()
    const row=await addFaq(a,'سیاست بازگشت چیست؟','پاسخ قدیمی')
    expect(resolveExactFaq(row.question,await eligible(a)).answer).toBe('پاسخ قدیمی')
    await withTenant(a,()=>db.faqPair.updateMany({where:{id:row.id},data:{answer:'پاسخ جدید'}}))
    expect(resolveExactFaq(row.question,await eligible(a))).toEqual({
      status:'matched',faqPairId:row.id,answer:'پاسخ جدید',
    })
  })

  test('removed FAQs are not returned by subsequent tenant scoped reads',async()=>{
    const a=await makeTenant()
    const row=await addFaq(a,'Legacy FAQ question?','No longer valid')
    expect(resolveExactFaq(row.question,await eligible(a)).status).toBe('matched')
    await withTenant(a,()=>db.faqPair.deleteMany({where:{id:row.id}}))
    expect(resolveExactFaq(row.question,await eligible(a))).toMatchObject({
      status:'none',faqPairId:null,answer:null,
    })
  })
})
