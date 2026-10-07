/// <reference types="bun-types" />
/**
 * Billing state-machine unit tests (pure — no DB, no IO).
 *
 * Verifies the legal/illegal Invoice + Subscription transitions per the PR
 * contract. These are pure functions — they execute against the state-machine
 * module only.
 */

import { test, expect, describe } from 'bun:test'
import {
  canTransitionInvoice,
  canTransitionSubscription,
  assertInvoiceTransition,
  assertSubscriptionTransition,
  isInvoiceTerminal,
  isSubscriptionTerminal,
  isIdempotentPaidSuccess,
  isValidInvoiceStatus,
  isValidSubscriptionStatus,
  IllegalBillingTransitionError,
  INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
} from '@/lib/payments/billing-state'

describe('Invoice transitions', () => {
  test('pending -> paid is legal (verified success)', () => {
    expect(canTransitionInvoice('pending', 'paid')).toBe(true)
    expect(() => assertInvoiceTransition('pending', 'paid')).not.toThrow()
  })
  test('pending -> failed is legal', () => {
    expect(canTransitionInvoice('pending', 'failed')).toBe(true)
  })
  test('pending -> canceled is legal', () => {
    expect(canTransitionInvoice('pending', 'canceled')).toBe(true)
  })
  test('pending -> expired is legal', () => {
    expect(canTransitionInvoice('pending', 'expired')).toBe(true)
  })

  test('paid -> paid is legal (idempotent duplicate-success no-op)', () => {
    expect(canTransitionInvoice('paid', 'paid')).toBe(true)
    expect(isIdempotentPaidSuccess('paid', 'paid')).toBe(true)
  })

  test('paid -> failed is FORBIDDEN (paid is terminal-success)', () => {
    expect(canTransitionInvoice('paid', 'failed')).toBe(false)
    expect(() => assertInvoiceTransition('paid', 'failed')).toThrow(IllegalBillingTransitionError)
  })
  test('paid -> canceled is FORBIDDEN', () => {
    expect(canTransitionInvoice('paid', 'canceled')).toBe(false)
    expect(() => assertInvoiceTransition('paid', 'canceled')).toThrow(IllegalBillingTransitionError)
  })
  test('paid -> expired is FORBIDDEN', () => {
    expect(canTransitionInvoice('paid', 'expired')).toBe(false)
  })

  test('failed -> * is FORBIDDEN (failed is terminal)', () => {
    for (const to of INVOICE_STATUSES) {
      if (to === 'failed') continue
      expect(canTransitionInvoice('failed', to)).toBe(false)
    }
  })
  test('canceled -> * is FORBIDDEN (canceled is terminal)', () => {
    for (const to of INVOICE_STATUSES) {
      if (to === 'canceled') continue
      expect(canTransitionInvoice('canceled', to)).toBe(false)
    }
  })
  test('expired -> * is FORBIDDEN (expired is terminal)', () => {
    for (const to of INVOICE_STATUSES) {
      if (to === 'expired') continue
      expect(canTransitionInvoice('expired', to)).toBe(false)
    }
  })

  test('paid/failed/canceled/expired are all terminal', () => {
    expect(isInvoiceTerminal('paid')).toBe(true)
    expect(isInvoiceTerminal('failed')).toBe(true)
    expect(isInvoiceTerminal('canceled')).toBe(true)
    expect(isInvoiceTerminal('expired')).toBe(true)
    expect(isInvoiceTerminal('pending')).toBe(false)
  })
})

describe('Subscription transitions', () => {
  test('pending -> active is legal (payment verified)', () => {
    expect(canTransitionSubscription('pending', 'active')).toBe(true)
    expect(() => assertSubscriptionTransition('pending', 'active')).not.toThrow()
  })
  test('pending -> canceled is legal (payment failed/cancelled/expired)', () => {
    expect(canTransitionSubscription('pending', 'canceled')).toBe(true)
  })
  test('pending -> expired is legal (checkout expired)', () => {
    expect(canTransitionSubscription('pending', 'expired')).toBe(true)
  })
  test('active -> canceled is legal (replaced by newer success / admin downgrade)', () => {
    expect(canTransitionSubscription('active', 'canceled')).toBe(true)
  })

  test('canceled -> active is FORBIDDEN (create a NEW subscription instead)', () => {
    expect(canTransitionSubscription('canceled', 'active')).toBe(false)
    expect(() => assertSubscriptionTransition('canceled', 'active')).toThrow(IllegalBillingTransitionError)
  })
  test('canceled -> * is FORBIDDEN (terminal)', () => {
    for (const to of SUBSCRIPTION_STATUSES) {
      if (to === 'canceled') continue
      expect(canTransitionSubscription('canceled', to)).toBe(false)
    }
  })
  test('expired -> * is FORBIDDEN (terminal)', () => {
    for (const to of SUBSCRIPTION_STATUSES) {
      if (to === 'expired') continue
      expect(canTransitionSubscription('expired', to)).toBe(false)
    }
  })
  test('active -> pending is FORBIDDEN (never re-pend an active sub)', () => {
    expect(canTransitionSubscription('active', 'pending')).toBe(false)
  })

  test('canceled/expired are terminal', () => {
    expect(isSubscriptionTerminal('canceled')).toBe(true)
    expect(isSubscriptionTerminal('expired')).toBe(true)
    expect(isSubscriptionTerminal('pending')).toBe(false)
    expect(isSubscriptionTerminal('active')).toBe(false)
  })
})

describe('Status guards', () => {
  test('isValidInvoiceStatus accepts the 5 known statuses', () => {
    for (const s of INVOICE_STATUSES) expect(isValidInvoiceStatus(s)).toBe(true)
    expect(isValidInvoiceStatus('PAID')).toBe(false)
    expect(isValidInvoiceStatus('other')).toBe(false)
    expect(isValidInvoiceStatus(123)).toBe(false)
    expect(isValidInvoiceStatus(null)).toBe(false)
    expect(isValidInvoiceStatus(undefined)).toBe(false)
  })
  test('isValidSubscriptionStatus accepts the 4 known statuses', () => {
    for (const s of SUBSCRIPTION_STATUSES) expect(isValidSubscriptionStatus(s)).toBe(true)
    expect(isValidSubscriptionStatus('ACTIVE')).toBe(false)
    expect(isValidSubscriptionStatus('foo')).toBe(false)
  })
})

describe('IllegalBillingTransitionError', () => {
  test('carries entity + from + to on the thrown instance', () => {
    let caught: IllegalBillingTransitionError | null = null
    try {
      assertInvoiceTransition('paid', 'failed')
    } catch (e) {
      caught = e as IllegalBillingTransitionError
    }
    expect(caught).not.toBeNull()
    expect(caught!.entity).toBe('invoice')
    expect(caught!.from).toBe('paid')
    expect(caught!.to).toBe('failed')
    expect(caught!.name).toBe('IllegalBillingTransitionError')
  })
})
