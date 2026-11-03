/**
 * AI-Q2 — Atomic successful-reply accounting service.
 *
 * Server-side only. Uses `globalDb` (raw Prisma client) directly because:
 * - The service receives an explicit `tenantId` (no ALS context needed).
 * - Atomic transactions require the raw client's `$transaction` / `$queryRaw`.
 * - The reviewer DB tests call these functions without `withTenant`.
 *
 * ## Atomicity
 *
 * Reservation: a conditional `UPDATE ... SET reserved = reserved + 1 WHERE
 * used + reserved < limit` (raw SQL) — PostgreSQL row-locks the period row,
 * serializing concurrent reservations. Only one of N concurrent requests
 * for the final slot succeeds.
 *
 * Commit: an interactive `$transaction` creates the AI Message, settles the
 * reservation to `committed`, and increments `used` / decrecrements `reserved`
 * atomically. If message persistence fails, the usage charge does not commit.
 *
 * Release: a conditional `updateMany` (only if status = 'reserved') prevents
 * refunding an already-committed reply. Idempotent — a second release is a
 * no-op.
 *
 * ## Idempotency
 *
 * Reservation: unique constraint on [tenantId, visitorMessageId] — a duplicate
 * reservation for the same visitor message returns the original (or
 * 'already_committed' if it was settled).
 *
 * Commit: if the reservation is already `committed`, return the existing AI
 * message ID — never generate a second message or charge a second unit.
 *
 * ## Historical backfill
 *
 * When a usage period is first created, `used` is seeded from a count of
 * existing AI messages (`senderType: 'ai'`, `status: 'sent'`) in the window.
 * This preserves already-consumed quota on deployment. The `backfilled` flag
 * prevents double-counting. New commits increment `used` on top of the
 * backfilled count.
 */

import { globalDb } from '@/lib/db'
import { getPlan } from '@/lib/payments/plans'
import { resolveAiUsageWindow, getAiRemaining, type AiUsageWindow } from '@/lib/ai/usage-policy'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiUsageState = {
  planSlug: string
  used: number
  reserved: number
  limit: number
  remaining: number | null
  periodStart: Date | null
  periodEnd: Date | null
}

export type ReserveResult =
  | { status: 'reserved'; reservationId: string }
  | { status: 'limit_reached' }
  | { status: 'in_progress'; reservationId: string }
  | { status: 'already_committed'; messageId: string }

export type CommitResult =
  | { status: 'committed'; messageId: string }
  | { status: 'not_found' }

// Reservation lease: a reserved slot that is never committed or released
// (e.g. crashed request) expires after this many ms, allowing stale recovery.
const RESERVATION_LEASE_MS = 5 * 60 * 1000 // 5 minutes

// ---------------------------------------------------------------------------
// Plan + window resolution
// ---------------------------------------------------------------------------

async function resolvePlanAndWindow(tenantId: string, now: Date) {
  // Query the tenant's active subscription (most recent first).
  const subscription = await globalDb.subscription.findFirst({
    where: { tenantId, status: 'active' },
    include: { plan: { select: { slug: true } } },
    orderBy: { createdAt: 'desc' },
  })

  // Resolve the plan slug: active subscription's plan > tenant.plan > 'free'.
  let planSlug: string
  if (subscription?.plan?.slug) {
    planSlug = subscription.plan.slug
  } else {
    const tenant = await globalDb.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    })
    planSlug = tenant?.plan ?? 'free'
  }

  // Validate the plan slug against the catalog. Unknown → fail closed (free).
  const plan = getPlan(planSlug)
  if (!plan) {
    planSlug = 'free'
  }
  const limit = plan ? plan.limits.aiActions : 0

  // Resolve the usage window.
  const window = resolveAiUsageWindow(now, subscription
    ? {
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      }
    : null)

  return { planSlug, limit, window }
}

// ---------------------------------------------------------------------------
// Period get-or-create with backfill
// ---------------------------------------------------------------------------

async function getOrCreatePeriod(
  tenantId: string,
  window: AiUsageWindow,
): Promise<{ id: string; used: number; reserved: number; periodStart: Date; periodEnd: Date }> {
  const whereUnique = {
    tenantId_periodStart_periodEnd: {
      tenantId,
      periodStart: window.start,
      periodEnd: window.end,
    },
  }

  // Try to find an existing period.
  let period = await globalDb.aiUsagePeriod.findUnique({
    where: whereUnique,
    select: { id: true, used: true, reserved: true, periodStart: true, periodEnd: true, backfilled: true },
  })

  if (period) return period

  // No period — create one with a backfilled `used` count from historical
  // AI messages in the window.
  const historicalCount = await globalDb.message.count({
    where: {
      tenantId,
      senderType: 'ai',
      status: 'sent',
      createdAt: { gte: window.start, lt: window.end },
    },
  })

  try {
    period = await globalDb.aiUsagePeriod.create({
      data: {
        tenantId,
        periodStart: window.start,
        periodEnd: window.end,
        used: historicalCount,
        reserved: 0,
        backfilled: true,
      },
      select: { id: true, used: true, reserved: true, periodStart: true, periodEnd: true, backfilled: true },
    })
    return period
  } catch {
    // Concurrent create — the unique constraint threw. Re-query.
    period = await globalDb.aiUsagePeriod.findUnique({
      where: whereUnique,
      select: { id: true, used: true, reserved: true, periodStart: true, periodEnd: true, backfilled: true },
    })
    if (!period) throw new Error('AiUsagePeriod vanished after concurrent create')
    return period
  }
}

// ---------------------------------------------------------------------------
// Stale reservation recovery
// ---------------------------------------------------------------------------

async function releaseStaleReservations(tenantId: string, now: Date): Promise<void> {
  // Find reservations that are 'reserved' and past their lease.
  const stale = await globalDb.aiReplyReservation.findMany({
    where: {
      tenantId,
      status: 'reserved',
      expiresAt: { lt: now },
    },
    select: { id: true, usagePeriodId: true },
    take: 50, // bounded — don't block on a huge cleanup
  })

  for (const r of stale) {
    // Conditional release — only if still 'reserved' (not committed by
    // another request concurrently).
    const updated = await globalDb.aiReplyReservation.updateMany({
      where: { id: r.id, tenantId, status: 'reserved' },
      data: { status: 'released' },
    })
    if (updated.count > 0) {
      // Decrement `reserved` on the period (the slot is freed).
      await globalDb.aiUsagePeriod.update({
        where: { id: r.usagePeriodId },
        data: { reserved: { decrement: 1 } },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current AI usage state for a tenant.
 *
 * Resolves the plan, billing window, and usage period (creating + backfilling
 * if needed). Releases stale reservations. Returns the authoritative
 * `{ planSlug, used, reserved, limit, remaining, periodStart, periodEnd }`.
 */
export async function getAiUsageState(
  tenantId: string,
  now: Date = new Date(),
): Promise<AiUsageState> {
  const { planSlug, limit, window } = await resolvePlanAndWindow(tenantId, now)

  // Release stale reservations before computing remaining.
  await releaseStaleReservations(tenantId, now)

  if (!window) {
    // Active subscription but expired / not-yet-started / malformed →
    // fail closed (no AI, no period).
    return { planSlug, used: 0, reserved: 0, limit: 0, remaining: 0, periodStart: null, periodEnd: null }
  }

  const period = await getOrCreatePeriod(tenantId, window)
  const remaining = getAiRemaining(period.used, period.reserved, limit)

  return {
    planSlug,
    used: period.used,
    reserved: period.reserved,
    limit,
    remaining,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  }
}

/**
 * Reserve one AI reply capacity unit before generation.
 *
 * - Idempotent per [tenantId, visitorMessageId]: a duplicate reservation
 *   returns the original reservation ID (or 'already_committed').
 * - Atomic: a conditional `UPDATE ... WHERE used + reserved < limit`
 *   serializes concurrent reservations — only one of N concurrent requests
 *   for the final slot succeeds.
 * - Free (limit 0) → 'limit_reached'.
 * - Unlimited (limit -1) → always 'reserved'.
 */
export async function reserveAiReply(input: {
  tenantId: string
  conversationId: string
  visitorMessageId: string
  now?: Date
}): Promise<ReserveResult> {
  const { tenantId, conversationId, visitorMessageId } = input
  const now = input.now ?? new Date()

  const { planSlug, limit, window } = await resolvePlanAndWindow(tenantId, now)

  // Release stale reservations first.
  await releaseStaleReservations(tenantId, now)

  if (!window) {
    // Expired / malformed subscription → fail closed.
    return { status: 'limit_reached' }
  }

  // --- Idempotency: check for an existing reservation for this visitor message ---
  const existing = await globalDb.aiReplyReservation.findUnique({
    where: { tenantId_visitorMessageId: { tenantId, visitorMessageId } },
    select: { id: true, status: true, aiMessageId: true },
  })

  if (existing) {
    if (existing.status === 'committed' && existing.aiMessageId) {
      return { status: 'already_committed', messageId: existing.aiMessageId }
    }
    if (existing.status === 'reserved') {
      return { status: 'in_progress', reservationId: existing.id }
    }
    // status === 'released' — the reservation was released (generation
    // failed previously). Allow re-reservation by updating it back to
    // 'reserved' IF capacity is available.
  }

  const period = await getOrCreatePeriod(tenantId, window)

  // --- Atomic reservation: conditional UPDATE on the period row ---
  // PostgreSQL row-locks the period during the UPDATE, serializing
  // concurrent reservations. The WHERE condition ensures we don't
  // over-allocate. For unlimited (limit = -1), the condition is always true.
  const rows = await globalDb.$queryRaw<Array<{ id: string }>>`
    UPDATE "AiUsagePeriod"
    SET "reserved" = "reserved" + 1, "updatedAt" = NOW()
    WHERE "id" = ${period.id}
      AND ("used" + "reserved" < ${limit} OR ${limit} = -1)
    RETURNING "id"
  `

  if (rows.length === 0) {
    // Limit reached — no slot available.
    return { status: 'limit_reached' }
  }

  // --- Create or re-activate the reservation ---
  const expiresAt = new Date(now.getTime() + RESERVATION_LEASE_MS)
  try {
    // Try to create a new reservation.
    const reservation = await globalDb.aiReplyReservation.create({
      data: {
        tenantId,
        visitorMessageId,
        conversationId,
        usagePeriodId: period.id,
        status: 'reserved',
        expiresAt,
      },
      select: { id: true },
    })
    return { status: 'reserved', reservationId: reservation.id }
  } catch {
    // Unique constraint violation — a concurrent request already created
    // a reservation for this visitor message. Re-query and return it.
    const concurrent = await globalDb.aiReplyReservation.findUnique({
      where: { tenantId_visitorMessageId: { tenantId, visitorMessageId } },
      select: { id: true, status: true, aiMessageId: true },
    })
    if (!concurrent) {
      // Shouldn't happen — but if it does, the slot was already reserved
      // on the period. Release it to avoid a leak.
      await globalDb.aiUsagePeriod.update({
        where: { id: period.id },
        data: { reserved: { decrement: 1 } },
      })
      return { status: 'limit_reached' }
    }
    if (concurrent.status === 'committed' && concurrent.aiMessageId) {
      // The concurrent request already committed — release our extra slot.
      await globalDb.aiUsagePeriod.update({
        where: { id: period.id },
        data: { reserved: { decrement: 1 } },
      })
      return { status: 'already_committed', messageId: concurrent.aiMessageId }
    }
    // The concurrent reservation is 'reserved' — return it as 'in_progress'.
    // Release our extra slot.
    await globalDb.aiUsagePeriod.update({
      where: { id: period.id },
      data: { reserved: { decrement: 1 } },
    })
    return { status: 'in_progress', reservationId: concurrent.id }
  }
}

/**
 * Commit an AI reply: atomically persist the AI Message, settle the
 * reservation, and update the usage counters.
 *
 * - Idempotent: a duplicate commit returns the original AI message ID.
 * - Cross-tenant: a foreign tenantId + reservationId → 'not_found'.
 * - If message persistence fails, the usage charge does not commit
 *   (the whole transaction rolls back).
 */
export async function commitAiReply(input: {
  tenantId: string
  reservationId: string
  conversationId: string
  text: string
  source: 'faq' | 'product'
  now?: Date
}): Promise<CommitResult> {
  const { tenantId, reservationId, conversationId, text, source } = input
  const now = input.now ?? new Date()

  // Find the reservation (tenant-scoped — a foreign tenant gets 'not_found').
  const reservation = await globalDb.aiReplyReservation.findUnique({
    where: { id: reservationId },
    select: { id: true, tenantId: true, status: true, aiMessageId: true, usagePeriodId: true, conversationId: true },
  })

  if (!reservation || reservation.tenantId !== tenantId) {
    return { status: 'not_found' }
  }

  // Idempotent: already committed → return the existing AI message.
  if (reservation.status === 'committed' && reservation.aiMessageId) {
    return { status: 'committed', messageId: reservation.aiMessageId }
  }

  // Only 'reserved' reservations can be committed. 'released' or already
  // 'committed' (without aiMessageId — shouldn't happen) → not_found.
  if (reservation.status !== 'reserved') {
    return { status: 'not_found' }
  }

  // Validate the conversation matches.
  if (reservation.conversationId !== conversationId) {
    return { status: 'not_found' }
  }

  // --- Atomic commit: interactive transaction ---
  try {
    const messageId = await globalDb.$transaction(async (tx) => {
      // 1. Create the AI Message.
      const msg = await tx.message.create({
        data: {
          tenantId,
          conversationId,
          senderType: 'ai',
          senderUserId: null,
          contentType: 'text',
          content: { text, source },
          status: 'sent',
        },
        select: { id: true },
      })

      // 2. Settle the reservation to 'committed' with the AI message ID.
      //    Conditional — only if still 'reserved' (prevents a concurrent
      //    commit from double-charging).
      const settled = await tx.aiReplyReservation.updateMany({
        where: { id: reservationId, tenantId, status: 'reserved' },
        data: { status: 'committed', aiMessageId: msg.id },
      })

      if (settled.count === 0) {
        // A concurrent request already committed — the message we just
        // created is a duplicate. Roll back (throw to abort the tx).
        throw new Error('RESERVATION_ALREADY_SETTLED')
      }

      // 3. Update the usage period: increment `used`, decrement `reserved`.
      await tx.aiUsagePeriod.update({
        where: { id: reservation.usagePeriodId },
        data: { used: { increment: 1 }, reserved: { decrement: 1 } },
      })

      return msg.id
    })

    return { status: 'committed', messageId }
  } catch (e) {
    // If the reservation was concurrently settled, return the existing message.
    if (e instanceof Error && e.message === 'RESERVATION_ALREADY_SETTLED') {
      const refetched = await globalDb.aiReplyReservation.findUnique({
        where: { id: reservationId },
        select: { aiMessageId: true },
      })
      if (refetched?.aiMessageId) {
        return { status: 'committed', messageId: refetched.aiMessageId }
      }
    }
    // Re-throw unexpected errors.
    throw e
  }
}

/**
 * Release a reservation (generation failed or produced no answer).
 *
 * - Idempotent: a second release is a no-op.
 * - Never refunds an already-committed reply (conditional on status = 'reserved').
 * - Decrements `reserved` on the usage period (frees the slot).
 */
export async function releaseAiReply(input: {
  tenantId: string
  reservationId: string
}): Promise<void> {
  const { tenantId, reservationId } = input

  // Conditional release — only if still 'reserved'. A committed reservation
  // is never refunded. A released reservation is a no-op.
  const updated = await globalDb.aiReplyReservation.updateMany({
    where: { id: reservationId, tenantId, status: 'reserved' },
    data: { status: 'released' },
  })

  if (updated.count > 0) {
    // Decrement `reserved` on the period (free the slot).
    const reservation = await globalDb.aiReplyReservation.findUnique({
      where: { id: reservationId },
      select: { usagePeriodId: true },
    })
    if (reservation) {
      await globalDb.aiUsagePeriod.update({
        where: { id: reservation.usagePeriodId },
        data: { reserved: { decrement: 1 } },
      })
    }
  }
}
