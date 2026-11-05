/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q3 adversarial regression.
 * REVIEWER-OWNED. Implementation agent MUST NOT edit/skip/relax this file.
 * Tests are intended to fail on SHA 83b38b32c4df9009f1b7e7de89bd72b80ec72ef6.
 * Zero network calls; semantic provider is injected in-process.
 */
import { describe, test, expect } from 'bun:test'
import { matchFaq } from '../../src/lib/ai'
import { normalizeFaqQuestion, resolveExactFaq } from '../../src/lib/ai/faq-policy'

const negative = {matched:false,faqPairId:null,answer:null}

describe('Reviewer AI-Q3 — adversarial duplicate FAQ integrity',()=>{
  test('a canonical duplicate with a BLANK answer still makes the exact question ambiguous',()=>{
    const pairs=[
      {id:'blank',question:'آیا ارسال رایگان دارید؟',answer:'   '},
      {id:'valid',question:'آيا ارسال رايگان داريد?',answer:'بله، داریم'},
    ]
    for (const order of [pairs,[...pairs].reverse()]){
      expect(resolveExactFaq('آیا ارسال رایگان دارید؟',order)).toEqual({
        status:'ambiguous',faqPairId:null,answer:null,
      })
    }
  })

  test('paraphrased semantic question MUST NOT choose between conflicting canonical duplicates',async()=>{
    const pairs=[
      {id:'yes',question:'آیا ارسال رایگان دارید؟',answer:'بله'},
      {id:'no',question:'آيا ارسال رايگان داريد?',answer:'خیر'},
    ]
    for(const selected of ['yes','no']){
      let called=0
      const provider={complete:async()=>{called++;return JSON.stringify({
        matched:true,id:selected,confidence:0.99,
      })}}
      const result=await matchFaq('برای ارسال هزینه پرداخت می‌کنم؟',pairs,provider)
      expect(result,'Model confidence cannot override contradictory canonical duplicates').toMatchObject(negative)
      expect(called,'Do not invoke provider when all FAQ candidates are contradictory duplicates').toBe(0)
    }
  })

  test('even identical-answer canonical duplicates never permit an arbitrary semantic FAQ ID',async()=>{
    const pairs=[
      {id:'a',question:'When are you open?',answer:'Nine to five'},
      {id:'b',question:'WHEN ARE YOU OPEN؟',answer:'Nine to five'},
    ]
    let called=0
    const provider={complete:async()=>{called++;return JSON.stringify({
      matched:true,id:'a',confidence:1,
    })}}
    expect(await matchFaq('What time does the shop open?',pairs,provider)).toMatchObject(negative)
    expect(called).toBe(0)
  })

  test('a unique unrelated FAQ remains eligible when a different canonical duplicate group is ambiguous',async()=>{
    const pairs=[
      {id:'dup-a',question:'Returns?',answer:'Seven days'},
      {id:'dup-b',question:'RETURNS؟',answer:'Thirty days'},
      {id:'unique',question:'Shipping ETA?',answer:'Two days'},
    ]
    let calls=0
    const provider={complete:async()=>{calls++;return JSON.stringify({
      matched:true,id:'unique',confidence:0.8,
    })}}
    expect(await matchFaq('How soon will the package arrive?',pairs,provider)).toEqual({
      matched:true,faqPairId:'unique',answer:'Two days',confidence:0.8,
    })
    expect(calls).toBe(1)
  })
})

describe('Reviewer AI-Q3 — Unicode and invalid persisted identifiers',()=>{
  test('Unicode NFC composed/decomposed Arabic ALEF MADDA represents the SAME question',()=>{
    const composed='آیا ارسال امروز است؟'
    const decomposed='ا\u0653یا ارسال امروز است؟'
    expect(composed).not.toBe(decomposed)
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'))
    expect(normalizeFaqQuestion(composed)).toBe(normalizeFaqQuestion(decomposed))
    expect(resolveExactFaq(decomposed,[{id:'one',question:composed,answer:'بله'}]))
      .toEqual({status:'matched',faqPairId:'one',answer:'بله'})
  })

  test('normalization remains idempotent and does not strip meaningful DIACRITICS',()=>{
    const a=normalizeFaqQuestion('كِتاب؟')
    const b=normalizeFaqQuestion('کتاب؟')
    expect(a).not.toBe(b)
    expect(normalizeFaqQuestion(a)).toBe(a)
    expect(normalizeFaqQuestion(b)).toBe(b)
  })

  test('an empty ID must never become a deliverable exact FAQ source',()=>{
    expect(resolveExactFaq('Question?',[
      {id:'',question:'Question?',answer:'Some answer'},
    ])).toMatchObject({status:'none',faqPairId:null,answer:null})
  })
})
