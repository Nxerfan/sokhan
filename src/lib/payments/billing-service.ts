/**
 * Billing service — the provider-agnostic payment state-machine core.
 *
 * PR: billing-state-machine-hardening
 *
 * This module is the SINGLE place that orchestrates Invoice + Subscription +
 * Tenant.plan mutations. Route handlers are thin HTTP adapters over it.
 *
 * DESIGN CONTRACT (see PR brief sections 3-22):
 *
 *   - Provider-agnostic: the core consumes a normalized PaymentProvider
 *     (createPayment / verifyPayment / parseCallback). It NEVER branches on
 *     ZarinPal/IDPay/ZarinLink-specific status strings.
 *
 *   - Preserve current entitlement: starting a paid checkout creates a NEW
 *     pending Subscription + pending Invoice WITHOUT touching the existing
 *     active subscription. The active subscription is only canceled AFTER
 *     payment verification, inside the atomic success transaction.
 *
 *   - Checkout ordering: pending Subscription + pending Invoice (with the
 *     REAL invoice.id in the callback URL) are created BEFORE
 *     provider.createPayment(). No PLACEHOLDER callback URLs. The authority
 *     returned by createPayment is persisted afterward.
 *
 *   - Zero-amount safety: provider.createPayment is NEVER called for
 *     amount <= 0. Free / zero-price plans go through transitionToFreePlan
 *     (internal, no provider). Negative prices are rejected as config errors.
 *
 *   - Callback integrity: the callback is unauthenticated. It uses a NARROW
 *     globalDb invoice lookup (id/tenantId/gateway/status/authority/amount/
 *     subscriptionId/planId/createdAt only), then runs ALL tenant-scoped
 *     billing ops inside withTenant(invoice.tenantId). The tenant is NEVER
 *     taken from the callback request. The stored gateway must match the
 *     path gateway (gateway_mismatch). The stored authority is the source of
 *     truth (authority_mismatch if the callback-supplied authority differs
 *     where the protocol supports it).
 *
 *   - Idempotency: paid is terminal. A duplicate success callback is a no-op
 *     returning the same logical success. A late cancel/failure callback
 *     after paid is a no-op (paid cannot regress).
 *
 *   - Race safety: every terminal transition uses a conditional
 *     updateMany({ where: { id, status: 'pending' }, data: {...} }). The DB
 *     participates in the race — count===0 means another callback won.
 *
 *   - Atomicity: the success path performs Invoice→paid, new
 *     Subscription→active, prior active Subscription→canceled, and
 *     Tenant.plan update in ONE db.$transaction. Either all commit or none.
 *
 *   - Expiry: a pending checkout older than `checkoutValidityMs` (default 30
 *     min) is expired on callback. Derived from Invoice.createdAt — no
 *     schema change.
 *
 *   - Mock provider: reachable ONLY via BillingDeps injection in tests/CI.
 *     The production route /api/billing/callback/mock is rejected as
 *     'invalid_gateway' (the production gateway set excludes 'mock').
 */

import { db, globalDb, withTenant, getCurrentTenantId } from '@/lib/db'
import { getPlan as catalogGetPlan } from './plans'
import type { Plan } from './plans'
import type { PaymentProvider, ProviderName } from './types'
import { getGateway, isValidGateway } from './index'
import {
  assertInvoiceTransition,
  assertSubscriptionTransition,
  canTransitionInvoice,
  isInvoiceTerminal,
  type InvoiceStatus,
  type SubscriptionStatus,
} from './billing-state'

/** Default pending-checkout validity window: 30 minutes. */
export const DEFAULT_CHECKOUT_VALIDITY_MS = 30 * 60 * 1000

/** Bounded billing error. Stable `code` — never leaks provider secrets/bodies. */
export class BillingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

/** Dependencies for the billing service. Production + test differ only here. */
export interface BillingDeps {
  /** Resolve a provider by name. Returns null for unknown/disabled. */
  resolveProvider(name: string): PaymentProvider | null
  /** Look up a plan by slug. */
  getPlan(slug: string): Plan | null
  /** Injectable clock for expiry tests. */
  now(): Date
  /** Pending-checkout validity window in ms. */
  checkoutValidityMs: number
}

/** Production deps: real catalog + real adapter set (no mock). */
export function createProductionBillingDeps(): BillingDeps {
  return {
    resolveProvider(name: string): PaymentProvider | null {
      // Production never exposes the mock provider.
      if (name === 'mock') return null
      if (!isValidGateway(name as any)) return null
      try {
        return getGateway(name as any) as PaymentProvider
      } catch {
        return null
      }
    },
    getPlan(slug: string): Plan | null {
      return catalogGetPlan(slug)
    },
    now: () => new Date(),
    checkoutValidityMs: DEFAULT_CHECKOUT_VALIDITY_MS,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public result types
// ─────────────────────────────────────────────────────────────────────────

export interface CheckoutResult {
  free: boolean
  subscriptionId: string
  invoiceId?: string
  gateway?: string
  authority?: string
  gatewayUrl?: string | null
  testMode?: boolean
}

export type CallbackRedirect = 'success' | 'canceled' | 'error' | 'expired'

export interface CallbackResult {
  redirect: CallbackRedirect
  /** Bounded machine-readable code (never raw provider body/secret). */
  code?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function monthlyPeriodEnd(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, from.getDate())
}

/** Is this plan a paid plan (priceToman > 0, not contact-sales)? */
function isPaidPlanRow(plan: Plan): boolean {
  return !plan.contactSales && plan.priceToman > 0
}

// ─────────────────────────────────────────────────────────────────────────
// 1. createCheckout — paid plan only. Free uses transitionToFreePlan.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Start a paid checkout.
 *
 * MUST run inside the caller's tenant context (withSessionTenant). The caller
 * MUST have already verified admin authorization.
 *
 * Steps:
 *   1. validate planSlug (string, supported, paid) + gateway (string, enabled).
 *   2. negative/zero price → reject (zero-amount never calls provider).
 *   3. duplicate-pending strategy: if a recent (< validity) pending checkout
 *      for the SAME plan exists, reuse it. If a pending checkout for a
 *      DIFFERENT plan exists, cancel it first. NEVER touch active.
 *   4. create pending Subscription.
 *   5. create pending Invoice with authority=null + REAL callbackUrl
 *      (invoice.id in the query).
 *   6. call provider.createPayment().
 *   7. persist authority on the invoice.
 *   8. on createPayment failure → compensating transition: invoice
 *      pending→canceled, subscription pending→canceled (legal). Return error.
 */
export async function createCheckout(args: {
  tenantId: string
  planSlug: string
  gatewayName: string
  origin: string
  deps: BillingDeps
}): Promise<CheckoutResult> {
  const { tenantId, planSlug, gatewayName, origin, deps } = args

  // Input validation — reject non-string / malformed (no String() coercion).
  if (typeof planSlug !== 'string' || planSlug.trim() === '') {
    throw new BillingError('planSlug is required', 'invalid_plan')
  }
  if (typeof gatewayName !== 'string' || gatewayName.trim() === '') {
    throw new BillingError('gateway is required', 'invalid_gateway')
  }
  const plan = deps.getPlan(planSlug)
  if (!plan) throw new BillingError('unknown plan slug', 'invalid_plan')
  if (plan.contactSales) throw new BillingError('plan requires sales contact', 'contact_sales')

  // Zero/negative-amount safety.
  if (plan.priceToman < 0) {
    throw new BillingError('plan has negative price (configuration error)', 'invalid_plan')
  }
  if (!isPaidPlanRow(plan)) {
    // Free / zero-price plan must use transitionToFreePlan, not the gateway.
    throw new BillingError(
      'createCheckout is for paid plans only; use transitionToFreePlan for free/zero-price',
      'invalid_plan',
    )
  }

  const provider = deps.resolveProvider(gatewayName)
  if (!provider) throw new BillingError('unknown/disabled gateway', 'invalid_gateway')

  // The caller MUST be inside withTenant(tenantId). Assert.
  const ctxTid = getCurrentTenantId()
  if (ctxTid !== tenantId) {
    throw new BillingError('tenant context mismatch', 'tenant_context_required')
  }

  return withTenant(tenantId, async () => {
    const now = deps.now()

    // Duplicate-pending strategy: reuse a recent same-plan pending checkout,
    // cancel a superseded different-plan pending checkout. NEVER touch active.
    const existingPending = await db.subscription.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { slug: true, id: true } } },
    })
    if (existingPending) {
      const ageMs = now.getTime() - existingPending.createdAt.getTime()
      const samePlan = existingPending.plan?.slug === planSlug
      if (samePlan && ageMs < deps.checkoutValidityMs) {
        // Reuse: return the existing pending checkout's invoice.
        const inv = await db.invoice.findFirst({
          where: { subscriptionId: existingPending.id },
          orderBy: { createdAt: 'desc' },
        })
        if (inv && inv.authority) {
          return {
            free: false,
            subscriptionId: existingPending.id,
            invoiceId: inv.id,
            gateway: gatewayName,
            authority: inv.authority,
            gatewayUrl: provider.testMode
              ? `${origin}/api/billing/callback/${gatewayName}?invoiceId=${inv.id}&test=1`
              : undefined,
            testMode: provider.testMode,
          }
        }
        // Pending subscription with no paid invoice authority — cancel it and
        // fall through to create a fresh checkout.
        await cancelPendingSubscriptionAndInvoice(existingPending.id, now)
      } else {
        // Different plan, OR expired pending — cancel superseded pending.
        await cancelPendingSubscriptionAndInvoice(existingPending.id, now)
      }
    }

    // planRow from DB (for planId FK).
    const planRow = await db.plan.findUnique({ where: { slug: planSlug } })
    if (!planRow) throw new BillingError('plan row not found', 'plan_not_found')

    // 4. pending Subscription.
    const subscription = await db.subscription.create({
      data: {
        tenantId,
        planId: planRow.id,
        status: 'pending',
        gateway: gatewayName,
        currentPeriodStart: now,
        currentPeriodEnd: monthlyPeriodEnd(now),
      },
    })

    // 5. pending Invoice with authority=null. The callback URL carrying the
    //    REAL invoice id is built + persisted AFTER this create (we need the
    //    invoice.id first), and BEFORE provider.createPayment is invoked — so
    //    the provider NEVER receives a PLACEHOLDER callback URL.
    const invoice = await db.invoice.create({
      data: {
        tenantId,
        subscriptionId: subscription.id,
        planId: planRow.id,
        amountToman: plan.priceToman,
        gateway: gatewayName,
        authority: null,
        status: 'pending',
        callbackUrl: null,
      },
    })

    // Build the REAL callback URL with the now-known invoice id, and persist
    // it on the invoice BEFORE calling the provider.
    const realUrl = `${origin}/api/billing/callback/${gatewayName}?invoiceId=${invoice.id}`
    await db.invoice.update({ where: { id: invoice.id }, data: { callbackUrl: realUrl } })

    // 6. call provider.createPayment — amount is plan.priceToman (> 0).
    let created: { authority: string; gatewayUrl: string }
    try {
      created = await provider.createPayment({
        amount: plan.priceToman,
        description: `${plan.name} plan — ${plan.priceToman.toLocaleString()} Toman`,
        callbackUrl: realUrl,
      })
    } catch (err) {
      // 8. compensating transition: cancel the pending checkout we just made.
      // pending→canceled is legal for both invoice + subscription.
      await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'canceled' as InvoiceStatus },
      })
      await db.subscription.updateMany({
        where: { id: subscription.id, status: 'pending' },
        data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
      })
      const code = 'create_payment_failed'
      console.warn(`[billing/checkout] createPayment failed (invoice ${invoice.id}) code=${code}`)
      throw new BillingError('payment creation failed', code)
    }

    // 7. persist authority.
    await db.invoice.update({
      where: { id: invoice.id },
      data: { authority: created.authority },
    })

    return {
      free: false,
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      gateway: gatewayName,
      authority: created.authority,
      gatewayUrl: created.gatewayUrl,
      testMode: provider.testMode,
    }
  })
}

/** Cancel a pending subscription + its pending invoice (compensating). Never touches active. */
async function cancelPendingSubscriptionAndInvoice(
  subscriptionId: string,
  now: Date,
): Promise<void> {
  // Conditional update — only pending rows are affected.
  await db.subscription.updateMany({
    where: { id: subscriptionId, status: 'pending' },
    data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
  })
  await db.invoice.updateMany({
    where: { subscriptionId, status: 'pending' },
    data: { status: 'canceled' as InvoiceStatus },
  })
}

// ─────────────────────────────────────────────────────────────────────────
// 2. handleCallback — unauthenticated. globalDb narrow lookup + withTenant.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The narrow invoice fields retrieved via globalDb (no tenant context). This
 * is the ONLY globalDb billing read — it carries the minimum needed to
 * identify the invoice + its tenant. All subsequent ops run inside
 * withTenant(invoice.tenantId).
 */
interface InvoiceLookup {
  id: string
  tenantId: string
  gateway: string
  status: InvoiceStatus
  authority: string | null
  amountToman: number
  subscriptionId: string
  planId: string
  createdAt: Date
}

/**
 * Handle a payment gateway callback.
 *
 * Unauthenticated. The tenant is resolved from the STORED invoice, never from
 * the request.
 */
export async function handleCallback(args: {
  gatewayName: string
  invoiceId: string
  query: URLSearchParams
  origin: string
  deps: BillingDeps
}): Promise<CallbackResult> {
  const { gatewayName, invoiceId, query, deps } = args

  if (typeof invoiceId !== 'string' || invoiceId.trim() === '') {
    return { redirect: 'error', code: 'missing_invoice' }
  }

  // NARROW globalDb lookup — bypass the fail-closed tenant extension. This is
  // the documented bootstrap boundary: we retrieve ONLY the fields needed to
  // identify the invoice + its tenant. No mutation here.
  const invoice = (await globalDb.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      tenantId: true,
      gateway: true,
      status: true,
      authority: true,
      amountToman: true,
      subscriptionId: true,
      planId: true,
      createdAt: true,
    },
  })) as InvoiceLookup | null

  if (!invoice) {
    return { redirect: 'error', code: 'invoice_not_found' }
  }

  // Gateway bind: the stored gateway MUST equal the path gateway.
  if (invoice.gateway !== gatewayName) {
    return { redirect: 'error', code: 'gateway_mismatch' }
  }

  // Idempotency: paid is terminal-success.
  if (invoice.status === 'paid') {
    return { redirect: 'success' }
  }
  // Other terminal statuses: idempotent no-op, return the matching redirect.
  if (invoice.status === 'canceled') {
    return { redirect: 'canceled' }
  }
  if (invoice.status === 'failed') {
    return { redirect: 'error', code: 'invoice_failed' }
  }
  if (invoice.status === 'expired') {
    return { redirect: 'expired' }
  }

  // Only `pending` remains reachable here.
  if (invoice.status !== 'pending') {
    // Defensive — unknown status. Do not mutate.
    return { redirect: 'error', code: 'unknown_invoice_status' }
  }

  // Expiry check (derived from createdAt — no schema change).
  const now = deps.now()
  const ageMs = now.getTime() - invoice.createdAt.getTime()
  if (ageMs > deps.checkoutValidityMs) {
    return withTenant(invoice.tenantId, async () => {
      // Conditional transition pending→expired (race-safe).
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'expired' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
      }
      return { redirect: 'expired' as CallbackRedirect }
    })
  }

  // Resolve the provider. The stored gateway was bound above; now resolve.
  const provider = deps.resolveProvider(invoice.gateway)
  if (!provider) {
    return { redirect: 'error', code: 'unknown_provider' }
  }

  // Provider-specific callback parsing (lives in the adapter).
  const callback = provider.parseCallback(query)

  if (callback.kind === 'invalid') {
    return { redirect: 'error', code: callback.reasonCode ?? 'invalid_callback' }
  }

  // ── CANCEL path ───────────────────────────────────────────────────────
  if (callback.kind === 'canceled') {
    return withTenant(invoice.tenantId, async () => {
      // Conditional pending→canceled. If 0 rows, another callback won.
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'canceled' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
      }
      return { redirect: 'canceled' as CallbackRedirect }
    })
  }

  // ── SUCCESS_CANDIDATE path ────────────────────────────────────────────
  // Authority bind: if the callback supplies an authority AND the protocol
  // supports authority matching, it must equal the stored authority.
  const storedAuthority = invoice.authority ?? ''
  if (!storedAuthority) {
    return { redirect: 'error', code: 'missing_authority' }
  }
  if (callback.authority && callback.authority !== storedAuthority) {
    return { redirect: 'error', code: 'authority_mismatch' }
  }

  // Verify with the STORED authority (never the callback-supplied one as the
  // source of truth). Amount is the persisted invoice amount.
  let verify
  try {
    verify = await provider.verifyPayment({
      authority: storedAuthority,
      amount: invoice.amountToman,
    })
  } catch {
    return withTenant(invoice.tenantId, async () => {
      await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'failed' as InvoiceStatus },
      })
      await db.subscription.updateMany({
        where: { id: invoice.subscriptionId, status: 'pending' },
        data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
      })
      return { redirect: 'error' as CallbackRedirect, code: 'verify_error' }
    })
  }

  if (!verify.success) {
    return withTenant(invoice.tenantId, async () => {
      await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'failed' as InvoiceStatus },
      })
      await db.subscription.updateMany({
        where: { id: invoice.subscriptionId, status: 'pending' },
        data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
      })
      return { redirect: 'error' as CallbackRedirect, code: 'verify_failed' }
    })
  }

  // ── ATOMIC SUCCESS TRANSACTION ──────────────────────────────────────────
  // All of: invoice→paid, new subscription→active, prior active→canceled,
  // tenant.plan→new plan — in ONE transaction. Either all commit or none.
  //
  // The transaction takes a per-tenant pessimistic lock (SELECT ... FOR
  // UPDATE on the Tenant row) at the start. This SERIALIZES concurrent
  // success callbacks for the same tenant, guaranteeing that two competing
  // successful checkouts cannot both leave an active subscription. (Without
  // this lock, two concurrent success transactions could each activate their
  // own subscription before either sees the other's commit, leaving two
  // active rows.) This is a query-level lock — NO schema migration.
  return withTenant(invoice.tenantId, async () => {
    try {
      await db.$transaction(async (tx: any) => {
        // 0. Per-tenant pessimistic lock — blocks competing success
        //    transactions for the same tenant until this one commits.
        await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${invoice.tenantId} FOR UPDATE`

        const periodStart = now
        const periodEnd = monthlyPeriodEnd(now)

        // 1. Conditional invoice pending→paid (race-safe). If 0 rows,
        //    another callback already won — throw to rollback.
        const invUpd = await tx.invoice.updateMany({
          where: { id: invoice.id, status: 'pending' },
          data: {
            status: 'paid',
            refId: verify.refId ?? null,
            paidAt: now,
          },
        })
        if (invUpd.count === 0) {
          throw new Error('__invoice_not_pending__')
        }

        // 2. Activate the new subscription (pending→active).
        const subUpd = await tx.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: {
            status: 'active',
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        })
        if (subUpd.count === 0) {
          throw new Error('__subscription_not_pending__')
        }

        // 3. Cancel prior active subscriptions for the same tenant, EXCLUDING
        //    the newly-activated one.
        await tx.subscription.updateMany({
          where: {
            tenantId: invoice.tenantId,
            status: 'active',
            id: { not: invoice.subscriptionId },
          },
          data: { status: 'canceled', canceledAt: now },
        })

        // 4. Look up the plan slug from the stored plan row (authoritative).
        const planRow = await tx.plan.findUnique({
          where: { id: invoice.planId },
          select: { slug: true },
        })
        if (!planRow) {
          throw new Error('__plan_not_found__')
        }
        await tx.tenant.update({
          where: { id: invoice.tenantId },
          data: { plan: planRow.slug },
        })
      })
      return { redirect: 'success' as CallbackRedirect }
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg === '__invoice_not_pending__') {
        // Another success callback won the race — the invoice is no longer
        // pending. Idempotent: return success (it's paid).
        return { redirect: 'success' as CallbackRedirect }
      }
      if (msg === '__subscription_not_pending__') {
        // Inconsistent state — the invoice transitioned but the subscription
        // didn't. Roll back the invoice too (the transaction did). Surface a
        // bounded error.
        console.error(
          `[billing/callback] inconsistent state invoice ${invoice.id}: subscription not pending`,
        )
        return { redirect: 'error' as CallbackRedirect, code: 'inconsistent_state' }
      }
      if (msg === '__plan_not_found__') {
        return { redirect: 'error' as CallbackRedirect, code: 'plan_not_found' }
      }
      console.error(`[billing/callback] success transaction failed: ${msg}`)
      return { redirect: 'error' as CallbackRedirect, code: 'transaction_failed' }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// 3. transitionToFreePlan — internal, no provider, admin-gated by caller.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Downgrade/transition to the free plan. NO provider call (zero-amount).
 * Atomic: cancel active subscription(s) + create new active free subscription
 * + update tenant.plan.
 */
export async function transitionToFreePlan(args: {
  tenantId: string
  deps: BillingDeps
}): Promise<{ subscriptionId: string }> {
  const { tenantId, deps } = args
  const freePlan = deps.getPlan('free')
  if (!freePlan) throw new BillingError('free plan not found', 'invalid_plan')
  if (freePlan.priceToman !== 0) {
    throw new BillingError('free plan has non-zero price (configuration error)', 'invalid_plan')
  }

  return withTenant(tenantId, async () => {
    const now = deps.now()
    const planRow = await db.plan.findUnique({ where: { slug: 'free' } })
    if (!planRow) throw new BillingError('free plan row not found', 'plan_not_found')

    return db.$transaction(async (tx: any) => {
      // Per-tenant pessimistic lock — serialize against concurrent checkouts.
      await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`
      // Cancel all currently-active subscriptions (atomic with the new free sub).
      await tx.subscription.updateMany({
        where: { tenantId, status: 'active' },
        data: { status: 'canceled', canceledAt: now },
      })
      // Create the new active free subscription.
      const sub = await tx.subscription.create({
        data: {
          tenantId,
          planId: planRow.id,
          status: 'active',
          gateway: null,
          currentPeriodStart: now,
          currentPeriodEnd: monthlyPeriodEnd(now),
        },
      })
      await tx.tenant.update({ where: { id: tenantId }, data: { plan: 'free' } })
      return { subscriptionId: sub.id }
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────
// 4. getBillingState — for the billing status API + UI.
// ─────────────────────────────────────────────────────────────────────────

export interface BillingState {
  planSlug: string
  activeSubscription: {
    id: string
    status: SubscriptionStatus
    gateway: string | null
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
  } | null
  pendingSubscription: {
    id: string
    status: SubscriptionStatus
    gateway: string | null
    currentPeriodEnd: Date | null
    createdAt: Date
  } | null
  invoices: Array<{
    id: string
    amountToman: number
    gateway: string
    status: InvoiceStatus
    refId: string | null
    createdAt: Date
    paidAt: Date | null
  }>
}

/**
 * Read the current billing state. The ACTIVE subscription is the effective
 * entitlement. A PENDING subscription (if any) is a checkout in flight and
 * does NOT affect current entitlement until its payment succeeds.
 */
export async function getBillingState(args: {
  tenantId: string
  deps: BillingDeps
}): Promise<BillingState> {
  const { tenantId, deps } = args
  return withTenant(tenantId, async () => {
    const [activeSubscription, pendingSubscription, invoices, tenant] = await Promise.all([
      db.subscription.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { slug: true } } },
      }),
      db.subscription.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
      }),
      db.invoice.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    ])

    return {
      planSlug: activeSubscription?.plan?.slug ?? tenant?.plan ?? 'free',
      activeSubscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status as SubscriptionStatus,
            gateway: activeSubscription.gateway,
            currentPeriodStart: activeSubscription.currentPeriodStart,
            currentPeriodEnd: activeSubscription.currentPeriodEnd,
          }
        : null,
      pendingSubscription: pendingSubscription
        ? {
            id: pendingSubscription.id,
            status: pendingSubscription.status as SubscriptionStatus,
            gateway: pendingSubscription.gateway,
            currentPeriodEnd: pendingSubscription.currentPeriodEnd,
            createdAt: pendingSubscription.createdAt,
          }
        : null,
      invoices: invoices.map((i) => ({
        id: i.id,
        amountToman: i.amountToman,
        gateway: i.gateway,
        status: i.status as InvoiceStatus,
        refId: i.refId,
        createdAt: i.createdAt,
        paidAt: i.paidAt,
      })),
    }
  })
}

// Re-exports for route convenience.
export { isPaidPlanRow, canTransitionInvoice, isInvoiceTerminal }
// Assertion helpers are re-exported so route handlers / tests can validate
// transitions without importing billing-state directly.
export { assertInvoiceTransition, assertSubscriptionTransition }
