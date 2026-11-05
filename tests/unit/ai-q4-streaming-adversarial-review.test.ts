/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q4 streaming safety acceptance.
 * REVIEWER OWNED: implementation agent must NOT change, weaken, skip, rename,
 * remove or bypass this file, its Git blob pin or CI execution.
 *
 * The stream intentionally keeps only 15 ranking candidates, but an ID
 * previously processed outside that buffer must not lose its identity/facts.
 * Same-ID inconsistent rows must fail closed, not silently keep one copy.
 */
import {describe,test,expect} from 'bun:test'
import {streamProductCandidates,type ProductCandidate,type ProductBatchReader}
  from '../../src/lib/ai/product-policy'

const row=(id:string,name:string,price:number):ProductCandidate=>({
  id,name,description:'',price,availability:'in_stock',currency:'IRT',
})

describe('Reviewer AI-Q4 — streaming boundary correctness',()=>{
  test('an earlier matching ID pruned out of top-15 cannot conceal a conflicting duplicate later',async()=>{
    const first=Array.from({length:200},(_,i)=>
      row('p-'+String(i).padStart(3,'0'),'چراغ منحصربه‌فرد '+i,100),
    )
    const changed={...first[199],price:990000}
    const fetchBatch:ProductBatchReader=async(cursor)=>{
      if(!cursor)return {products:first,hasMore:true,nextCursor:first[199].id}
      return {products:[changed],hasMore:false,nextCursor:changed.id}
    }
    const result=await streamProductCandidates('چراغ',fetchBatch)
    expect(result.ambiguous,'Conflicting duplicate facts cannot be ignored after candidate pruning').toBe(true)
    expect(result.candidates).toEqual([])
  })

  test('same ID with a different name may not reuse a stale selected product identity',async()=>{
    const original=row('stable-id','چراغ مهر',50000)
    const renamed={...original,name:'چراغ آذر'}
    const fetchBatch:ProductBatchReader=async(cursor)=>cursor
      ? {products:[renamed],hasMore:false,nextCursor:renamed.id}
      : {products:[original],hasMore:true,nextCursor:original.id}
    const result=await streamProductCandidates('چراغ',fetchBatch)
    expect(result.ambiguous,'Same ID with different names must not be silently deduplicated').toBe(true)
    expect(result.candidates).toEqual([])
  })
})
