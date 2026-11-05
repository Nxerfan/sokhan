/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q4 real PostgreSQL repeatable-read acceptance.
 * IMMUTABLE. Tests the ACTUAL tenant-scoped transaction client, not merely
 * a global Prisma transaction that cannot prove the production boundary.
 */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {db,globalDb,withTenant} from '../../src/lib/db'

const unique=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)
let tenantA='',tenantB=''
async function makeProduct(tenantId:string,name:string,price:number,description=''){
  return globalDb.product.create({data:{
    tenantId,name,price,description,availability:'in_stock',currency:'IRT',metadata:{},
  }})
}
beforeAll(async()=>{
  tenantA=(await globalDb.tenant.create({data:{
    slug:'q4-snapshot-a-'+unique,name:'Q4 Snapshot A '+unique,plan:'pro',
  },select:{id:true}})).id
  tenantB=(await globalDb.tenant.create({data:{
    slug:'q4-snapshot-b-'+unique,name:'Q4 Snapshot B '+unique,plan:'pro',
  },select:{id:true}})).id
})
afterAll(async()=>{
  for(const id of [tenantB,tenantA]){
    if(id)await globalDb.tenant.delete({where:{id}}).catch(()=>{})
  }
})
describe('Reviewer AI-Q4 — actual tenant-scoped REPEATABLE READ',()=>{
  test('interactive transaction never exposes same-name products in another tenant',async()=>{
    const name='کالای اختصاصی تست اسنپشات'
    const own=await makeProduct(tenantA,name,250000)
    const foreign=await makeProduct(tenantB,name,900000)
    const result=await withTenant(tenantA,()=>db.$transaction(async tx=>{
      const rows=await tx.product.findMany({where:{name},select:{id:true,tenantId:true,price:true}})
      const foreignById=await tx.product.findUnique({where:{id:foreign.id},select:{id:true}})
      return {rows,foreignById}
    },{isolationLevel:'RepeatableRead',timeout:5000}))
    expect(result.rows).toEqual([{id:own.id,tenantId:tenantA,price:250000}])
    expect(result.foreignById).toBeNull()
  })

  test('tenant-scoped transaction keeps price AND matching description stable under concurrent external update',async()=>{
    const row=await makeProduct(tenantA,'هدفون یکتا',345000,'سنسور ویژه')
    const result=await withTenant(tenantA,()=>db.$transaction(async tx=>{
      const before=await tx.product.findUniqueOrThrow({where:{id:row.id}})
      expect(before).toMatchObject({price:345000,description:'سنسور ویژه'})
      // A separate unscoped client updates the committed row after the
      // snapshot has been acquired. This must not affect subsequent tx reads.
      await globalDb.product.update({where:{id:row.id},data:{price:876543,description:'ویژگی جدید'}})
      const after=await tx.product.findUniqueOrThrow({where:{id:row.id}})
      return {before,after}
    },{isolationLevel:'RepeatableRead',timeout:5000}))
    expect(result.after.price).toBe(result.before.price)
    expect(result.after.description).toBe(result.before.description)
    const fresh=await withTenant(tenantA,()=>db.product.findUniqueOrThrow({where:{id:row.id}}))
    expect(fresh).toMatchObject({price:876543,description:'ویژگی جدید'})
  })

  test('tenant-scoped snapshot excludes concurrent inserts and preserves deleted records within the same scan',async()=>{
    const old=await makeProduct(tenantA,'محصول اولیه',111000)
    const result=await withTenant(tenantA,()=>db.$transaction(async tx=>{
      const first=await tx.product.findMany({where:{id:old.id},select:{id:true}})
      expect(first.map(x=>x.id)).toEqual([old.id])
      const added=await makeProduct(tenantA,'محصول هم‌زمان',222000)
      await globalDb.product.delete({where:{id:old.id}})
      const oldInside=await tx.product.findMany({where:{id:old.id},select:{id:true}})
      const addedInside=await tx.product.findMany({where:{id:added.id},select:{id:true}})
      return {oldInside,addedInside,addedId:added.id}
    },{isolationLevel:'RepeatableRead',timeout:5000}))
    expect(result.oldInside.map(x=>x.id)).toEqual([old.id])
    expect(result.addedInside).toEqual([])
    expect(await withTenant(tenantA,()=>db.product.findUnique({where:{id:old.id}}))).toBeNull()
    expect(await withTenant(tenantA,()=>db.product.findUnique({where:{id:result.addedId}}))).not.toBeNull()
  })
})
