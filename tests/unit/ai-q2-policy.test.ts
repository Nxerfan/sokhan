/// <reference types="bun-types" />
/**
 * Independent reviewer-owned AI-Q2 policy contract.
 * No network, DB or model provider. The AI-Q2 implementation agent must not edit.
 */
import { describe, test, expect } from 'bun:test'
import { getPlan, isPaidPlan, PLANS } from '../../src/lib/payments/plans'
import {
  resolveAiUsageWindow,
  getAiRemaining,
} from '../../src/lib/ai/usage-policy'

const d = (iso: string) => new Date(iso)
const plan = (slug: string) => PLANS.find(p => p.slug === slug)!

describe('Reviewer AI-Q2 — exact owner-approved plan contract', () => {
  test('Pro is 1,200,000 toman and 1,400 SUCCESSFULLY PERSISTED AI replies/month', () => {
    expect(plan('pro').priceToman).toBe(1_200_000)
    expect(plan('pro').limits.aiActions).toBe(1_400)
    expect(plan('pro').interval).toBe('month')
  })
  test('Max is 7,500,000 toman and 10,000 successful AI replies/month', () => {
    expect(plan('max').priceToman).toBe(7_500_000)
    expect(plan('max').limits.aiActions).toBe(10_000)
    expect(plan('max').interval).toBe('month')
  })
  test('Free built-in Sukhan-funded AI is exactly zero, not a recurring sample quota', () => {
    expect(plan('free').priceToman).toBe(0)
    expect(plan('free').limits.aiActions).toBe(0)
  })
  test('Self-hosted remains contact-sales with existing unlimited (-1) catalog contract', () => {
    expect(plan('self-hosted').contactSales).toBe(true)
    expect(plan('self-hosted').limits.aiActions).toBe(-1)
  })
  test('Both Pro and Max count as paid plans (but external gateway configuration is separate)', () => {
    expect(isPaidPlan('pro')).toBe(true)
    expect(isPaidPlan('max')).toBe(true)
    expect(isPaidPlan('free')).toBe(false)
    expect(isPaidPlan('self-hosted')).toBe(false)
  })
  test('Unknown or prototype-name plan slugs fail closed', () => {
    for (const slug of ['', 'invalid', 'constructor', 'toString', '__proto__', 'prototype']) {
      expect(getPlan(slug)).toBeNull()
    }
  })
})

describe('Reviewer AI-Q2 — authoritative billing period resolver', () => {
  test('No active subscription: UTC calendar month [start,end), not local wall clock', () => {
    expect(resolveAiUsageWindow(d('2026-11-03T23:30:00Z'), null))
      .toEqual({ start: d('2026-11-01T00:00:00Z'), end: d('2026-12-01T00:00:00Z'), source: 'calendar' })
  })
  test('Calendar December crosses the year boundary exactly', () => {
    expect(resolveAiUsageWindow(d('2026-12-31T23:59:59.999Z'), null))
      .toEqual({ start: d('2026-12-01T00:00:00Z'), end: d('2027-01-01T00:00:00Z'), source: 'calendar' })
  })
  test('Leap-day February 2028 is counted in February, not prematurely reset', () => {
    expect(resolveAiUsageWindow(d('2028-02-29T12:00:00Z'), null))
      .toEqual({ start: d('2028-02-01T00:00:00Z'), end: d('2028-03-01T00:00:00Z'), source: 'calendar' })
  })
  test('Pending/failed subscription is NOT an entitlement period', () => {
    for (const status of ['pending','failed','canceled']) {
      const result = resolveAiUsageWindow(d('2026-11-20T12:00:00Z'), {
        status, currentPeriodStart: d('2026-11-12T10:00:00Z'), currentPeriodEnd: d('2026-12-12T10:00:00Z'),
      })
      expect(result?.source).toBe('calendar')
    }
  })
  test('Valid active subscription uses exact stored billing boundaries, not calendar first', () => {
    const start = d('2026-11-11T11:00:00Z'), end = d('2026-12-11T11:00:00Z')
    expect(resolveAiUsageWindow(d('2026-12-01T05:00:00Z'), {
      status: 'active', currentPeriodStart: start, currentPeriodEnd: end,
    })).toEqual({ start, end, source: 'subscription' })
  })
  test('Start inclusive, end exclusive', () => {
    const sub = { status:'active', currentPeriodStart:d('2026-11-11T11:00:00Z'), currentPeriodEnd:d('2026-12-11T11:00:00Z') }
    expect(resolveAiUsageWindow(sub.currentPeriodStart, sub)?.source).toBe('subscription')
    expect(resolveAiUsageWindow(sub.currentPeriodEnd, sub)).toBeNull()
  })
  test('Active but NOT-YET-STARTED subscription fails closed', () => {
    expect(resolveAiUsageWindow(d('2026-11-10T00:00:00Z'), {
      status:'active', currentPeriodStart:d('2026-11-11T00:00:00Z'), currentPeriodEnd:d('2026-12-11T00:00:00Z'),
    })).toBeNull()
  })
  test('Active expired subscription fails closed instead of silently resetting to a new calendar period', () => {
    expect(resolveAiUsageWindow(d('2026-12-12T00:00:00Z'), {
      status:'active', currentPeriodStart:d('2026-11-11T00:00:00Z'), currentPeriodEnd:d('2026-12-11T00:00:00Z'),
    })).toBeNull()
  })
  test('Active subscription with missing, reversed or invalid dates fails closed', () => {
    const now=d('2026-11-20T00:00:00Z')
    expect(resolveAiUsageWindow(now,{status:'active',currentPeriodStart:null,currentPeriodEnd:null})).toBeNull()
    expect(resolveAiUsageWindow(now,{status:'active',currentPeriodStart:d('2026-12-01T00:00:00Z'),currentPeriodEnd:d('2026-11-01T00:00:00Z')})).toBeNull()
    expect(resolveAiUsageWindow(now,{status:'active',currentPeriodStart:new Date(NaN),currentPeriodEnd:d('2026-12-01T00:00:00Z')})).toBeNull()
  })
  test('Resolver is pure: does not mutate input Date objects', () => {
    const now=d('2026-11-22T13:00:00Z'), before=now.getTime()
    const sub={status:'active',currentPeriodStart:d('2026-11-01T00:00:00Z'),currentPeriodEnd:d('2026-12-01T00:00:00Z')}
    const start=sub.currentPeriodStart.getTime(),end=sub.currentPeriodEnd.getTime()
    resolveAiUsageWindow(now,sub)
    expect([now.getTime(),sub.currentPeriodStart.getTime(),sub.currentPeriodEnd.getTime()]).toEqual([before,start,end])
  })
})

describe('Reviewer AI-Q2 — reservation-aware capacity calculation', () => {
  test('Free zero means no remaining even before any reservation', () => {
    expect(getAiRemaining(0,0,0)).toBe(0)
  })
  test('Paid plan deducts reserved and committed replies from available capacity', () => {
    expect(getAiRemaining(100,10,1400)).toBe(1290)
  })
  test('At the final slot exactly one additional reservation can be admitted', () => {
    expect(getAiRemaining(1399,0,1400)).toBe(1)
    expect(getAiRemaining(1399,1,1400)).toBe(0)
  })
  test('An exhausted/overdrawn limit cannot produce negative remaining quota', () => {
    expect(getAiRemaining(1400,0,1400)).toBe(0)
    expect(getAiRemaining(1500,3,1400)).toBe(0)
  })
  test('Unlimited self-hosted capacity returns null remaining (not a fake large number)', () => {
    expect(getAiRemaining(987654,30,-1)).toBeNull()
  })
  test('Invalid/negative counts fail closed, never grant extra capacity', () => {
    for (const u of [-1,NaN,Infinity,0.5]) expect(getAiRemaining(u,0,1400)).toBe(0)
    for (const r of [-1,NaN,Infinity,1.1]) expect(getAiRemaining(0,r,1400)).toBe(0)
  })
  test('A just-released reservation frees exactly one slot; no billed reply is created', () => {
    expect(getAiRemaining(1399,1,1400)).toBe(0)
    expect(getAiRemaining(1399,0,1400)).toBe(1)
  })
})


describe('Reviewer AI-Q2 — durable HTTP idempotency transaction contract',()=>{
  test('visitor Message and idempotency claim must be created inside ONE database transaction',async()=>{
    // Separate durable writes leave orphan visitor Messages when a concurrent
    // idempotency claim loses its unique-key race or claim persistence fails.
    const code=await Bun.file(new URL('../../src/app/api/widget/[slug]/messages/route.ts',import.meta.url)).text()
    const start=code.indexOf('// Find or create the conversation.')
    const end=code.indexOf('// Update conversation metadata.',start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const insertPath=code.slice(start,end)
    expect(insertPath,'Visitor Message + claim creation must have one transactional boundary').toContain('$transaction(')
    expect(insertPath,'Direct auto-committed Message create is not atomic with claim').not.toMatch(/\bdb\.message\.create\s*\(/)
    expect(insertPath,'Direct auto-committed claim create is not atomic with Message').not.toMatch(/\bdb\.visitorMessageIdempotency\.create\s*\(/)
  })
  test('unique-key collision must compare original text before returning an idempotent retry',async()=>{
    const code=await Bun.file(new URL('../../src/app/api/widget/[slug]/messages/route.ts',import.meta.url)).text()
    const start=code.indexOf('// Concurrent idempotency create')
    expect(start).toBeGreaterThan(0)
    const end=code.indexOf("throw new Error('Failed to persist visitor message')",start)
    expect(end).toBeGreaterThan(start)
    const collisionPath=code.slice(start,end)
    expect(collisionPath,'Concurrent key collisions with different text must return HTTP 409, never original Message').toContain('messageText')
    expect(collisionPath).toContain('idempotency_conflict')
  })
})


describe('Reviewer AI-Q2 — real built-in widget retry uses the original idempotency key',()=>{
  test('retrying the same failed optimistic send must NOT invent a new clientMessageId',async()=>{
    const source=await Bun.file(new URL('../../src/app/api/widget/[slug]/script/route.ts',import.meta.url)).text()
    const start=source.indexOf('function retrySendMessage(optimisticId, text)')
    expect(start).toBeGreaterThan(0)
    const end=source.indexOf('fetch(MESSAGES_URL',start)
    expect(end).toBeGreaterThan(start)
    const retry=source.slice(start,end)
    expect(retry,'Retries must derive the idempotency key from the original failed optimistic message').toContain('_clientMessageId')
    expect(retry,'A new cmsg_retry_ token defeats server-side idempotency when the original response was lost').not.toContain("'cmsg_retry_'")
  })
})
