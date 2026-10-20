/**
 * Billing state machine — the single source of truth for Invoice + Subscription
 * lifecycle transitions.
 *
 * PR: billing-state-machine-hardening
 *
 * DESIGN CONTRACT:
 *   - No DB access. No IO. No async. Pure functions only.
 *   - The route handlers + billing-service MUST call these validators before
 *     persisting any status change. They must NOT scatter arbitrary status
 *     strings or mutate historical rows back and forth.
 *   - `paid` is TERMINAL-success. Once an Invoice is paid, it can never
 *     regress to failed/canceled/expired. A late failure/cancel callback
 *     arriving after `paid` is a no-op (idempotent).
 *   - A Subscription is only re-activated via a NEW subscription row created
 *     by a fresh checkout. Historical `canceled`/`expired` subscriptions are
 *     never mutated back to `active`.
 *
 * Invoice lifecycle:
 *   pending -> paid        (verified payment success — terminal-success)
 *   pending -> failed      (verification failed)
 *   pending -> canceled    (user cancelled / provider cancel)
 *   pending -> expired     (callback after checkout validity window)
 *   paid -> paid           (idempotent no-op on duplicate success)
 *   paid -> failed         FORBIDDEN
 *   paid -> canceled       FORBIDDEN
 *   paid -> expired        FORBIDDEN
 *   failed -> *            FORBIDDEN (failed is terminal)
 *   canceled -> *          FORBIDDEN (canceled is terminal)
 *   expired -> *           FORBIDDEN (expired is terminal)
 *
 * Subscription lifecycle:
 *   pending -> active      (payment verified)
 *   pending -> canceled    (payment failed/cancelled/expired)
 *   pending -> expired     (checkout expired without resolution)
 *   active -> canceled     (replaced by a newer successful checkout, or admin
 *                           downgrade to free)
 *   canceled -> active     FORBIDDEN (create a NEW subscription instead)
 *   canceled -> *          FORBIDDEN (terminal)
 *   expired -> *           FORBIDDEN (terminal)
 *   active -> pending      FORBIDDEN (never re-pend an active sub)
 */

export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'expired'
export type SubscriptionStatus = 'pending' | 'active' | 'canceled' | 'expired'

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'pending',
  'paid',
  'failed',
  'canceled',
  'expired',
] as const

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'pending',
  'active',
  'canceled',
  'expired',
] as const

/** Terminal invoice statuses — no further transition is legal. */
export const INVOICE_TERMINAL: ReadonlySet<InvoiceStatus> = new Set([
  'paid',
  'failed',
  'canceled',
  'expired',
])

/** Terminal subscription statuses. */
export const SUBSCRIPTION_TERMINAL: ReadonlySet<SubscriptionStatus> = new Set([
  'canceled',
  'expired',
])

const INVOICE_TRANSITIONS: Record<InvoiceStatus, ReadonlySet<InvoiceStatus>> = {
  pending: new Set<InvoiceStatus>(['paid', 'failed', 'canceled', 'expired']),
  // paid is terminal-success. paid -> paid is allowed ONLY as an idempotent
  // no-op (a duplicate success callback). Any other transition from paid is
  // forbidden.
  paid: new Set<InvoiceStatus>(['paid']),
  failed: new Set<InvoiceStatus>([]),
  canceled: new Set<InvoiceStatus>([]),
  expired: new Set<InvoiceStatus>([]),
}

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, ReadonlySet<SubscriptionStatus>> = {
  pending: new Set<SubscriptionStatus>(['active', 'canceled', 'expired']),
  active: new Set<SubscriptionStatus>(['canceled']),
  canceled: new Set<SubscriptionStatus>([]),
  expired: new Set<SubscriptionStatus>([]),
}

export class IllegalBillingTransitionError extends Error {
  constructor(
    public readonly entity: 'invoice' | 'subscription',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`)
    this.name = 'IllegalBillingTransitionError'
  }
}

/** Whether an invoice may transition from `from` to `to`. */
export function canTransitionInvoice(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  return INVOICE_TRANSITIONS[from]?.has(to) ?? false
}

/** Whether a subscription may transition from `from` to `to`. */
export function canTransitionSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return SUBSCRIPTION_TRANSITIONS[from]?.has(to) ?? false
}

/**
 * Assert an invoice transition is legal. Throws IllegalBillingTransitionError
 * otherwise. The ONLY legal transition OUT of `paid` is `paid -> paid`
 * (idempotent duplicate-success no-op).
 */
export function assertInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
): void {
  if (!canTransitionInvoice(from, to)) {
    throw new IllegalBillingTransitionError('invoice', from, to)
  }
}

/** Assert a subscription transition is legal. */
export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  if (!canTransitionSubscription(from, to)) {
    throw new IllegalBillingTransitionError('subscription', from, to)
  }
}

/** Is this invoice status a terminal (no further legal transitions)? */
export function isInvoiceTerminal(status: InvoiceStatus): boolean {
  return INVOICE_TERMINAL.has(status)
}

/** Is this subscription status terminal? */
export function isSubscriptionTerminal(status: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TERMINAL.has(status)
}

/**
 * Whether a duplicate-success callback on an already-paid invoice should be
 * treated as an idempotent no-op. (paid -> paid is the only self-transition
 * allowed, and only for duplicate success.)
 */
export function isIdempotentPaidSuccess(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  return from === 'paid' && to === 'paid'
}

/** Guard: is the value a valid InvoiceStatus string? */
export function isValidInvoiceStatus(s: unknown): s is InvoiceStatus {
  return typeof s === 'string' && (INVOICE_STATUSES as readonly string[]).includes(s)
}

/** Guard: is the value a valid SubscriptionStatus string? */
export function isValidSubscriptionStatus(s: unknown): s is SubscriptionStatus {
  return (
    typeof s === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(s)
  )
}
