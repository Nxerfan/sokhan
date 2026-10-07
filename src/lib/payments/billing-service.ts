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
 * Start a paid checkout. PR #4 correction pass:
 *
 *   - Only `planSlug === 'free'` may use transitionToFreePlan (handled by the
 *     route). A non-free plan with priceToman <= 0 (e.g. Coming-Soon pro/max)
 *     is REJECTED here with `plan_unavailable` — it must NOT silently activate
 *     the free plan and must NOT call a provider.
 *   - Duplicate-pending checkout is REJECTED with `checkout_already_pending`.
 *     A still-usable recent pending checkout is NEVER auto-canceled. Two
 *     concurrent createCheckout calls for the same tenant cannot both create a
 *     pending row — the checkout-creation phase is transactional:
 *
 *       1. db.$transaction: SELECT...FOR UPDATE the Tenant row.
 *       2. inspect the most-recent pending checkout (any gateway/plan).
 *       3. if a recent (< validity) pending exists -> throw
 *          `checkout_already_pending` (transaction rolls back, lock releases).
 *       4. otherwise create pending Subscription + pending Invoice
 *          (authority=null, callbackUrl=REAL url with invoice.id). Commit.
 *       5. ONLY AFTER the transaction commits (lock released) call
 *          provider.createPayment(callbackUrl). External HTTP never occurs
 *          under the DB lock.
 *       6. persist the returned authority.
 *       7. on createPayment failure -> compensating conditional
 *          pending->canceled on both rows.
 *
 * The existing ACTIVE subscription is preserved until payment verifies.
 */
export async function createCheckout(args: {
  tenantId: string
  planSlug: string
  gatewayName: string
  origin: string
  deps: BillingDeps
}): Promise<CheckoutResult> {
  const { tenantId, planSlug, gatewayName, origin, deps } = args

  if (typeof planSlug !== 'string' || planSlug.trim() === '') {
    throw new BillingError('planSlug is required', 'invalid_plan')
  }
  if (typeof gatewayName !== 'string' || gatewayName.trim() === '') {
    throw new BillingError('gateway is required', 'invalid_gateway')
  }
  const plan = deps.getPlan(planSlug)
  if (!plan) throw new BillingError('unknown plan slug', 'invalid_plan')
  if (plan.contactSales) throw new BillingError('plan requires sales contact', 'contact_sales')

  // Zero/negative-amount safety. The route routes `planSlug === 'free'` to
  // transitionToFreePlan, so a non-free plan reaching here with priceToman
  // <= 0 is a Coming-Soon / misconfigured plan — REJECT, do NOT activate free
  // and do NOT call a provider.
  if (plan.priceToman < 0) {
    throw new BillingError('plan has negative price (configuration error)', 'invalid_plan')
  }
  if (plan.priceToman === 0) {
    throw new BillingError('plan is not available for purchase (Coming Soon)', 'plan_unavailable')
  }

  const provider = deps.resolveProvider(gatewayName)
  if (!provider) throw new BillingError('unknown/disabled gateway', 'invalid_gateway')

  const ctxTid = getCurrentTenantId()
  if (ctxTid !== undefined && ctxTid !== tenantId) {
    throw new BillingError('tenant context mismatch', 'tenant_context_required')
  }

  // ── TRANSACTIONAL CHECKOUT-CREATION PHASE (holds the per-tenant lock) ──
  const created = await withTenant(tenantId, async () => {
    const now = deps.now()
    return db.$transaction(async (tx: any) => {
      // 1. Per-tenant pessimistic lock — serializes concurrent checkouts.
      await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`

      // 2. Inspect the most-recent pending checkout (any gateway/plan). A
      //    still-usable recent pending means the user already has a checkout
      //    in flight — reject, do NOT auto-cancel it, do NOT create another.
      const existingPending = await tx.subscription.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      })
      if (existingPending) {
        const ageMs = now.getTime() - existingPending.createdAt.getTime()
        if (ageMs < deps.checkoutValidityMs) {
          throw new BillingError(
            'a pending checkout already exists for this tenant',
            'checkout_already_pending',
          )
        }
      }

      // 3. planRow from DB (for planId FK).
      const planRow = await tx.plan.findUnique({ where: { slug: planSlug } })
      if (!planRow) throw new BillingError('plan row not found', 'plan_not_found')

      // 4. pending Subscription.
      const subscription = await tx.subscription.create({
        data: {
          tenantId,
          planId: planRow.id,
          status: 'pending',
          gateway: gatewayName,
          currentPeriodStart: now,
          currentPeriodEnd: monthlyPeriodEnd(now),
        },
      })

      // 5. pending Invoice with authority=null + REAL callbackUrl (invoice.id).
      const invoice = await tx.invoice.create({
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
      const realUrl = `${origin}/api/billing/callback/${gatewayName}?invoiceId=${invoice.id}`
      await tx.invoice.update({ where: { id: invoice.id }, data: { callbackUrl: realUrl } })

      return { subscriptionId: subscription.id, invoiceId: invoice.id, callbackUrl: realUrl }
    })
  })

  // ── EXTERNAL HTTP (lock released) ──────────────────────────────────────
  let created2: { authority: string; gatewayUrl: string }
  try {
    created2 = await provider.createPayment({
      amount: plan.priceToman,
      description: `${plan.name} plan — ${plan.priceToman.toLocaleString()} Toman`,
      callbackUrl: created.callbackUrl,
    })
  } catch {
    // Compensating: cancel the pending rows we just created (conditional
    // pending->canceled — legal). Never touches active.
    await withTenant(tenantId, () => cancelPendingSubscriptionAndInvoice(created.subscriptionId, deps.now()))
    console.warn(`[billing/checkout] createPayment failed (invoice ${created.invoiceId}) code=create_payment_failed`)
    throw new BillingError('payment creation failed', 'create_payment_failed')
  }

  // 6. persist authority.
  await withTenant(tenantId, () =>
    db.invoice.update({ where: { id: created.invoiceId }, data: { authority: created2.authority } }),
  )

  return {
    free: false,
    subscriptionId: created.subscriptionId,
    invoiceId: created.invoiceId,
    gateway: gatewayName,
    authority: created2.authority,
    gatewayUrl: created2.gatewayUrl,
    testMode: provider.testMode,
  }
}

/** Cancel a pending subscription + its pending invoice (compensating). Never touches active. */
async function cancelPendingSubscriptionAndInvoice(
  subscriptionId: string,
  now: Date,
): Promise<void> {
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
 * Read the FINAL persisted Invoice status and map it to a redirect result.
 * Used on EVERY conditional-transition-loss path (cancel, expiry,
 * verify-failure, verify-exception, success CAS) — NEVER infer the winner.
 * The HTTP redirect reflects the actual committed DB state.
 */
async function resolvePersistedInvoiceResult(
  invoiceId: string,
): Promise<CallbackResult> {
  const inv = await globalDb.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true },
  })
  if (!inv) return { redirect: 'error', code: 'invoice_not_found' }
  const status = inv.status as InvoiceStatus
  switch (status) {
    case 'paid':
      return { redirect: 'success' }
    case 'canceled':
      return { redirect: 'canceled' }
    case 'failed':
      return { redirect: 'error', code: 'invoice_failed' }
    case 'expired':
      return { redirect: 'expired' }
    case 'pending':
      return { redirect: 'error', code: 'race_pending' }
    default:
      return { redirect: 'error', code: 'unknown_invoice_status' }
  }
}

/**
 * Handle a payment gateway callback. Unauthenticated. The tenant is resolved
 * from the STORED invoice, never from the request.
 *
 * PR #4 corrections:
 *   - On EVERY conditional-transition loss (CAS count===0), the redirect is
 *     resolved from the FINAL persisted Invoice status via
 *     resolvePersistedInvoiceResult — never inferred.
 *   - Before provider.verifyPayment, the stored Subscription is loaded inside
 *     withTenant(invoice.tenantId) and its tenant/plan/gateway/status are
 *     verified against the Invoice. Any failure -> `inconsistent_state`,
 *     NO provider call, NO mutation.
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

  if (invoice.gateway !== gatewayName) {
    return { redirect: 'error', code: 'gateway_mismatch' }
  }

  if (invoice.status === 'paid') {
    return { redirect: 'success' }
  }
  if (invoice.status === 'canceled') {
    return { redirect: 'canceled' }
  }
  if (invoice.status === 'failed') {
    return { redirect: 'error', code: 'invoice_failed' }
  }
  if (invoice.status === 'expired') {
    return { redirect: 'expired' }
  }
  if (invoice.status !== 'pending') {
    return { redirect: 'error', code: 'unknown_invoice_status' }
  }

  const now = deps.now()

  const ageMs = now.getTime() - invoice.createdAt.getTime()
  if (ageMs > deps.checkoutValidityMs) {
    return withTenant(invoice.tenantId, async () => {
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'expired' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
        return { redirect: 'expired' as CallbackRedirect }
      }
      // Lost the CAS race — resolve from the final persisted state.
      return resolvePersistedInvoiceResult(invoice.id)
    })
  }

  const provider = deps.resolveProvider(invoice.gateway)
  if (!provider) {
    return { redirect: 'error', code: 'unknown_provider' }
  }

  const callback = provider.parseCallback(query)

  if (callback.kind === 'invalid') {
    return { redirect: 'error', code: callback.reasonCode ?? 'invalid_callback' }
  }

  // ── CANCEL path ───────────────────────────────────────────────────────
  if (callback.kind === 'canceled') {
    return withTenant(invoice.tenantId, async () => {
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'canceled' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
        return { redirect: 'canceled' as CallbackRedirect }
      }
      // Lost the CAS race — resolve from the final persisted state.
      return resolvePersistedInvoiceResult(invoice.id)
    })
  }

  // ── SUCCESS_CANDIDATE path ────────────────────────────────────────────
  const storedAuthority = invoice.authority ?? ''
  if (!storedAuthority) {
    return { redirect: 'error', code: 'missing_authority' }
  }
  if (callback.authority && callback.authority !== storedAuthority) {
    return { redirect: 'error', code: 'authority_mismatch' }
  }

  // ── PR #4 §4: CONSISTENCY CHECK BEFORE provider.verifyPayment ──────────
  // Load the stored Subscription inside the Invoice's tenant context. Require
  // every invariant. Any failure -> inconsistent_state, NO provider call, NO
  // mutation.
  const consistency = await withTenant(invoice.tenantId, async () => {
    const sub = await db.subscription.findUnique({
      where: { id: invoice.subscriptionId },
      select: { id: true, tenantId: true, planId: true, gateway: true, status: true },
    })
    if (!sub) return { ok: false as const, code: 'inconsistent_state' }
    if (sub.tenantId !== invoice.tenantId) return { ok: false as const, code: 'inconsistent_state' }
    if (sub.planId !== invoice.planId) return { ok: false as const, code: 'inconsistent_state' }
    if (sub.gateway !== invoice.gateway) return { ok: false as const, code: 'inconsistent_state' }
    if (sub.status !== 'pending') return { ok: false as const, code: 'inconsistent_state' }
    const planRow = await db.plan.findUnique({ where: { id: invoice.planId }, select: { id: true } })
    if (!planRow) return { ok: false as const, code: 'inconsistent_state' }
    return { ok: true as const }
  })
  if (!consistency.ok) {
    return { redirect: 'error', code: consistency.code }
  }

  // Verify with the STORED authority. Amount is the persisted invoice amount.
  let verify
  try {
    verify = await provider.verifyPayment({
      authority: storedAuthority,
      amount: invoice.amountToman,
    })
  } catch {
    return withTenant(invoice.tenantId, async () => {
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'failed' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
        return { redirect: 'error' as CallbackRedirect, code: 'verify_error' }
      }
      return resolvePersistedInvoiceResult(invoice.id)
    })
  }

  if (!verify.success) {
    return withTenant(invoice.tenantId, async () => {
      const upd = await db.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'failed' as InvoiceStatus },
      })
      if (upd.count > 0) {
        await db.subscription.updateMany({
          where: { id: invoice.subscriptionId, status: 'pending' },
          data: { status: 'canceled' as SubscriptionStatus, canceledAt: now },
        })
        return { redirect: 'error' as CallbackRedirect, code: 'verify_failed' }
      }
      return resolvePersistedInvoiceResult(invoice.id)
    })
  }

  // ── ATOMIC SUCCESS TRANSACTION ──────────────────────────────────────────
  return withTenant(invoice.tenantId, async () => {
    try {
      await db.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${invoice.tenantId} FOR UPDATE`
        const periodStart = now
        const periodEnd = monthlyPeriodEnd(now)

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

        await tx.subscription.updateMany({
          where: {
            tenantId: invoice.tenantId,
            status: 'active',
            id: { not: invoice.subscriptionId },
          },
          data: { status: 'canceled', canceledAt: now },
        })

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
        // Lost the success CAS — resolve from the FINAL persisted state
        // (never assume success).
        return resolvePersistedInvoiceResult(invoice.id)
      }
      if (msg === '__subscription_not_pending__') {
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
