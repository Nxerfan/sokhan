/// <reference types="bun-types" />
/**
 * Independent reviewer-owned AI-Q3 FAQ acceptance contract.
 * DO NOT edit/skip/weaken from the implementation agent.
 * All semantic tests use a server-only injected provider, never a public fake-LLM endpoint.
 * Every positive response must contain the actual owner-authored FAQ answer.
 */
import { describe, test, expect } from 'bun:test'
import { matchFaq } from '../../src/lib/ai'
import { FAQ_CONFIDENCE_THRESHOLD, normalizeFaqQuestion, resolveExactFaq } from '../../src/lib/ai/faq-policy'

const faqs = Object.freeze([
  Object.freeze({ id: 'a-1', question: 'آیا ارسال رایگان دارید؟', answer: 'فقط سفارش‌های بالای ۵۰۰ هزار تومان.' }),
  Object.freeze({ id: 'a-2', question: 'What is your refund policy?', answer: 'Refunds within 7 days.' }),
])
const noAnswer = { matched: false, faqPairId: null, answer: null }

function providerOutput(payload: unknown) {
  let calls = 0
  return { provider: { complete: async (_prompt: string) => { calls++; return JSON.stringify(payload) } }, calls: () => calls }
}

describe('Reviewer AI-Q3 — exact FAQ normalization safety', () => {
  test('the canonical threshold is EXACTLY 0.70', () => {
    expect(FAQ_CONFIDENCE_THRESHOLD).toBe(0.7)
  })

  const equivalent: Array<[string,string]> = [
    ['  آیا   ارسال   رایگان دارید؟ ', 'آیا ارسال رایگان دارید؟'],
    ['آيا ارسال رايگان داريد؟', 'آیا ارسال رایگان دارید؟'],
    ['آيا ارسال با كد تخفيف داريد؟', 'آیا ارسال با کد تخفیف دارید؟'],
    ['ارسال می‌شود؟', 'ارسال می شود؟'],
    ['ارسال می\u00a0شود؟', 'ارسال می شود؟'],
    ['ارسال می\tشود؟', 'ارسال می شود؟'],
    ['What IS Your REFUND Policy?', 'what is your refund policy?'],
    ['آیا فروش حضوری دارید?', 'آیا فروش حضوری دارید؟'],
    ['کِتاب', 'کِتاب'],
  ]
  for (const [a,b] of equivalent) {
    test('equivalent FAQ orthography: ' + JSON.stringify(a), () => {
      expect(normalizeFaqQuestion(a)).toBe(normalizeFaqQuestion(b))
    })
  }

  const distinct: Array<[string,string]> = [
    ['ارسال رایگان داریم', 'ارسال رایگان نداریم'],
    ['قیمت ۱۲.۵ تومان', 'قیمت ۱۲۵ تومان'],
    ['ارسال 100 روزه', 'ارسال 200 روزه'],
    ['۱۰٪ تخفیف', '۱۰ تخفیف'],
    ['قبل از خرید', 'بعد از خرید'],
    ['پرداخت حضوری', 'پرداخت آنلاین'],
    ['آیا کالا موجود است؟', 'آیا کالا موجود نیست؟'],
  ]
  for (const [a,b] of distinct) {
    test('NEVER normalize away meaning: ' + JSON.stringify(a), () => {
      expect(normalizeFaqQuestion(a)).not.toBe(normalizeFaqQuestion(b))
    })
  }

  test('normalization is deterministic and idempotent', () => {
    for (const q of [...equivalent.flat(),...distinct.flat()]) {
      const once=normalizeFaqQuestion(q)
      expect(normalizeFaqQuestion(once)).toBe(once)
    }
    expect(normalizeFaqQuestion('   ')).toBe('')
  })

  test('one normalized match returns exactly the stored answer and ID', () => {
    expect(resolveExactFaq(' آيا   ارسال رايگان داريد؟ ', faqs)).toEqual({
      status: 'matched', faqPairId: 'a-1', answer: faqs[0].answer,
    })
  })

  test('non-equivalent questions do NOT become exact matches', () => {
    expect(resolveExactFaq('آیا ارسال رایگان ندارید؟', faqs)).toEqual({
      status: 'none', faqPairId: null, answer: null,
    })
  })

  test('blank visitor text and empty candidates never match', () => {
    expect(resolveExactFaq('   ', faqs)).toMatchObject({ status: 'none', faqPairId: null, answer: null })
    expect(resolveExactFaq('آیا ارسال رایگان دارید؟', [])).toMatchObject({ status: 'none', faqPairId: null, answer: null })
  })

  test('two canonical duplicates with conflicting answers are AMBIGUOUS, never first-row-wins', () => {
    const dup = [
      { id:'1', question:'آیا ارسال داریم؟', answer:'بله' },
      { id:'2', question:'آيا   ارسال داريم?', answer:'خیر' },
    ]
    for (const pairs of [dup,[...dup].reverse()]) {
      expect(resolveExactFaq('آیا ارسال داریم؟',pairs)).toEqual({
        status:'ambiguous', faqPairId:null, answer:null,
      })
    }
  })

  test('even identical-answer canonical duplicates must not select an arbitrary FAQ ID', () => {
    const dup = [
      { id:'1',question:'When are you open?',answer:'Nine to five.' },
      { id:'2',question:'WHEN ARE YOU OPEN؟',answer:'Nine to five.' },
    ]
    expect(resolveExactFaq('when are you open?',dup)).toMatchObject({
      status:'ambiguous',faqPairId:null,answer:null,
    })
  })

  test('an empty/blank stored answer is never deliverable', () => {
    expect(resolveExactFaq('Question?',[{id:'1',question:'Question?',answer:' \t '}]))
      .toMatchObject({status:'none',faqPairId:null,answer:null})
  })

  test('frozen input objects and pair order are never mutated', () => {
    const original=JSON.stringify(faqs)
    resolveExactFaq('آيا ارسال رایگان دارید؟',faqs)
    expect(JSON.stringify(faqs)).toBe(original)
  })
})

describe('Reviewer AI-Q3 — strict semantic confidence gate and source integrity', () => {
  test('boundary 0.700000 qualifies; 0.699999 does NOT', async () => {
    for (const [confidence,expected] of [[0.7,true],[0.699999,false],[0.99,true],[1,true],[0,false]] as const) {
      const {provider,calls}=providerOutput({matched:true,id:'a-1',confidence})
      const r=await matchFaq('می توانم بدون هزینه سفارش بدهم؟',[...faqs],provider)
      expect(r.matched,'confidence='+confidence).toBe(expected)
      expect(r.faqPairId).toBe(expected?'a-1':null)
      expect(r.answer).toBe(expected?faqs[0].answer:null)
      expect(calls()).toBe(1)
    }
  })

  test('NEVER default missing/null/invalid model confidence to 0.7', async () => {
    const bad:unknown[]=[undefined,null,'0.99','0.7',true,false,{},[], -0.1,1.01,999,-999]
    for (const confidence of bad) {
      const {provider}=providerOutput({matched:true,id:'a-1',confidence})
      const r=await matchFaq('قصد خرید دارم',[...faqs],provider)
      expect(r,'confidence='+String(confidence)).toMatchObject(noAnswer)
    }
    const omitted=providerOutput({matched:true,id:'a-1'})
    expect(await matchFaq('قصد خرید دارم',[...faqs],omitted.provider)).toMatchObject(noAnswer)
  })

  test('model matched field must be boolean true, never truthy coercion', async () => {
    for (const value of ['true','false',1,0,[],{},null,undefined]) {
      const {provider}=providerOutput({matched:value,id:'a-1',confidence:0.99})
      expect(await matchFaq('سوال',[...faqs],provider)).toMatchObject(noAnswer)
    }
  })

  test('model ID must be an EXACT member string, not invented/array/object/numeric', async () => {
    for (const id of ['ghost','A-1',' a-1 ','',{},[],1,null,undefined]) {
      const {provider}=providerOutput({matched:true,id,confidence:0.99})
      expect(await matchFaq('سوال',[...faqs],provider)).toMatchObject(noAnswer)
    }
  })

  test('negative intent cannot be overridden by valid ID and high confidence', async () => {
    const {provider}=providerOutput({matched:false,id:'a-1',confidence:1})
    expect(await matchFaq('سوال',[...faqs],provider)).toMatchObject(noAnswer)
  })

  test('provider-generated answer is NEVER trusted over the saved tenant answer', async () => {
    const {provider}=providerOutput({matched:true,id:'a-2',confidence:0.91,answer:'FORGED PRICE'})
    expect(await matchFaq('Can I get a refund?',[...faqs],provider)).toEqual({
      matched:true,faqPairId:'a-2',answer:'Refunds within 7 days.',confidence:0.91,
    })
  })

  test('JSON literals, arrays, malformed text and fenced junk safely reject', async () => {
    for (const result of ['null','true','false','42','[]','{}','"hello"','malformed','{"matched":true,']) {
      const provider={complete:async()=>result}
      expect(await matchFaq('سوال',[...faqs],provider)).toMatchObject(noAnswer)
    }
  })

  test('a genuine fenced JSON response may qualify when schema and threshold are valid', async () => {
    const provider={complete:async()=> '~~~invalid~~~'}
    expect(await matchFaq('سوال',[...faqs],provider)).toMatchObject(noAnswer)
    const valid={complete:async()=> '```json\n{"matched":true,"id":"a-1","confidence":0.7}\n```'}
    expect(await matchFaq('سوال',[...faqs],valid)).toMatchObject({
      matched:true,faqPairId:'a-1',answer:faqs[0].answer,
    })
  })

  test('provider exceptions and malformed provider return values fail closed without throw', async () => {
    const broken={complete:async()=>{throw Error('Network down')}}
    const malformed={complete:async()=>null as unknown as string}
    expect(await matchFaq('سوال',[...faqs],broken)).toMatchObject(noAnswer)
    expect(await matchFaq('سوال',[...faqs],malformed)).toMatchObject(noAnswer)
  })

  test('zero eligible candidates means zero external/model calls', async () => {
    let calls=0
    const provider={complete:async()=>{calls++;return '{}'}}
    expect(await matchFaq('سوال',[],provider)).toEqual({
      matched:false,faqPairId:null,answer:null,confidence:0,
    })
    expect(calls).toBe(0)
  })

  test('source-owned FAQ data cannot be mutated by semantic matching', async () => {
    const original=JSON.stringify(faqs)
    const provider={complete:async()=>JSON.stringify({matched:true,id:'a-1',confidence:0.8})}
    await matchFaq('سوال',[...faqs],provider)
    expect(JSON.stringify(faqs)).toBe(original)
  })

  test('blank stored answers never become a billable semantic match', async () => {
    const provider={complete:async()=>JSON.stringify({matched:true,id:'blank',confidence:1})}
    expect(await matchFaq('سوال',[{id:'blank',question:'سوال',answer:'   '}],provider))
      .toMatchObject(noAnswer)
  })
})
