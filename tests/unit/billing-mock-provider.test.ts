/// <reference types="bun-types" />
/**
 * Mock payment provider behavioral tests (no DB, no network).
 *
 * Verifies the deterministic MockPaymentProvider supports every scenario the
 * billing service + tests rely on, and that it records calls for assertions
 * (e.g. "provider was NOT called for a zero-amount plan").
 */

import { test, expect, describe, beforeEach } from 'bun:test'
import { createMockProvider, MockPaymentProvider } from '@/lib/payments/mock-provider'

describe('MockPaymentProvider', () => {
  let p: MockPaymentProvider
  beforeEach(() => {
    p = createMockProvider()
  })

  test('name is "mock" and testMode is true', () => {
    expect(p.name).toBe('mock')
    expect(p.testMode).toBe(true)
  })

  test('create_success: returns a deterministic authority + gatewayUrl', async () => {
    p.setCreateScenario('create_success')
    const res = await p.createPayment({
      amount: 1000,
      description: 'test plan',
      callbackUrl: 'https://app.test/api/billing/callback/mock?invoiceId=inv-1',
    })
    expect(res.authority).toBe('MOCK-AUTH-inv-1')
    expect(res.gatewayUrl).toContain('MOCK-AUTH-inv-1')
    expect(p.wasCalled('createPayment')).toBe(true)
    expect(p.callCount('createPayment')).toBe(1)
  })

  test('create_failure: createPayment throws + records the error', async () => {
    p.setCreateScenario('create_failure')
    await expect(
      p.createPayment({ amount: 1000, description: 'x', callbackUrl: 'https://a.test/cb?invoiceId=i2' }),
    ).rejects.toThrow(/create_failure/)
    expect(p.callCount('createPayment')).toBe(1)
    const last = p.recordedCalls().slice(-1)[0]
    expect(last?.error).toContain('create_failure')
  })

  test('verify_success: returns success + refId', async () => {
    p.setVerifyScenario('verify_success')
    const r = await p.verifyPayment({ authority: 'MOCK-AUTH-1', amount: 1000 })
    expect(r.success).toBe(true)
    expect(r.refId).toBe('MOCK-REF-MOCK-AUTH-1')
  })

  test('verify_failure: returns success=false + message', async () => {
    p.setVerifyScenario('verify_failure')
    const r = await p.verifyPayment({ authority: 'a', amount: 1000 })
    expect(r.success).toBe(false)
    expect(r.message).toContain('verify_failure')
  })

  test('verify_throw: throws + records error', async () => {
    p.setVerifyScenario('verify_throw')
    await expect(p.verifyPayment({ authority: 'a', amount: 1000 })).rejects.toThrow(/verify_throw/)
  })

  test('callback_success: parseCallback returns success_candidate', () => {
    p.setCallbackScenario('callback_success')
    const q = new URLSearchParams('Authority=MOCK-AUTH-1')
    const r = p.parseCallback(q)
    expect(r.kind).toBe('success_candidate')
    expect(r.authority).toBe('MOCK-AUTH-1')
  })

  test('callback_canceled: parseCallback returns canceled', () => {
    p.setCallbackScenario('callback_canceled')
    const r = p.parseCallback(new URLSearchParams(''))
    expect(r.kind).toBe('canceled')
  })

  test('callback_malformed: parseCallback returns invalid + reasonCode', () => {
    p.setCallbackScenario('callback_malformed')
    const r = p.parseCallback(new URLSearchParams(''))
    expect(r.kind).toBe('invalid')
    expect(r.reasonCode).toBe('malformed_callback')
  })

  test('reset clears call history + scenarios', async () => {
    await p.createPayment({ amount: 1, description: 'x', callbackUrl: 'https://a.test/cb?invoiceId=1' })
    expect(p.callCount('createPayment')).toBe(1)
    p.reset()
    expect(p.callCount('createPayment')).toBe(0)
    expect(p.wasCalled('createPayment')).toBe(false)
  })

  test('wasCalled/callCount track each method independently', async () => {
    p.setVerifyScenario('verify_success')
    await p.verifyPayment({ authority: 'a', amount: 1 })
    p.parseCallback(new URLSearchParams('Authority=a'))
    expect(p.callCount('verifyPayment')).toBe(1)
    expect(p.callCount('parseCallback')).toBe(1)
    expect(p.callCount('createPayment')).toBe(0)
  })

  test('deterministic authority derives from callbackUrl invoiceId (no Date.now/random)', async () => {
    p.setCreateScenario('create_success')
    const r1 = await p.createPayment({
      amount: 1000,
      description: 'x',
      callbackUrl: 'https://a.test/api/billing/callback/mock?invoiceId=stable-id',
    })
    const r2 = await p.createPayment({
      amount: 1000,
      description: 'x',
      callbackUrl: 'https://a.test/api/billing/callback/mock?invoiceId=stable-id',
    })
    expect(r1.authority).toBe(r2.authority)
    expect(r1.authority).toBe('MOCK-AUTH-stable-id')
  })
})
