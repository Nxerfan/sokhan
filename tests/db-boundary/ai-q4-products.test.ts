/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q4 REAL PostgreSQL boundary contract.
 * No SQLite, mocked Prisma, unscoped product reads in application code,
 * source-only tests, sleeps or live LLM. Run complete suite in Full & Lite.
 */
import {describe,test,expect,afterAll} from 'bun:test'
import {globalDb,db,withTenant} from '@/lib/db'
import {retrieveProductCandidates} from '@/lib/ai/product-policy'
import {answerProductQuestion} from '@/lib/ai'

const stamp=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
const tenants:string[]=[]
let serial=0
async function newTenant(){
  const n=++serial
  const x=await globalDb.tenant.create({data:{
    slug:'aiq4-review-'+stamp+'-'+n,name:'AI Q4 Reviewer '+stamp+' '+n,plan:'pro',
  },select:{id:true}})
  tenants.push(x.id)
  return x.id
}
async function add(tenantId:string,name:string,price:number,availability='in_stock',description=''){
  return globalDb.product.create({data:{
    tenantId,name,description,price,availability,metadata:{},
  }})
}
async function eligible(tid:string){
  return withTenant(tid,()=>db.product.findMany({
    select:{id:true,name:true,description:true,price:true,availability:true},
  }))
}
const ids=(rows:ReadonlyArray<{id:string}>)=>rows.map(x=>x.id)
afterAll(async()=>{
  for(const id of tenants.reverse())await globalDb.tenant.delete({where:{id}}).catch(()=>{})
})

describe('Reviewer AI-Q4 — real DB tenant and freshness acceptance',()=>{
  test('identically named products in two tenants have distinct prices, no cross-tenant retrieval',async()=>{
    const a=await newTenant(),b=await newTenant()
    const itemA=await add(a,'چراغ مطالعه سفیر',150000,'in_stock')
    const itemB=await add(b,'چراغ مطالعه سفیر',950000,'out_of_stock')
    const aRows=await eligible(a),bRows=await eligible(b)
    expect(ids(retrieveProductCandidates('قیمت چراغ مطالعه سفیر',aRows))).toEqual([itemA.id])
    expect(ids(retrieveProductCandidates('قیمت چراغ مطالعه سفیر',bRows))).toEqual([itemB.id])
    expect(aRows.every(p=>p.id!==itemB.id)).toBe(true)
    expect(bRows.every(p=>p.id!==itemA.id)).toBe(true)
    const provider={complete:async()=> 'The price is 1 Toman and free shipping'}
    const res=await answerProductQuestion('قیمت چراغ مطالعه سفیر',aRows,provider)
    expect(res.productIds).toEqual([itemA.id])
    expect(res.answer).not.toContain('950000')
    expect(res.answer).not.toContain('free shipping')
    expect(res.answer).not.toContain('1 Toman')
  })

  test('tenant proxy rejects foreign product read, edit, and deletion',async()=>{
    const a=await newTenant(),b=await newTenant()
    const foreign=await add(b,'کوله پشتی اختصاصی',550000)
    const result=await withTenant(a,async()=>{
      const read=await db.product.findUnique({where:{id:foreign.id}})
      const update=await db.product.updateMany({where:{id:foreign.id},data:{price:1}})
      const remove=await db.product.deleteMany({where:{id:foreign.id}})
      return {read,update,remove}
    })
    expect(result.read).toBeNull()
    expect(result.update.count).toBe(0)
    expect(result.remove.count).toBe(0)
    const now=await globalDb.product.findUnique({where:{id:foreign.id}})
    expect(now).toMatchObject({tenantId:b,price:550000})
  })

  test('no tenant context for db.product fails closed',async()=>{
    expect(()=>db.product.findMany({where:{}})).toThrow()
  })

  test('parallel independent withTenant contexts never mix product IDs',async()=>{
    const a=await newTenant(),b=await newTenant()
    const one=await add(a,'اسپیکر آوا',123456)
    const two=await add(b,'اسپیکر آوا',999999)
    const result=await Promise.all(Array.from({length:20},(_,i)=>{
      const tid=i%2===0?a:b
      return withTenant(tid,async()=>ids(retrieveProductCandidates('اسپیکر آوا',await db.product.findMany({
        select:{id:true,name:true,description:true,price:true,availability:true},
      }))))
    }))
    for(let i=0;i<result.length;i++)expect(result[i]).toEqual([i%2===0?one.id:two.id])
  })

  test('updated price is immediately reflected in a freshly built product answer',async()=>{
    const a=await newTenant()
    const p=await add(a,'کیف دستی البرز',123456)
    const provider={complete:async()=> 'Any nonblank response'}
    const first=await answerProductQuestion('قیمت کیف دستی البرز',await eligible(a),provider)
    expect(first.productIds).toEqual([p.id])
    expect(first.answer).toContain('123456')
    await withTenant(a,()=>db.product.updateMany({where:{id:p.id},data:{price:654321}}))
    const second=await answerProductQuestion('قیمت کیف دستی البرز',await eligible(a),provider)
    expect(second.productIds).toEqual([p.id])
    expect(second.answer).toContain('654321')
    expect(second.answer).not.toContain('123456')
  })

  test('updated stock state is never cached or made up',async()=>{
    const a=await newTenant()
    const p=await add(a,'باتری همراه آرکا',250000,'in_stock')
    const provider={complete:async()=> 'always in stock'}
    await withTenant(a,()=>db.product.updateMany({where:{id:p.id},data:{availability:'out_of_stock'}}))
    const r=await answerProductQuestion('موجودی باتری همراه آرکا',await eligible(a),provider)
    expect(r.productIds).toEqual([p.id])
    expect(r.answer).not.toContain('always in stock')
    expect(r.answer).toMatch(/ناموجود|اتمام|out.of.stock|موجود نیست/i)
  })

  test('deleted product is not selected and must not generate answer or charge',async()=>{
    const a=await newTenant()
    const p=await add(a,'کابل یگانه',30000)
    await withTenant(a,()=>db.product.deleteMany({where:{id:p.id}}))
    let calls=0
    const provider={complete:async()=>{calls++;return 'hallucinated'}}
    expect(await answerProductQuestion('قیمت کابل یگانه',await eligible(a),provider))
      .toEqual({answered:false,answer:null,productIds:[]})
    expect(calls).toBe(0)
  })

  test('same-name products remain separately attributable; never invent a single arbitrary ID',async()=>{
    const a=await newTenant()
    const first=await add(a,'قاب گوشی باران',100000,'in_stock')
    const second=await add(a,'قاب گوشی باران',200000,'limited')
    const candidates=retrieveProductCandidates('قیمت قاب گوشی باران',await eligible(a))
    expect(new Set(ids(candidates))).toEqual(new Set([first.id,second.id]))
    expect(candidates).toHaveLength(2)
  })

  test('stock and pricing from another tenant cannot contaminate a local answer',async()=>{
    const a=await newTenant(),b=await newTenant()
    const p1=await add(a,'دستگاه قهوه نورد',300000,'limited')
    const p2=await add(b,'دستگاه قهوه نورد',900000,'in_stock')
    const provider={complete:async()=> 'Only 900000 Toman. In stock.'}
    const result=await answerProductQuestion('قیمت دستگاه قهوه نورد',await eligible(a),provider)
    expect(result.productIds).toEqual([p1.id])
    expect(result.productIds).not.toContain(p2.id)
    expect(result.answer).not.toContain('900000')
    expect(result.answer).not.toContain('In stock.')
    expect(result.answer).toMatch(/محدود|limited/i)
  })
})
