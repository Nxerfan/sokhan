/// <reference types="bun-types" />
/**
 * Independent reviewer AI-Q5 human-takeover policy acceptance.
 * IMMUTABLE. This policy is a final decision based on SERVER-VERIFIED state,
 * never a client-supplied flag. Fail closed on malformed or unknown state.
 */
import {describe,test,expect} from 'bun:test'
import {canAiAutoReply,type HumanTakeoverState} from '../../src/lib/ai/human-takeover-policy'

const idle=():HumanTakeoverState=>({
  status:'open',assignedUserId:null,firstResponseAt:null,agentMessageCount:0,
})
describe('Reviewer AI-Q5 — deterministic human takeover decision',()=>{
  test('unassigned open conversation without human reply permits AI',()=>{
    expect(canAiAutoReply(idle())).toBe(true)
  })
  test('assigned agent blocks AI even before agent replies',()=>{
    expect(canAiAutoReply({...idle(),assignedUserId:'user-1'})).toBe(false)
  })
  test('existing human response timestamp blocks AI, even if unassigned now',()=>{
    expect(canAiAutoReply({...idle(),firstResponseAt:new Date('2026-11-01T12:00:00Z')})).toBe(false)
  })
  test('persisted agent reply blocks AI when assignment and timestamp are missing',()=>{
    expect(canAiAutoReply({...idle(),agentMessageCount:1})).toBe(false)
  })
  test('multiple human replies remain blocked',()=>{
    expect(canAiAutoReply({...idle(),agentMessageCount:25})).toBe(false)
  })
  for(const status of ['closed','pending','resolved','deleted',''])test('status '+JSON.stringify(status)+' never auto-replies',()=>{
    expect(canAiAutoReply({...idle(),status})).toBe(false)
  })
  test('a nonzero count cannot be hidden by casting or coercion',()=>{
    expect(canAiAutoReply({...idle(),agentMessageCount:'1' as never})).toBe(false)
  })
  test('missing/null/negative/noninteger reply counts fail closed',()=>{
    for(const count of [undefined,null,-1,NaN,Infinity,0.5]){
      expect(canAiAutoReply({...idle(),agentMessageCount:count as never})).toBe(false)
    }
  })
  test('missing agent-assignment field or invalid time fails closed',()=>{
    expect(canAiAutoReply({...idle(),assignedUserId:undefined as never})).toBe(false)
    expect(canAiAutoReply({...idle(),firstResponseAt:undefined as never})).toBe(false)
    expect(canAiAutoReply({...idle(),firstResponseAt:'yesterday' as never})).toBe(false)
  })
  test('never mutates input state',()=>{
    const original=Object.freeze({...idle()})
    expect(canAiAutoReply(original)).toBe(true)
    expect(original).toEqual(idle())
  })
})
