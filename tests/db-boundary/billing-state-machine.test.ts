/// <reference types="bun-types" />
/**
 * Real-PostgreSQL billing state-machine tests.
 *
 * Executed against Docker PostgreSQL in the `docker-regression` CI job (Full
 * + Lite) via the existing `bun test tests/db-boundary/` step. Uses the
 * deterministic MockPaymentProvider ONLY — ZERO network calls to any real
 * payment gateway (ZarinPal/IDPay/ZarinLink are never contacted).
 *
 * Coverage (PR brief §30 + §31):
 *   Checkout:
 *     - paid plan -> pending Subscription + pending Invoice
 *     - existing active subscription PRESERVED before payment
 *     - callback URL contains the REAL invoice id (no PLACEHOLDER)
 *     - create-payment failure -> pending rows canceled (compensating)
 *     - zero amount never calls the provider
 *   Success:
 *     - verify success -> Invoice paid, refId stored, paidAt set
 *     - new Subscription active, previous active canceled
 *     - Tenant.plan updated
 *     - atomic (all-or-nothing)
 *   Failure / cancel:
 *     - Invoice failed/canceled, pending Subscription canceled
 *     - previous active subscription preserved
 *     - Tenant.plan unchanged
 *   Idempotency:
 *     - duplicate success safe (no duplicate sub/invoice)
 *     - duplicate cancel safe
 *     - cancel after paid blocked (paid is terminal)
 *     - failure after paid blocked
 *   Integrity:
 *     - gateway mismatch blocked
 *     - authority mismatch blocked
 *     - expired invoice blocked
 *   Race:
 *     - success vs cancel (one terminal wins)
 *     - two success callbacks on same invoice (idempotent)
 *     - two competing successful checkouts -> exactly one active subscription
 *   Consistency:
 *     - Tenant.plan matches the final active Subscription
 *     - Invoice paid state corresponds to the intended Subscription
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import {
  createCheckout,
  handleCallback,
  transitionToFreePlan,
  BillingError,
  type BillingDeps,
} from '@/lib/payments/billing-service'
import { createMockProvider, type MockPaymentProvider } from '@/lib/payments/mock-provider'
import type { Plan } from '@/lib/payments/plans'
import { PLANS as CATALOG_PLANS } from '@/lib/payments/plans'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

// A test-only paid plan (priceToman > 0). The production catalog has all paid
// plans at price 0 ("Coming Soon") — tests inject this plan via deps.getPlan.
const TEST_PAID_PLAN = {
  slug: 'test-pro',
  name: 'Test Pro',
  priceToman: 1000,
  interval: 'month' as const,
  limits: { agents: 5, conversations: 100_000, departments: 5, aiActions: 100, websites: 3, weeklyMessages: -1 },
  contactSales: false,
  customization: true,
  trialDays: 0,
} as unknown as Plan

const TEST_PAID_PLAN_2 = {
  ...TEST_PAID_PLAN,
  slug: 'test-max',
  name: 'Test Max',
  priceToman: 2000,
} as unknown as Plan

let tenantA: { id: string }
let tenantB: { id: string }
let freePlanRowId: string

beforeAll(async () => {
  // Seed plan rows the service looks up via db.plan.findUnique.
  await globalDb.plan.upsert({
    where: { slug: 'free' },
    create: {
      slug: 'free',
      name: 'Free',
      priceToman: 0,
      interval: 'month',
      limits: (CATALOG_PLANS.find((p) => p.slug === 'free')!.limits) as unknown as object,
      active: true,
    },
    update: { active: true },
  })
  await globalDb.plan.upsert({
    where: { slug: TEST_PAID_PLAN.slug },
    create: {
      slug: TEST_PAID_PLAN.slug,
      name: TEST_PAID_PLAN.name,
      priceToman: TEST_PAID_PLAN.priceToman,
      interval: TEST_PAID_PLAN.interval,
      limits: TEST_PAID_PLAN.limits as unknown as object,
      active: true,
    },
    update: { priceToman: TEST_PAID_PLAN.priceToman, active: true },
  })
  await globalDb.plan.upsert({
    where: { slug: TEST_PAID_PLAN_2.slug },
    create: {
      slug: TEST_PAID_PLAN_2.slug,
      name: TEST_PAID_PLAN_2.name,
      priceToman: TEST_PAID_PLAN_2.priceToman,
      interval: TEST_PAID_PLAN_2.interval,
      limits: TEST_PAID_PLAN_2.limits as unknown as object,
      active: true,
    },
    update: { priceToman: TEST_PAID_PLAN_2.priceToman, active: true },
  })

  const freeRow = await globalDb.plan.findUnique({ where: { slug: 'free' }, select: { id: true } })
  freePlanRowId = freeRow!.id

  tenantA = await globalDb.tenant.create({
    data: {
      slug: `bsm-a-${RUN_ID}`,
      name: `Billing A ${RUN_ID}`,
      plan: 'free',
    },
    select: { id: true },
  })
  tenantB = await globalDb.tenant.create({
    data: {
      slug: `bsm-b-${RUN_ID}`,
      name: `Billing B ${RUN_ID}`,
      plan: 'free',
    },
    select: { id: true },
  })
})

/** Remove all subscriptions + invoices for the shared test tenants, reset plan.
 * Prevents cross-test interference (duplicate-pending reuse, leftover paid rows). */
async function cleanTenantState(): Promise<void> {
  for (const tid of [tenantA.id, tenantB.id]) {
    await globalDb.invoice.deleteMany({ where: { tenantId: tid } }).catch(() => {})
    await globalDb.subscription.deleteMany({ where: { tenantId: tid } }).catch(() => {})
    await globalDb.tenant.update({ where: { id: tid }, data: { plan: 'free' } }).catch(() => {})
  }
}

// Runs before EVERY test — isolates DB state across the shared tenants.
beforeEach(async () => {
  await cleanTenantState()
})

afterAll(async () => {
  if (tenantA?.id) await globalDb.tenant.deleteMany({ where: { id: tenantA.id } }).catch(() => {})
  if (tenantB?.id) await globalDb.tenant.deleteMany({ where: { id: tenantB.id } }).catch(() => {})
  await db.$disconnect().catch(() => {})
})

/** Build test BillingDeps: mock provider + injected test paid plan + injectable clock. */
function makeDeps(
  mock: MockPaymentProvider,
  opts: { now?: Date; validityMs?: number } = {},
): BillingDeps {
  return {
    resolveProvider(name: string) {
      if (name === 'mock') return mock
      return null
    },
    getPlan(slug: string) {
      if (slug === TEST_PAID_PLAN.slug) return TEST_PAID_PLAN
      if (slug === TEST_PAID_PLAN_2.slug) return TEST_PAID_PLAN_2
      return CATALOG_PLANS.find((p) => p.slug === slug) ?? null
    },
    now: () => opts.now ?? new Date(),
    checkoutValidityMs: opts.validityMs ?? 30 * 60 * 1000,
  }
}

/** Create an existing ACTIVE free subscription for a tenant (bootstrap, via globalDb). */
async function seedActiveFreeSubscription(tenantId: string): Promise<string> {
  const now = new Date()
  const sub = await globalDb.subscription.create({
    data: {
      tenantId,
      planId: freePlanRowId,
      status: 'active',
      gateway: null,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()),
    },
    select: { id: true },
  })
  await globalDb.tenant.update({ where: { id: tenantId }, data: { plan: 'free' } })
  return sub.id
}

/** Count active subscriptions for a tenant (tenant-scoped read). */
async function countActiveSubs(tenantId: string): Promise<number> {
  return withTenant(tenantId, () => db.subscription.count({ where: { status: 'active' } }))
}

describe('§ Checkout creation', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('paid plan -> pending Subscription + pending Invoice; active preserved; real invoiceId in callback URL', async () => {
    const activeSubId = await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    expect(checkout.free).toBe(false)
    expect(checkout.invoiceId).toBeTruthy()
    expect(checkout.subscriptionId).toBeTruthy()
    expect(checkout.authority).toBe(`MOCK-AUTH-${checkout.invoiceId}`)
    // provider was called exactly once (zero-amount guard did not fire).
    expect(mock.callCount('createPayment')).toBe(1)

    // Verify DB state: 1 active (preserved) + 1 pending; 1 pending invoice.
    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      const pending = await db.subscription.findMany({ where: { status: 'pending' } })
      expect(active.length).toBe(1)
      expect(active[0].id).toBe(activeSubId) // preserved
      expect(pending.length).toBe(1)
      expect(pending[0].id).toBe(checkout.subscriptionId)

      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending')
      expect(inv!.authority).toBe(checkout.authority ?? null)
      expect(inv!.amountToman).toBe(TEST_PAID_PLAN.priceToman)
      expect(inv!.gateway).toBe('mock')
      // The callback URL contains the REAL invoice id (no PLACEHOLDER).
      expect(inv!.callbackUrl).toContain(`invoiceId=${inv!.id}`)
      expect(inv!.callbackUrl).not.toContain('PLACEHOLDER')
    })
  })

  test('create-payment failure -> pending rows canceled (compensating); active preserved', async () => {
    const activeSubId = await seedActiveFreeSubscription(tenantA.id)
    mock.setCreateScenario('create_failure')
    const deps = makeDeps(mock)

    let thrown: unknown = null
    try {
      await createCheckout({
        tenantId: tenantA.id,
        planSlug: TEST_PAID_PLAN.slug,
        gatewayName: 'mock',
        origin: 'https://app.test',
        deps,
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BillingError)
    expect((thrown as BillingError).code).toBe('create_payment_failed')

    // The orphaned pending rows must be canceled; active preserved.
    await withTenant(tenantA.id, async () => {
      const pendingSubs = await db.subscription.findMany({ where: { status: 'pending' } })
      expect(pendingSubs.length).toBe(0)
      const canceledSubs = await db.subscription.findMany({ where: { status: 'canceled' } })
      expect(canceledSubs.length).toBe(1)
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1)
      expect(active[0].id).toBe(activeSubId)
    })
  })

  test('zero amount never calls the provider (createCheckout rejects a zero-price plan)', async () => {
    const deps = makeDeps(mock)
    let thrown2: unknown = null
    try {
      await createCheckout({
        tenantId: tenantA.id,
        planSlug: 'free', // priceToman 0
        gatewayName: 'mock',
        origin: 'https://app.test',
        deps,
      })
    } catch (e) {
      thrown2 = e
    }
    expect(thrown2).toBeInstanceOf(BillingError)
    expect((thrown2 as BillingError).code).toBe('invalid_plan')
    expect(mock.callCount('createPayment')).toBe(0)
  })
})

describe('§ Success transition (atomic)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('verify success -> paid invoice, new sub active, prior active canceled, Tenant.plan updated, refId+paidAt set', async () => {
    const priorActiveId = await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })

    // Simulate the gateway callback (success).
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    const res = await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: q,
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('success')

    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
      expect(inv!.refId).toBeTruthy()
      expect(inv!.paidAt).not.toBeNull()

      const newSub = await db.subscription.findUnique({ where: { id: checkout.subscriptionId } })
      expect(newSub!.status).toBe('active')

      const prior = await db.subscription.findUnique({ where: { id: priorActiveId } })
      expect(prior!.status).toBe('canceled')

      // Exactly one active subscription.
      expect(await countActiveSubs(tenantA.id)).toBe(1)

      // Tenant.plan matches the final active subscription's plan.
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(TEST_PAID_PLAN.slug)
    })
  })
})

describe('§ Failure / cancel', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('verify failure -> invoice failed, pending sub canceled, prior active preserved, Tenant.plan unchanged', async () => {
    const priorActiveId = await seedActiveFreeSubscription(tenantA.id)
    mock.setVerifyScenario('verify_failure')
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })

    const res = await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams(`Authority=${checkout.authority}`),
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('verify_failed')

    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('failed')
      const newSub = await db.subscription.findUnique({ where: { id: checkout.subscriptionId } })
      expect(newSub!.status).toBe('canceled')
      const prior = await db.subscription.findUnique({ where: { id: priorActiveId } })
      expect(prior!.status).toBe('active')
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe('free')
    })
  })

  test('cancel callback -> invoice canceled, pending sub canceled, prior active preserved', async () => {
    const priorActiveId = await seedActiveFreeSubscription(tenantA.id)
    mock.setCallbackScenario('callback_canceled')
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })

    const res = await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams(''),
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('canceled')

    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('canceled')
      const newSub = await db.subscription.findUnique({ where: { id: checkout.subscriptionId } })
      expect(newSub!.status).toBe('canceled')
      const prior = await db.subscription.findUnique({ where: { id: priorActiveId } })
      expect(prior!.status).toBe('active')
    })
  })
})

describe('§ Idempotency', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('duplicate success callback is safe (no duplicate sub/invoice, same logical success)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    const r1 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    expect(r1.redirect).toBe('success')
    expect(r2.redirect).toBe('success') // idempotent

    // The second callback must NOT verify again or create side effects.
    expect(mock.callCount('verifyPayment')).toBe(1)
    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1)
      const paid = await db.invoice.findMany({ where: { status: 'paid' } })
      expect(paid.length).toBe(1)
    })
  })

  test('duplicate cancel callback is idempotent', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    mock.setCallbackScenario('callback_canceled')
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const q = new URLSearchParams('')
    const r1 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    expect(r1.redirect).toBe('canceled')
    expect(r2.redirect).toBe('canceled')
    await withTenant(tenantA.id, async () => {
      const canceledInvs = await db.invoice.findMany({ where: { status: 'canceled' } })
      expect(canceledInvs.length).toBe(1)
    })
  })

  test('cancel after paid is blocked (paid is terminal — cannot regress)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    // First: success -> paid.
    await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    // Second: cancel callback on the now-paid invoice — must NOT regress.
    mock.setCallbackScenario('callback_canceled')
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(''), origin: 'https://app.test', deps })
    expect(r2.redirect).toBe('success') // already paid — idempotent success

    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid') // NOT canceled
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1)
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(TEST_PAID_PLAN.slug) // NOT downgraded
    })
  })

  test('failure after paid is blocked', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    // Late failure callback.
    mock.setVerifyScenario('verify_failure')
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    expect(r2.redirect).toBe('success') // paid is terminal
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
    })
  })
})

describe('§ Integrity', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('gateway mismatch is blocked (no state mutation)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    // Callback arrives on a DIFFERENT gateway path.
    const res = await handleCallback({
      gatewayName: 'zarinpal', // path gateway != stored 'mock'
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams(`Authority=${checkout.authority}`),
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('gateway_mismatch')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending') // untouched
    })
  })

  test('authority mismatch is blocked (callback authority != stored authority)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const res = await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams('Authority=DIFFERENT-AUTHORITY'),
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('authority_mismatch')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending')
    })
  })

  test('expired invoice is blocked (callback after checkout validity window)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const past = new Date(Date.now() - 31 * 60 * 1000) // 31 min ago
    const deps = makeDeps(mock, { validityMs: 30 * 60 * 1000 })
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    // Backdate the invoice createdAt to simulate age > 30min.
    await globalDb.invoice.update({ where: { id: checkout.invoiceId! }, data: { createdAt: past } })

    const res = await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams(`Authority=${checkout.authority}`),
      origin: 'https://app.test',
      deps,
    })
    expect(res.redirect).toBe('expired')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('expired')
      const newSub = await db.subscription.findUnique({ where: { id: checkout.subscriptionId } })
      expect(newSub!.status).toBe('canceled')
    })
  })
})

describe('§ Race conditions', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('success vs cancel on the same invoice -> only one terminal transition wins', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const successQ = new URLSearchParams(`Authority=${checkout.authority}`)
    const cancelQ = new URLSearchParams('')

    // Fire both concurrently. One wins; the other is an idempotent no-op.
    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: successQ, origin: 'https://app.test', deps }),
      (async () => {
        // Use a separate mock configured for cancel so parseCallback returns canceled.
        const cancelMock = createMockProvider()
        cancelMock.setCallbackScenario('callback_canceled')
        const cancelDeps = makeDeps(cancelMock)
        return handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: cancelQ, origin: 'https://app.test', deps: cancelDeps })
      })(),
    ])
    // One of them is success, the other is success/canceled (idempotent on paid).
    const redirects = [r1.redirect, r2.redirect].sort()
    expect(redirects).toContain('success')

    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      // Exactly one terminal state — either paid (success won) or canceled.
      expect(['paid', 'canceled']).toContain(inv!.status)
      // No double-transition.
      expect(await countActiveSubs(tenantA.id)).toBeLessThanOrEqual(1)
    })
  })

  test('two success callbacks on the same invoice -> idempotent (one paid, one no-op)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps }),
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps }),
    ])
    expect(r1.redirect).toBe('success')
    expect(r2.redirect).toBe('success')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
      expect(await countActiveSubs(tenantA.id)).toBe(1)
    })
  })

  test('two competing successful checkouts -> exactly one final active subscription', async () => {
    // Bootstrap two pending checkouts (different plans to bypass the
    // duplicate-pending strategy) directly, each with its own authority.
    const now = new Date()
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const planMaxRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN_2.slug }, select: { id: true } })

    const sub1 = await globalDb.subscription.create({
      data: { tenantId: tenantB.id, planId: planProRow!.id, status: 'pending', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) },
      select: { id: true },
    })
    const inv1 = await globalDb.invoice.create({
      data: { tenantId: tenantB.id, subscriptionId: sub1.id, planId: planProRow!.id, amountToman: TEST_PAID_PLAN.priceToman, gateway: 'mock', authority: 'MOCK-AUTH-compete-1', status: 'pending', callbackUrl: `https://app.test/api/billing/callback/mock?invoiceId=compete-1` },
      select: { id: true },
    })
    const sub2 = await globalDb.subscription.create({
      data: { tenantId: tenantB.id, planId: planMaxRow!.id, status: 'pending', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) },
      select: { id: true },
    })
    const inv2 = await globalDb.invoice.create({
      data: { tenantId: tenantB.id, subscriptionId: sub2.id, planId: planMaxRow!.id, amountToman: TEST_PAID_PLAN_2.priceToman, gateway: 'mock', authority: 'MOCK-AUTH-compete-2', status: 'pending', callbackUrl: `https://app.test/api/billing/callback/mock?invoiceId=compete-2` },
      select: { id: true },
    })

    // Both succeed concurrently. The per-tenant FOR UPDATE lock serializes
    // them -> exactly one final active subscription.
    const deps = makeDeps(mock)
    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: inv1.id, query: new URLSearchParams('Authority=MOCK-AUTH-compete-1'), origin: 'https://app.test', deps }),
      handleCallback({ gatewayName: 'mock', invoiceId: inv2.id, query: new URLSearchParams('Authority=MOCK-AUTH-compete-2'), origin: 'https://app.test', deps }),
    ])
    expect([r1.redirect, r2.redirect]).toEqual(['success', 'success'])

    await withTenant(tenantB.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1) // exactly one
      const canceled = await db.subscription.findMany({ where: { status: 'canceled' } })
      expect(canceled.length).toBe(1) // the loser
      // Both invoices are paid (each was pending->paid independently).
      const paid = await db.invoice.findMany({ where: { status: 'paid' } })
      expect(paid.length).toBe(2)
      // Tenant.plan matches the final active sub's plan.
      const tenant = await db.tenant.findUnique({ where: { id: tenantB.id }, select: { plan: true } })
      const activePlanSlug = active[0].planId === planMaxRow!.id ? TEST_PAID_PLAN_2.slug : TEST_PAID_PLAN.slug
      expect(tenant!.plan).toBe(activePlanSlug)
    })
  })
})

describe('§ Free-plan transition (internal, no provider)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('transitionToFreePlan cancels active + creates active free sub + updates Tenant.plan; no provider call', async () => {
    // Seed a paid active subscription for tenantA (simulate already-pro).
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const now = new Date()
    await globalDb.subscription.create({
      data: { tenantId: tenantA.id, planId: planProRow!.id, status: 'active', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) },
    })
    await globalDb.tenant.update({ where: { id: tenantA.id }, data: { plan: TEST_PAID_PLAN.slug } })

    const deps = makeDeps(mock)
    const { subscriptionId } = await transitionToFreePlan({ tenantId: tenantA.id, deps })
    expect(subscriptionId).toBeTruthy()
    // No provider call for a free transition.
    expect(mock.callCount('createPayment')).toBe(0)

    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1)
      expect(active[0].id).toBe(subscriptionId)
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe('free')
    })
  })
})

describe('§ Invoice/Subscription/Plan consistency', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('after success: Tenant.plan matches the final active Subscription, and Invoice paid corresponds to the active sub', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({
      tenantId: tenantA.id,
      planSlug: TEST_PAID_PLAN.slug,
      gatewayName: 'mock',
      origin: 'https://app.test',
      deps,
    })
    await handleCallback({
      gatewayName: 'mock',
      invoiceId: checkout.invoiceId!,
      query: new URLSearchParams(`Authority=${checkout.authority}`),
      origin: 'https://app.test',
      deps,
    })

    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findFirst({ where: { status: 'active' }, include: { plan: { select: { slug: true } } } })
      expect(active).not.toBeNull()
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
      expect(inv!.subscriptionId).toBe(active!.id) // invoice points at the active sub
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(active!.plan!.slug) // Tenant.plan == active sub's plan
    })
  })
})
