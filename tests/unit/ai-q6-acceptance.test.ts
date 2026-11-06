/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q6 — immutable deterministic human-handoff contract.
 * This is a contract, not implementation. Never modify, disable or weaken.
 * There is NO LLM and NO billable AI reply in Q6.
 *
 * Proposed implementation path:
 * src/lib/ai/handoff-summary-policy.ts
 */
import {describe,test,expect} from 'bun:test'
import {
  handoffSummaryEligible,
  summarizeHandoffMessages,
  type HandoffSourceMessage,
} from '../../src/lib/ai/handoff-summary-policy'

const msg=(id:string,senderType:string,text:string,date='2026-11-06T09:00:00Z'):HandoffSourceMessage=>({
  id,senderType,contentType:'text',content:{text},createdAt:new Date(date),
})
const visitor=msg('visitor-1','contact','موجودی چراغ رومیزی؟','2026-11-06T09:00:00Z')
const ai=msg('ai-1','ai','چراغ رومیزی ۱۵۰۰۰۰ تومان موجود است','2026-11-06T09:00:01Z')

describe('Reviewer AI-Q6 — deterministic, non-billable, sourced handoff policy',()=>{
  test('eligible paid plans are pro, max and self-hosted; free/unknown fail closed',()=>{
    for(const plan of ['pro','max','self-hosted'])expect(handoffSummaryEligible(plan,true,1)).toBe(true)
    for(const plan of ['free','unknown','constructor','__proto__','', 'PRO'])
      expect(handoffSummaryEligible(plan,true,1)).toBe(false)
  })
  test('no takeover or zero AI answers never creates a handoff summary',()=>{
    expect(handoffSummaryEligible('pro',false,1)).toBe(false)
    expect(handoffSummaryEligible('pro',true,0)).toBe(false)
    expect(handoffSummaryEligible('max',true,-1)).toBe(false)
    expect(handoffSummaryEligible('max',true,NaN)).toBe(false)
    expect(handoffSummaryEligible('max',true,Infinity)).toBe(false)
  })
  test('all material facts are verbatim-grounded and have source message IDs',()=>{
    const result=summarizeHandoffMessages([visitor,ai])
    expect(result).not.toBeNull()
    expect(result!.version).toBe(1)
    expect(result!.text).toContain('موجودی چراغ رومیزی؟')
    expect(result!.text).toContain('۱۵۰۰۰۰')
    expect(result!.text).toContain('چراغ رومیزی')
    expect(result!.sourceMessageIds).toEqual(['visitor-1','ai-1'])
    expect(result!.aiMessageCount).toBe(1)
    expect(result!.text).not.toContain('۹۹۹۰۰۰')
  })
  test('symmetric deterministic result: input order cannot change source chronology',()=>{
    const a=summarizeHandoffMessages([visitor,ai])
    const b=summarizeHandoffMessages([ai,visitor])
    expect(b).toEqual(a)
    expect(a!.text.indexOf('موجودی چراغ')).toBeLessThan(a!.text.indexOf('۱۵۰۰۰۰'))
  })
  test('equal-timestamp order is stable by message ID',()=>{
    const x=msg('a','contact','سوال یک'),y=msg('b','ai','پاسخ یک')
    expect(summarizeHandoffMessages([x,y])).toEqual(summarizeHandoffMessages([y,x]))
  })
  test('never includes agent or system messages in source material',()=>{
    const result=summarizeHandoffMessages([
      visitor,ai,msg('human-1','agent','HUMAN_PRIVATE_SHOULD_NOT_APPEAR'),
      msg('system-1','system','SYSTEM_SECRET_SHOULD_NOT_APPEAR'),
    ])
    expect(result!.sourceMessageIds).toEqual(['visitor-1','ai-1'])
    expect(result!.text).not.toContain('HUMAN_PRIVATE_SHOULD_NOT_APPEAR')
    expect(result!.text).not.toContain('SYSTEM_SECRET_SHOULD_NOT_APPEAR')
  })
  test('cannot fabricate an AI-handled portion from visitor-only or system-only data',()=>{
    expect(summarizeHandoffMessages([visitor])).toBeNull()
    expect(summarizeHandoffMessages([msg('sys','system','AI said something')])).toBeNull()
    expect(summarizeHandoffMessages([])).toBeNull()
  })
  test('invalid, nontext and malformed content cannot become factual claims',()=>{
    const invalid={id:'bad-1',senderType:'ai',contentType:'text',content:{text:{price:999}},createdAt:new Date()} as unknown as HandoffSourceMessage
    const binary={...ai,id:'binary',contentType:'file',content:{url:'https://example.com/secret'}} as HandoffSourceMessage
    const summary=summarizeHandoffMessages([visitor,invalid,binary,ai])
    expect(summary!.sourceMessageIds).toEqual(['visitor-1','ai-1'])
    expect(summary!.text).not.toContain('example.com/secret')
    expect(summary!.text).not.toContain('999')
  })
  test('deduplicates identical message IDs; conflicting records fail closed',()=>{
    expect(summarizeHandoffMessages([visitor,visitor,ai])).toEqual(summarizeHandoffMessages([visitor,ai]))
    expect(summarizeHandoffMessages([visitor,{...visitor,content:{text:'متن متفاوت'}},ai])).toBeNull()
    expect(summarizeHandoffMessages([visitor,ai,{...ai,content:{text:'قیمت متناقض'}}])).toBeNull()
  })
  test('bounded total output and bounded source IDs for very large inputs',()=>{
    const many=Array.from({length:800},(_,i)=>msg('v-'+i,'contact','تکراری'.repeat(700),
      new Date(2026,10,6,9,0,i).toISOString()))
    const out=summarizeHandoffMessages([...many,ai])
    if(out){
      expect(out.text.length).toBeLessThanOrEqual(3000)
      expect(out.sourceMessageIds.length).toBeLessThanOrEqual(30)
      expect(out.sourceMessageIds.length).toBeGreaterThan(0)
      expect(out.truncated).toBe(true)
    }
  })
  test('single huge message never produces unbounded output',()=>{
    const out=summarizeHandoffMessages([visitor,{...ai,content:{text:'الف'.repeat(120000)}}])
    expect(out).not.toBeNull()
    expect(out!.text.length).toBeLessThanOrEqual(3000)
    expect(out!.truncated).toBe(true)
  })
  test('HTML/script-like source is treated as text, never executable markup',()=>{
    const payload='<script>alert(1)</script><img src=x onerror=alert(2)>'
    const out=summarizeHandoffMessages([visitor,{...ai,content:{text:payload}}])
    expect(out).not.toBeNull()
    expect(out!.text).not.toContain('<script')
    expect(out!.text).not.toContain('onerror=')
    expect(out!.sourceMessageIds).toContain('ai-1')
  })
  test('does not mutate, sort in place, or rewrite owner-authored persisted messages',()=>{
    const input=Object.freeze([Object.freeze(visitor),Object.freeze(ai)])
    const original=JSON.stringify(input)
    expect(summarizeHandoffMessages(input)).not.toBeNull()
    expect(JSON.stringify(input)).toBe(original)
  })
  test('wrong types, blank strings and invalid date fields are excluded without crashes',()=>{
    const bad={id:'?',senderType:'ai',contentType:'text',content:{text:'not real'},createdAt:'not-a-date'} as unknown as HandoffSourceMessage
    const blank=msg('blank','ai','   ')
    const r=summarizeHandoffMessages([bad,blank,visitor,ai])
    expect(r!.sourceMessageIds).toEqual(['visitor-1','ai-1'])
  })
})
