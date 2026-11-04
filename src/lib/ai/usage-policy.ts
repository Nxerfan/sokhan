/**
 * AI-Q2 — Pure usage-window + remaining-capacity policy.
 *
 * Pure TS — no Prisma, no Next.js. Safe for Unit testing.
 *
 * ## Billing period resolution
 *
 * `resolveAiUsageWindow` determines the authoritative [start, end) window for
 * AI usage accounting:
 * - An ACTIVE subscription with valid, currently-effective
 *   `currentPeriodStart` / `currentPeriodEnd` uses those exact boundaries.
 * - Pending, canceled, failed, expired, not-yet-started, or malformed
 *   subscriptions fail closed → fall back to a UTC calendar month.
 * - No subscription at all → UTC calendar month.
 *
 * ## Remaining capacity
 *
 * `getAiRemaining` accounts for BOTH committed (`used`) and reserved
 * (`reserved`) replies. Limit `-1` returns null (unlimited). Limit 0 denies.
 * Invalid counters fail closed (0, never negative).
 */

export type AiUsageWindow = {
  start: Date
  end: Date
  source: 'subscription' | 'calendar'
}

/**
 * Resolve the authoritative AI usage window for a tenant at a given time.
 *
 * @param now The current time.
 * @param subscription The tenant's subscription (optional). Only an ACTIVE
 *   status with valid, currently-effective period dates is honored.
 * @returns The window `{start, end, source}` or null if the subscription is
 *   active but expired / not-yet-started / malformed (fail closed — no
 *   fallback to calendar, because an active subscription that is outside its
 *   period is a billing integrity issue that should block AI, not silently
 *   reset).
 */
export function resolveAiUsageWindow(
  now: Date,
  subscription?: {
    status: string
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
  } | null,
): AiUsageWindow | null {
  // --- Active subscription path ---
  if (subscription && subscription.status === 'active') {
    const start = subscription.currentPeriodStart
    const end = subscription.currentPeriodEnd

    // Missing dates → fail closed (active but no period is a data issue).
    if (!start || !end) return null
    // Invalid dates → fail closed.
    if (!isValidDate(start) || !isValidDate(end)) return null
    // Reversed dates → fail closed.
    if (start.getTime() >= end.getTime()) return null
    // Not-yet-started → fail closed.
    if (now.getTime() < start.getTime()) return null
    // Expired → fail closed (do NOT silently reset to calendar).
    if (now.getTime() >= end.getTime()) return null

    // Valid, currently-effective subscription period.
    return { start: new Date(start), end: new Date(end), source: 'subscription' }
  }

  // --- Non-active subscription (pending/canceled/failed) or no subscription ---
  // Fall back to UTC calendar month.
  return calendarMonthWindow(now)
}

/**
 * Compute the UTC calendar month window containing `now`.
 * [first day of month 00:00:00.000Z, first day of next month 00:00:00.000Z).
 */
function calendarMonthWindow(now: Date): AiUsageWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end, source: 'calendar' }
}

/**
 * Compute remaining AI capacity given used, reserved, and limit.
 *
 * @param used Committed (persisted) successful AI replies in the period.
 * @param reserved Outstanding reservations (not yet committed or released).
 * @param limit The plan's AI reply limit. `-1` = unlimited. `0` = disabled.
 * @returns The remaining capacity (a non-negative integer), or `null` for
 *   unlimited. Invalid counters fail closed (return 0, never negative).
 */
export function getAiRemaining(
  used: number,
  reserved: number,
  limit: number,
): number | null {
  // Unlimited.
  if (limit === -1) return null

  // Invalid limit (not a finite non-negative integer) → fail closed.
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) return 0

  // Invalid counters → fail closed (0, never extra capacity).
  if (!isValidCounter(used) || !isValidCounter(reserved)) return 0

  // Remaining = limit - used - reserved, clamped to 0 (never negative).
  const remaining = limit - used - reserved
  return Math.max(0, remaining)
}

/** Check if a value is a valid non-negative integer counter. */
function isValidCounter(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v) && v >= 0
}

/** Check if a Date is valid (not NaN). */
function isValidDate(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime())
}
