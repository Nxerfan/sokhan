/// <reference types="bun-types" />
/**
 * INDEPENDENT REVIEWER AI-Q6 — immutable adversarial provenance contract.
 * New tests only: never re-run the full Q1-Q5 suites on the Q6 PR.
 * Tests must fail if a source ID describes facts not actually present in
 * the displayed summary, or if duplicate ID identities are contradictory.
 */
import {describe,test,expect} from 'bun:test'
import {summarizeHandoffMessages,type HandoffSourceMessage}
  from '../../src/lib/ai/handoff-summary-policy'

const row=(id:string,senderType:string,text:string,createdAt=new Date('2026-11-06T10:00:00.000Z')):HandoffSourceMessage=>({
  id,senderType,contentType:'text',content:{text},createdAt,
})

describe('Reviewer AI-Q6 — adversarial source provenance and bounded chronology',()=>{
  test('contradictory duplicate IDs with equal text but different sender roles fail closed',()=>{
    const visitor=row('same-id','contact','چراغ آذر')
    const changed={...visitor,senderType:'ai'}
    const genuineAi=row('ai-other','ai','قیمت ۲۴۰۰۰۰ تومان')
    expect(summarizeHandoffMessages([visitor,changed,genuineAi])).toBeNull()
  })

  test('contradictory duplicate IDs with equal text but different timestamps fail closed',()=>{
    const visitor=row('same-id','contact','موجودی چراغ')
    const changed={...visitor,createdAt:new Date('2026-11-06T11:00:00.000Z')}
    const ai=row('ai-other','ai','موجود است')
    expect(summarizeHandoffMessages([visitor,ai,changed])).toBeNull()
  })

  test('every source ID in the persisted provenance list must have a visible grounded excerpt',()=>{
    const input=Array.from({length:28},(_,i)=>row(
      'msg-'+String(i).padStart(2,'0'),
      i===1?'ai':'contact',
      'UNIQUE_FACT_'+String(i).padStart(2,'0')+' '+('متن'.repeat(67)),
      new Date(Date.UTC(2026,10,6,10,0,i)),
    ))
    const summary=summarizeHandoffMessages(input)
    expect(summary).not.toBeNull()
    expect(summary!.sourceMessageIds.length).toBeGreaterThan(0)
    expect(summary!.text.length).toBeLessThanOrEqual(3000)
    for(const id of summary!.sourceMessageIds){
      const marker='UNIQUE_FACT_'+id.slice(4)
      expect(summary!.text, 'Source '+id+' lacks any displayed evidence').toContain(marker)
    }
    expect(summary!.sourceMessageIds.length).toBeLessThan(input.length)
    expect(summary!.truncated).toBe(true)
  })

  test('when an older AI reply is retained from beyond the 30-message window, chronology remains ordered',()=>{
    const earliestAi=row('ai-earliest','ai','AI_FACT_EARLIEST',
      new Date('2026-11-06T08:00:00.000Z'))
    const later=Array.from({length:40},(_,i)=>row(
      'later-'+String(i).padStart(2,'0'),'contact',
      'VISITOR_LATER_'+String(i).padStart(2,'0'),
      new Date(Date.UTC(2026,10,6,9,0,i)),
    ))
    const result=summarizeHandoffMessages([...later,earliestAi])
    expect(result).not.toBeNull()
    expect(result!.sourceMessageIds).toContain('ai-earliest')
    expect(result!.sourceMessageIds[0]).toBe('ai-earliest')
    expect(result!.text.indexOf('AI_FACT_EARLIEST')).toBeLessThan(result!.text.indexOf('VISITOR_LATER'))
    expect(result!.sourceMessageIds.length).toBeLessThanOrEqual(30)
  })
})
