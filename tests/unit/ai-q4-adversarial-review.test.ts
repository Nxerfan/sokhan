/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q4 adversarial runtime contract.
 * REVIEWER OWNED: the implementation agent must NEVER edit, delete, skip, or
 * weaken this file, its CI selection, or its pinned Git blob hash.
 *
 * Defects observed at AI-Q4 implementation commit
 * 6308f373ee82852732f4894345daf1b4169f0bb2:
 * 1. Top-10 truncation runs BEFORE conflicting-price ambiguity detection.
 * 2. Arbitrary nonempty currency labels are treated as supported currencies.
 * 3. Identical names + numeric prices in different currencies are not
 *    considered ambiguous despite referring to different monetary amounts.
 * 4. Duplicate candidate IDs can survive the purported unique-ID retrieval.
 */
import {describe,test,expect} from 'bun:test'
import {answerProductQuestion} from '../../src/lib/ai'
import {retrieveProductCandidates,detectAmbiguousCandidates} from '../../src/lib/ai/product-policy'

const negative={answered:false,answer:null,productIds:[]}
const name='قاب گوشی ارغوان'
const sameNameProducts=()=>Array.from({length:11},(_,i)=>({
  id:'id-'+String(i).padStart(2,'0'),name,description:'',
  price:i===10?990000:120000,availability:'in_stock',currency:'IRT',
}))

describe('Reviewer AI-Q4 — no ambiguity hidden by candidate truncation',()=>{
  test('eleventh conflicting same-name price cannot be hidden beyond top-ten selection',async()=>{
    const products=sameNameProducts()
    const query='قیمت قاب گوشی ارغوان'
    // A valid response must not quote one of several indistinguishable prices.
    for(const list of [products,[...products].reverse()]){
      let calls=0
      const provider={complete:async()=>{calls++;return 'sure'}}
      const result=await answerProductQuestion(query,list,provider)
      expect(result,'A single conflicting record outside the top-10 MUST fail closed').toEqual(negative)
      expect(calls,'Do not query a provider on already-ambiguous product data').toBe(0)
    }
  })

  test('ambiguity detection cannot be bypassed when same-name prices differ only outside the cap',()=>{
    const products=sameNameProducts()
    const selected=retrieveProductCandidates('قیمت قاب گوشی ارغوان',products)
    expect(selected).toHaveLength(10)
    // A policy that truncates first then sees only equal-price records is unsafe.
    // The full retrieval/answer pipeline MUST still reject the overall ambiguity.
    const leaked=detectAmbiguousCandidates(selected)
    expect(leaked.size,'Selection must carry ambiguous information into the gate').toBeGreaterThan(0)
  })

  test('same name, same numeric price, different CURRENCIES is a real ambiguity',async()=>{
    const rows=[
      {id:'irt',name:'ساعت سپیدار',description:'',price:1000,availability:'in_stock',currency:'IRT'},
      {id:'usd',name:'ساعت سپیدار',description:'',price:1000,availability:'in_stock',currency:'USD'},
    ]
    let calls=0
    const result=await answerProductQuestion('قیمت ساعت سپیدار',rows,{complete:async()=>{calls++;return 'yes'}})
    expect(result,'Different monetary units MUST NOT be conflated').toEqual(negative)
    expect(calls).toBe(0)
  })
})

describe('Reviewer AI-Q4 — unsupported and malicious currency values fail closed',()=>{
  test('an unsupported currency code must not be rendered as a legitimate price unit',async()=>{
    for(const currency of ['ZZZ','FAKE','UNVERIFIED']){
      const products=[{id:'x',name:'چراغ نسترن',description:'',price:1000,availability:'in_stock',currency}]
      const result=await answerProductQuestion('قیمت چراغ نسترن',products)
      expect(result,'currency='+currency).toEqual(negative)
    }
  })

  test('merchant-controlled currency cannot inject arbitrary shipping promise into answer',async()=>{
    const bad='USD FREE SHIPPING'
    const products=[{id:'x',name:'چراغ نسترن',description:'',price:1000,availability:'in_stock',currency:bad}]
    const result=await answerProductQuestion('قیمت چراغ نسترن',products)
    expect(result).toEqual(negative)
    expect(result.answer||'').not.toContain('FREE SHIPPING')
  })

  test('the real supported currency USD remains eligible and correctly labeled',async()=>{
    const products=[{id:'usd',name:'چراغ نسترن',description:'',price:1000,availability:'in_stock',currency:'USD'}]
    const result=await answerProductQuestion('قیمت چراغ نسترن',products)
    expect(result).toMatchObject({answered:true,productIds:['usd']})
    expect(result.answer||'').toContain('1000 USD')
    expect(result.answer||'').not.toMatch(/تومان|Toman/i)
  })

  test('the real supported currency IRT remains eligible and correctly labeled',async()=>{
    const products=[{id:'irt',name:'چراغ نسترن',description:'',price:1000,availability:'in_stock',currency:'IRT'}]
    const result=await answerProductQuestion('قیمت چراغ نسترن',products)
    expect(result).toMatchObject({answered:true,productIds:['irt']})
    expect(result.answer||'').toContain('تومان')
    expect(result.answer||'').not.toContain('USD')
  })

  test('duplicated input rows must never produce duplicate product IDs',()=>{
    const item={id:'same-id',name:'لامپ خورشید',description:'',price:70000,availability:'in_stock'}
    const rows=retrieveProductCandidates('قیمت لامپ خورشید',[item,{...item}])
    expect(rows.map(p=>p.id)).toEqual(['same-id'])
  })
})
