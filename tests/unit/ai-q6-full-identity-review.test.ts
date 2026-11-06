/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q6 — strict raw source identity (not just rendered
 * normalized text). Immutable once pinned.
 *
 * Two distinct raw records for one Message ID must never silently collapse
 * just because sanitization makes their visible text equal. The original
 * source record is the authority for evidence provenance.
 */
import {describe,test,expect} from 'bun:test'
import {summarizeHandoffMessages,type HandoffSourceMessage}
  from '../../src/lib/ai/handoff-summary-policy'

const row=(id:string,senderType:string,content:unknown):HandoffSourceMessage=>({
  id,senderType,contentType:'text',content,createdAt:new Date('2026-11-06T10:00:00.000Z'),
})
describe('Reviewer AI-Q6 — reject conflicting raw content identities',()=>{
  test('same ID and normalized visible text, different raw HTML identity, must fail closed',()=>{
    const visitor=row('visitor','contact',{text:'چراغ رومیزی'})
    const ai=row('one-ai','ai',{text:'موجود است'})
    const rewritten=row('visitor','contact',{text:'<b>چراغ رومیزی</b>'})
    expect(summarizeHandoffMessages([visitor,ai,rewritten])).toBeNull()
  })
  test('same ID and text but conflicting persisted factual content metadata must fail closed',()=>{
    const visitor=row('visitor','contact',{text:'قیمت جدید؟'})
    const ai=row('one-ai','ai',{text:'۱۰۰۰۰۰ تومان',source:'product',verified:true})
    const altered=row('one-ai','ai',{text:'۱۰۰۰۰۰ تومان',source:'faq',verified:false})
    expect(summarizeHandoffMessages([visitor,ai,altered])).toBeNull()
  })
})
