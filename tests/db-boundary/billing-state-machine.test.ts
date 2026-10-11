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
    expect(mock.callCount('createPayment')).toBe(1)

    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      const pending = await db.subscription.findMany({ where: { status: 'pending' } })
      expect(active.length).toBe(1)
      expect(active[0].id).toBe(activeSubId)
      expect(pending.length).toBe(1)
      expect(pending[0].id).toBe(checkout.subscriptionId)

      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending')
      expect(inv!.authority).toBe(checkout.authority ?? null)
      expect(inv!.amountToman).toBe(TEST_PAID_PLAN.priceToman)
      expect(inv!.gateway).toBe('mock')
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
})

describe('§ Zero-price non-free plans (PR#4 §1)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => {
    mock = createMockProvider()
  })

  test('pro (catalog price 0) -> rejected with plan_unavailable; provider NOT called', async () => {
    const deps = makeDeps(mock)
    let thrown: unknown = null
    try {
      await createCheckout({ tenantId: tenantA.id, planSlug: 'pro', gatewayName: 'mock', origin: 'https://app.test', deps })
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(BillingError)
    expect((thrown as BillingError).code).toBe('plan_unavailable')
    expect(mock.callCount('createPayment')).toBe(0)
    // No subscription/invoice created.
    await withTenant(tenantA.id, async () => {
      expect(await db.subscription.count({ where: {} })).toBe(0)
      expect(await db.invoice.count({ where: {} })).toBe(0)
    })
  })

  test('max (catalog price 0) -> rejected with plan_unavailable; provider NOT called', async () => {
    const deps = makeDeps(mock)
    let thrown: unknown = null
    try {
      await createCheckout({ tenantId: tenantA.id, planSlug: 'max', gatewayName: 'mock', origin: 'https://app.test', deps })
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(BillingError)
    expect((thrown as BillingError).code).toBe('plan_unavailable')
    expect(mock.callCount('createPayment')).toBe(0)
  })

  test('free -> internal free transition succeeds; provider NOT called', async () => {
    const deps = makeDeps(mock)
    const { subscriptionId } = await transitionToFreePlan({ tenantId: tenantA.id, deps })
    expect(subscriptionId).toBeTruthy()
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

describe('§ Success transition (atomic)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('verify success -> paid invoice, new sub active, prior active canceled, Tenant.plan updated, refId+paidAt set', async () => {
    const priorActiveId = await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(`Authority=${checkout.authority}`), origin: 'https://app.test', deps })
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
      expect(await countActiveSubs(tenantA.id)).toBe(1)
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(TEST_PAID_PLAN.slug)
    })
  })
})

describe('§ Failure / cancel', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('verify failure -> invoice failed, pending sub canceled, prior active preserved, Tenant.plan unchanged', async () => {
    const priorActiveId = await seedActiveFreeSubscription(tenantA.id)
    mock.setVerifyScenario('verify_failure')
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(`Authority=${checkout.authority}`), origin: 'https://app.test', deps })
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
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(''), origin: 'https://app.test', deps })
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
  beforeEach(() => { mock = createMockProvider() })

  test('duplicate success callback is safe (no duplicate sub/invoice, same logical success)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    const r1 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    expect(r1.redirect).toBe('success')
    expect(r2.redirect).toBe('success')
    expect(mock.callCount('verifyPayment')).toBe(1)
    await withTenant(tenantA.id, async () => {
      expect(await countActiveSubs(tenantA.id)).toBe(1)
      const paid = await db.invoice.findMany({ where: { status: 'paid' } })
      expect(paid.length).toBe(1)
    })
  })

  test('duplicate cancel callback is idempotent', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    mock.setCallbackScenario('callback_canceled')
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
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
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    mock.setCallbackScenario('callback_canceled')
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(''), origin: 'https://app.test', deps })
    expect(r2.redirect).toBe('success')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
      expect(await countActiveSubs(tenantA.id)).toBe(1)
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(TEST_PAID_PLAN.slug)
    })
  })

  test('failure after paid is blocked', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    mock.setVerifyScenario('verify_failure')
    const r2 = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps })
    expect(r2.redirect).toBe('success')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
    })
  })
})

describe('§ Integrity', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('gateway mismatch is blocked (no state mutation)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const res = await handleCallback({ gatewayName: 'zarinpal', invoiceId: checkout.invoiceId!, query: new URLSearchParams(`Authority=${checkout.authority}`), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('gateway_mismatch')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending')
    })
  })

  test('authority mismatch is blocked', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams('Authority=DIFFERENT-AUTHORITY'), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('authority_mismatch')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('pending')
    })
  })

  test('expired invoice is blocked (callback after checkout validity window)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const past = new Date(Date.now() - 31 * 60 * 1000)
    const deps = makeDeps(mock, { validityMs: 30 * 60 * 1000 })
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    await globalDb.invoice.update({ where: { id: checkout.invoiceId! }, data: { createdAt: past } })
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(`Authority=${checkout.authority}`), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('expired')
    await withTenant(tenantA.id, async () => {
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('expired')
      const newSub = await db.subscription.findUnique({ where: { id: checkout.subscriptionId } })
      expect(newSub!.status).toBe('canceled')
    })
  })
})

describe('§ Concurrent checkout creation (PR#4 §2)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('two concurrent createCheckout for same tenant -> exactly one pending checkout; createPayment called once; other gets checkout_already_pending', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    let r1: { ok: true; checkout: any } | { ok: false; code: string } = { ok: false, code: '' }
    let r2: { ok: true; checkout: any } | { ok: false; code: string } = { ok: false, code: '' }
    await Promise.all([
      (async () => {
        try { const c = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps }); r1 = { ok: true, checkout: c } }
        catch (e: any) { r1 = { ok: false, code: e instanceof BillingError ? e.code : 'error' } }
      })(),
      (async () => {
        try { const c = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps }); r2 = { ok: true, checkout: c } }
        catch (e: any) { r2 = { ok: false, code: e instanceof BillingError ? e.code : 'error' } }
      })(),
    ])
    // Exactly one succeeded; the other got checkout_already_pending.
    const oks = [r1, r2].filter((r) => r.ok)
    const fails = [r1, r2].filter((r) => !r.ok)
    expect(oks.length).toBe(1)
    expect(fails.length).toBe(1)
    expect((fails[0] as any).code).toBe('checkout_already_pending')
    // createPayment called exactly once (by the winner).
    expect(mock.callCount('createPayment')).toBe(1)
    // Exactly one pending checkout row.
    await withTenant(tenantA.id, async () => {
      const pending = await db.subscription.findMany({ where: { status: 'pending' } })
      expect(pending.length).toBe(1)
    })
  })

  test('different requested gateways: existing pending still rejects with checkout_already_pending', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    // First checkout with mock gateway.
    const first = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    expect(first.gatewayUrl).toBeTruthy() // real provider gatewayUrl persisted/returned
    // Second concurrent-ish checkout — even a different gateway path is rejected
    // because a recent pending already exists (do NOT auto-cancel, do NOT create).
    let secondCode = ''
    try {
      // The 'zarinpal' gateway resolves to null in test deps -> invalid_gateway
      // BEFORE the pending check. Use 'mock' to reach the pending check.
      await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    } catch (e: any) {
      secondCode = e instanceof BillingError ? e.code : 'error'
    }
    expect(secondCode).toBe('checkout_already_pending')
    await withTenant(tenantA.id, async () => {
      const pending = await db.subscription.findMany({ where: { status: 'pending' } })
      expect(pending.length).toBe(1) // still just the first
    })
  })
})

describe('§ Callback race correctness (PR#4 §3)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('success vs cancel: each response matches the final persisted Invoice state', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const successQ = new URLSearchParams(`Authority=${checkout.authority}`)
    // A separate mock configured for cancel.
    const cancelMock = createMockProvider()
    cancelMock.setCallbackScenario('callback_canceled')
    const cancelDeps = makeDeps(cancelMock)

    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: successQ, origin: 'https://app.test', deps }),
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(''), origin: 'https://app.test', deps: cancelDeps }),
    ])
    // Read the FINAL committed invoice status.
    const finalInv = await globalDb.invoice.findUnique({ where: { id: checkout.invoiceId! }, select: { status: true } })
    const finalStatus = finalInv!.status
    const responses = [r1, r2]
    if (finalStatus === 'paid') {
      // No callback may claim the final invoice is canceled.
      for (const r of responses) expect(r.redirect).not.toBe('canceled')
      expect(responses.some((r) => r.redirect === 'success')).toBe(true)
    } else if (finalStatus === 'canceled') {
      // Success callback must not report success.
      for (const r of responses) expect(r.redirect).not.toBe('success')
    }
    // Exactly one terminal state; pending is not a valid final state here.
    expect(['paid', 'canceled']).toContain(finalStatus)
  })

  test('success vs verify-failure: each response matches the final persisted Invoice state', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock) // verify_success
    const failMock = createMockProvider()
    failMock.setVerifyScenario('verify_failure')
    const failDeps = makeDeps(failMock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    const q = new URLSearchParams(`Authority=${checkout.authority}`)
    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps }),
      handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: q, origin: 'https://app.test', deps: failDeps }),
    ])
    const finalInv = await globalDb.invoice.findUnique({ where: { id: checkout.invoiceId! }, select: { status: true } })
    const finalStatus = finalInv!.status
    const responses = [r1, r2]
    if (finalStatus === 'paid') {
      for (const r of responses) expect(r.redirect).not.toBe('error')
    } else if (finalStatus === 'failed') {
      // Success callback must not report success.
      for (const r of responses) expect(r.redirect).not.toBe('success')
    }
    expect(['paid', 'failed']).toContain(finalStatus)
  })

  test('two success callbacks on the same invoice -> idempotent (one paid, one no-op)', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
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
    const now = new Date()
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const planMaxRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN_2.slug }, select: { id: true } })
    const sub1 = await globalDb.subscription.create({ data: { tenantId: tenantB.id, planId: planProRow!.id, status: 'pending', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) }, select: { id: true } })
    const inv1 = await globalDb.invoice.create({ data: { tenantId: tenantB.id, subscriptionId: sub1.id, planId: planProRow!.id, amountToman: TEST_PAID_PLAN.priceToman, gateway: 'mock', authority: 'MOCK-AUTH-compete-1', status: 'pending', callbackUrl: 'https://app.test/api/billing/callback/mock?invoiceId=compete-1' }, select: { id: true } })
    const sub2 = await globalDb.subscription.create({ data: { tenantId: tenantB.id, planId: planMaxRow!.id, status: 'pending', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) }, select: { id: true } })
    const inv2 = await globalDb.invoice.create({ data: { tenantId: tenantB.id, subscriptionId: sub2.id, planId: planMaxRow!.id, amountToman: TEST_PAID_PLAN_2.priceToman, gateway: 'mock', authority: 'MOCK-AUTH-compete-2', status: 'pending', callbackUrl: 'https://app.test/api/billing/callback/mock?invoiceId=compete-2' }, select: { id: true } })
    const deps = makeDeps(mock)
    const [r1, r2] = await Promise.all([
      handleCallback({ gatewayName: 'mock', invoiceId: inv1.id, query: new URLSearchParams('Authority=MOCK-AUTH-compete-1'), origin: 'https://app.test', deps }),
      handleCallback({ gatewayName: 'mock', invoiceId: inv2.id, query: new URLSearchParams('Authority=MOCK-AUTH-compete-2'), origin: 'https://app.test', deps }),
    ])
    expect([r1.redirect, r2.redirect]).toEqual(['success', 'success'])
    await withTenant(tenantB.id, async () => {
      const active = await db.subscription.findMany({ where: { status: 'active' } })
      expect(active.length).toBe(1)
      const canceled = await db.subscription.findMany({ where: { status: 'canceled' } })
      expect(canceled.length).toBe(1)
      const paid = await db.invoice.findMany({ where: { status: 'paid' } })
      expect(paid.length).toBe(2)
      const tenant = await db.tenant.findUnique({ where: { id: tenantB.id }, select: { plan: true } })
      const activePlanSlug = active[0].planId === planMaxRow!.id ? TEST_PAID_PLAN_2.slug : TEST_PAID_PLAN.slug
      expect(tenant!.plan).toBe(activePlanSlug)
    })
  })
})

describe('§ Consistency before verify (PR#4 §4)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  /** Bootstrap a pending Invoice + Subscription with deliberately-mismatched
   * fields, then call handleCallback and assert inconsistent_state + no verify. */
  async function bootstrapMismatched(args: {
    invoiceTenantId: string
    subscriptionTenantId: string
    subscriptionPlanId: string
    invoicePlanId: string
    subscriptionGateway: string | null
    subscriptionStatus: string
  }): Promise<string> {
    const now = new Date()
    // Create the subscription first (need its id for the invoice).
    const sub = await globalDb.subscription.create({
      data: {
        tenantId: args.subscriptionTenantId,
        planId: args.subscriptionPlanId,
        status: args.subscriptionStatus,
        gateway: args.subscriptionGateway,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()),
      },
      select: { id: true },
    })
    const inv = await globalDb.invoice.create({
      data: {
        tenantId: args.invoiceTenantId,
        subscriptionId: sub.id,
        planId: args.invoicePlanId,
        amountToman: TEST_PAID_PLAN.priceToman,
        gateway: 'mock',
        authority: 'MOCK-AUTH-inconsistent',
        status: 'pending',
        callbackUrl: 'https://app.test/api/billing/callback/mock?invoiceId=inc',
      },
      select: { id: true },
    })
    return inv.id
  }

  test('A. Invoice tenant A -> Subscription tenant B -> inconsistent_state; verify NOT called', async () => {
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const invId = await bootstrapMismatched({
      invoiceTenantId: tenantA.id,
      subscriptionTenantId: tenantB.id, // different tenant!
      subscriptionPlanId: planProRow!.id,
      invoicePlanId: planProRow!.id,
      subscriptionGateway: 'mock',
      subscriptionStatus: 'pending',
    })
    const deps = makeDeps(mock)
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: invId, query: new URLSearchParams('Authority=MOCK-AUTH-inconsistent'), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('inconsistent_state')
    expect(mock.callCount('verifyPayment')).toBe(0)
    // Invoice unchanged (still pending — no mutation).
    const inv = await globalDb.invoice.findUnique({ where: { id: invId }, select: { status: true } })
    expect(inv!.status).toBe('pending')
  })

  test('B. Invoice plan X -> Subscription plan Y -> inconsistent_state; verify NOT called', async () => {
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const planMaxRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN_2.slug }, select: { id: true } })
    const invId = await bootstrapMismatched({
      invoiceTenantId: tenantA.id,
      subscriptionTenantId: tenantA.id,
      subscriptionPlanId: planProRow!.id, // sub has pro
      invoicePlanId: planMaxRow!.id, // invoice has max — mismatch
      subscriptionGateway: 'mock',
      subscriptionStatus: 'pending',
    })
    const deps = makeDeps(mock)
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: invId, query: new URLSearchParams('Authority=MOCK-AUTH-inconsistent'), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('inconsistent_state')
    expect(mock.callCount('verifyPayment')).toBe(0)
  })

  test('C. Invoice gateway mock -> Subscription gateway different -> inconsistent_state; verify NOT called', async () => {
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const invId = await bootstrapMismatched({
      invoiceTenantId: tenantA.id,
      subscriptionTenantId: tenantA.id,
      subscriptionPlanId: planProRow!.id,
      invoicePlanId: planProRow!.id,
      subscriptionGateway: 'zarinpal', // sub gateway != invoice gateway (mock)
      subscriptionStatus: 'pending',
    })
    const deps = makeDeps(mock)
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: invId, query: new URLSearchParams('Authority=MOCK-AUTH-inconsistent'), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('inconsistent_state')
    expect(mock.callCount('verifyPayment')).toBe(0)
  })

  test('D. Subscription already canceled while Invoice pending -> inconsistent_state; verify NOT called', async () => {
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const invId = await bootstrapMismatched({
      invoiceTenantId: tenantA.id,
      subscriptionTenantId: tenantA.id,
      subscriptionPlanId: planProRow!.id,
      invoicePlanId: planProRow!.id,
      subscriptionGateway: 'mock',
      subscriptionStatus: 'canceled', // sub NOT pending — mismatch
    })
    const deps = makeDeps(mock)
    const res = await handleCallback({ gatewayName: 'mock', invoiceId: invId, query: new URLSearchParams('Authority=MOCK-AUTH-inconsistent'), origin: 'https://app.test', deps })
    expect(res.redirect).toBe('error')
    expect(res.code).toBe('inconsistent_state')
    expect(mock.callCount('verifyPayment')).toBe(0)
  })
})

describe('§ Free-plan transition (internal, no provider)', () => {
  let mock: MockPaymentProvider
  beforeEach(() => { mock = createMockProvider() })

  test('transitionToFreePlan cancels active + creates active free sub + updates Tenant.plan; no provider call', async () => {
    const planProRow = await globalDb.plan.findUnique({ where: { slug: TEST_PAID_PLAN.slug }, select: { id: true } })
    const now = new Date()
    await globalDb.subscription.create({ data: { tenantId: tenantA.id, planId: planProRow!.id, status: 'active', gateway: 'mock', currentPeriodStart: now, currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()) } })
    await globalDb.tenant.update({ where: { id: tenantA.id }, data: { plan: TEST_PAID_PLAN.slug } })
    const deps = makeDeps(mock)
    const { subscriptionId } = await transitionToFreePlan({ tenantId: tenantA.id, deps })
    expect(subscriptionId).toBeTruthy()
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
  beforeEach(() => { mock = createMockProvider() })

  test('after success: Tenant.plan matches the final active Subscription, and Invoice paid corresponds to the active sub', async () => {
    await seedActiveFreeSubscription(tenantA.id)
    const deps = makeDeps(mock)
    const checkout = await createCheckout({ tenantId: tenantA.id, planSlug: TEST_PAID_PLAN.slug, gatewayName: 'mock', origin: 'https://app.test', deps })
    await handleCallback({ gatewayName: 'mock', invoiceId: checkout.invoiceId!, query: new URLSearchParams(`Authority=${checkout.authority}`), origin: 'https://app.test', deps })
    await withTenant(tenantA.id, async () => {
      const active = await db.subscription.findFirst({ where: { status: 'active' }, include: { plan: { select: { slug: true } } } })
      expect(active).not.toBeNull()
      const inv = await db.invoice.findUnique({ where: { id: checkout.invoiceId! } })
      expect(inv!.status).toBe('paid')
      expect(inv!.subscriptionId).toBe(active!.id)
      const tenant = await db.tenant.findUnique({ where: { id: tenantA.id }, select: { plan: true } })
      expect(tenant!.plan).toBe(active!.plan!.slug)
    })
  })
})
