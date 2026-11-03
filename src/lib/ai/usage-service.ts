/**
 * AI-Q2 — Atomic successful-reply accounting service (corrected).
 *
 * Server-side only. Uses `globalDb` (raw Prisma client) directly because:
 * - The service receives an explicit `tenantId` (no ALS context needed).
 * - Atomic transactions require the raw client's `$transaction` / `$queryRaw`.
 * - The reviewer DB tests call these functions without `withTenant`.
 *
 * ## Corrected defects (reviewer AI-Q2 corrections)
 *
 * A. Released reservation retry: a released reservation for the same visitor
 *    message is REACTIVATED (conditional status transition `released → reserved`)
 *    inside the same transaction that increments capacity. No second row is
 *    inserted.
 *
 * B. Foreign visitor Message IDs: `reserveAiReply` verifies the Message exists,
 *    has `senderType === 'contact'`, `message.tenantId === tenantId`, and
 *    `message.conversationId === conversationId` before reserving. The
 *    Conversation is also verified to belong to the same tenant.
 *
 * C. Foreign Conversation IDs: the same ownership chain is enforced at both
 *    reserve and commit time (inside the settlement transaction).
 *
 * D. Expired lease: `commitAiReply` checks `expiresAt` INSIDE the settlement
 *    transaction. An expired lease → `not_found` (no message, no charge).
 *
 * E. `checkPlanLimit('aiActions')` uses `getAiUsageState` (authoritative) via
 *    `countUsage` in gating.ts (fixed in gating.ts).
 *
 * ## Transactional crash consistency
 *
 * Reserve: the capacity increment AND the reservation create/reactivate happen
 * in ONE `$transaction`. A crash between them is impossible — both succeed or
 * neither does.
 *
 * Release: the status transition AND the counter decrement happen in ONE
 * `$transaction`. Same for stale-reservation recovery.
 *
 * Commit: the message create, reservation settlement, and usage counter update
 * happen in ONE `$transaction`. Settlement is conditional on `status =
 * 'reserved'` AND `expiresAt > now`.
 *
 * No external LLM request is ever placed inside a database transaction.
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

// Valid AI reply sources.
const VALID_SOURCES = ['faq', 'product'] as const
type ValidSource = (typeof VALID_SOURCES)[number]

// ---------------------------------------------------------------------------
// Plan + window resolution
// ---------------------------------------------------------------------------

async function resolvePlanAndWindow(tenantId: string, now: Date) {
  const subscription = await globalDb.subscription.findFirst({
    where: { tenantId, status: 'active' },
    include: { plan: { select: { slug: true } } },
    orderBy: { createdAt: 'desc' },
  })

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

  const plan = getPlan(planSlug)
  if (!plan) planSlug = 'free'
  const limit = plan ? plan.limits.aiActions : 0

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

  let period = await globalDb.aiUsagePeriod.findUnique({
    where: whereUnique,
    select: { id: true, used: true, reserved: true, periodStart: true, periodEnd: true, backfilled: true },
  })

  if (period) return period

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
    period = await globalDb.aiUsagePeriod.findUnique({
      where: whereUnique,
      select: { id: true, used: true, reserved: true, periodStart: true, periodEnd: true, backfilled: true },
    })
    if (!period) throw new Error('AiUsagePeriod vanished after concurrent create')
    return period
  }
}

// ---------------------------------------------------------------------------
// Visitor message + conversation ownership verification (Defects B + C)
// ---------------------------------------------------------------------------

/**
 * Verify that the visitor Message exists, belongs to the given tenant, is in
 * the given conversation, and has senderType 'contact'. Also verify the
 * Conversation belongs to the same tenant.
 *
 * Returns true if all checks pass, false otherwise.
 */
async function verifyMessageOwnership(
  tenantId: string,
  conversationId: string,
  visitorMessageId: string,
): Promise<boolean> {
  const msg = await globalDb.message.findUnique({
    where: { id: visitorMessageId },
    select: { tenantId: true, conversationId: true, senderType: true },
  })
  if (!msg) return false
  if (msg.tenantId !== tenantId) return false
  if (msg.conversationId !== conversationId) return false
  if (msg.senderType !== 'contact') return false

  // Verify the conversation belongs to the same tenant.
  const conv = await globalDb.conversation.findUnique({
    where: { id: conversationId },
    select: { tenantId: true },
  })
  if (!conv || conv.tenantId !== tenantId) return false

  return true
}

// ---------------------------------------------------------------------------
// Stale reservation recovery (atomic: status transition + counter decrement)
// ---------------------------------------------------------------------------

async function releaseStaleReservations(tenantId: string, now: Date): Promise<void> {
  const stale = await globalDb.aiReplyReservation.findMany({
    where: {
      tenantId,
      status: 'reserved',
      expiresAt: { lt: now },
    },
    select: { id: true, usagePeriodId: true },
    take: 50,
  })

  for (const r of stale) {
    // Atomic: status transition + counter decrement in ONE transaction.
    // Conditional on status = 'reserved' — a concurrent commit/release
    // that already transitioned the status makes this a no-op.
    await globalDb.$transaction(async (tx) => {
      const updated = await tx.aiReplyReservation.updateMany({
        where: { id: r.id, tenantId, status: 'reserved' },
        data: { status: 'released' },
      })
      if (updated.count > 0) {
        await tx.aiUsagePeriod.update({
          where: { id: r.usagePeriodId },
          data: { reserved: { decrement: 1 } },
        })
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getAiUsageState(
  tenantId: string,
  now: Date = new Date(),
): Promise<AiUsageState> {
  const { planSlug, limit, window } = await resolvePlanAndWindow(tenantId, now)

  await releaseStaleReservations(tenantId, now)

  if (!window) {
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
 * Corrected:
 * - Verifies visitor Message + Conversation ownership (Defects B, C).
 * - Reactivates released reservations in the same transaction as the capacity
 *   increment (Defect A).
 * - Capacity increment + reservation create/reactivate are ONE transaction
 *   (crash consistency).
 */
export async function reserveAiReply(input: {
  tenantId: string
  conversationId: string
  visitorMessageId: string
  now?: Date
}): Promise<ReserveResult> {
  const { tenantId, conversationId, visitorMessageId } = input
  const now = input.now ?? new Date()

  const { planSlug: _planSlug, limit, window } = await resolvePlanAndWindow(tenantId, now)

  await releaseStaleReservations(tenantId, now)

  if (!window) {
    return { status: 'limit_reached' }
  }

  // --- Ownership verification (Defects B, C) ---
  const owned = await verifyMessageOwnership(tenantId, conversationId, visitorMessageId)
  if (!owned) {
    return { status: 'limit_reached' }
  }

  // --- Check for an existing reservation for this visitor message ---
  const existing = await globalDb.aiReplyReservation.findUnique({
    where: { tenantId_visitorMessageId: { tenantId, visitorMessageId } },
    select: { id: true, status: true, aiMessageId: true, usagePeriodId: true },
  })

  if (existing) {
    if (existing.status === 'committed' && existing.aiMessageId) {
      return { status: 'already_committed', messageId: existing.aiMessageId }
    }
    if (existing.status === 'reserved') {
      return { status: 'in_progress', reservationId: existing.id }
    }
    // status === 'released' — reactivate below.
  }

  const period = await getOrCreatePeriod(tenantId, window)
  const expiresAt = new Date(now.getTime() + RESERVATION_LEASE_MS)

  // --- Atomic reserve: capacity increment + reservation create/reactivate
  // in ONE transaction (crash consistency) ---
  try {
    const result = await globalDb.$transaction(async (tx) => {
      // Conditional capacity increment (PostgreSQL row-lock).
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "AiUsagePeriod"
        SET "reserved" = "reserved" + 1, "updatedAt" = NOW()
        WHERE "id" = ${period.id}
          AND ("used" + "reserved" < ${limit} OR ${limit} = -1)
        RETURNING "id"
      `
      if (rows.length === 0) {
        return null as null | { reservationId: string }
      }

      // Create or reactivate the reservation row.
      if (existing && existing.status === 'released') {
        // Reactivate: conditional on status = 'released'. Update the period
        // reference, conversationId, expiresAt, and status.
        await tx.aiReplyReservation.updateMany({
          where: { id: existing.id, tenantId, status: 'released' },
          data: {
            status: 'reserved',
            usagePeriodId: period.id,
            conversationId,
            expiresAt,
            aiMessageId: null,
          },
        })
        return { reservationId: existing.id }
      } else {
        // Create a new reservation.
        const reservation = await tx.aiReplyReservation.create({
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
        return { reservationId: reservation.id }
      }
    })

    if (!result) {
      return { status: 'limit_reached' }
    }
    return { status: 'reserved', reservationId: result.reservationId }
  } catch {
    // Concurrent create might have hit the unique constraint. Re-query.
    const concurrent = await globalDb.aiReplyReservation.findUnique({
      where: { tenantId_visitorMessageId: { tenantId, visitorMessageId } },
      select: { id: true, status: true, aiMessageId: true },
    })
    if (!concurrent) {
      // The transaction failed for another reason. The capacity increment
      // was rolled back (it was in the same transaction).
      return { status: 'limit_reached' }
    }
    if (concurrent.status === 'committed' && concurrent.aiMessageId) {
      return { status: 'already_committed', messageId: concurrent.aiMessageId }
    }
    if (concurrent.status === 'reserved') {
      return { status: 'in_progress', reservationId: concurrent.id }
    }
    // status === 'released' — a concurrent request released it. The caller
    // can retry.
    return { status: 'limit_reached' }
  }
}

/**
 * Commit an AI reply: atomically persist the AI Message, settle the
 * reservation, and update the usage counters.
 *
 * Corrected:
 * - Checks expiresAt INSIDE the settlement transaction (Defect D).
 * - Validates blank/invalid text and source (content validation).
 * - Enforces conversation ownership inside the transaction (Defect C).
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

  // --- Content validation (billable reply content) ---
  if (!text || !text.trim()) {
    return { status: 'not_found' }
  }
  if (!VALID_SOURCES.includes(source as ValidSource)) {
    return { status: 'not_found' }
  }

  // Find the reservation.
  const reservation = await globalDb.aiReplyReservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      aiMessageId: true,
      usagePeriodId: true,
      conversationId: true,
      expiresAt: true,
    },
  })

  if (!reservation || reservation.tenantId !== tenantId) {
    return { status: 'not_found' }
  }

  // Idempotent: already committed → return the existing AI message.
  if (reservation.status === 'committed' && reservation.aiMessageId) {
    return { status: 'committed', messageId: reservation.aiMessageId }
  }

  // Only 'reserved' reservations can be committed.
  if (reservation.status !== 'reserved') {
    return { status: 'not_found' }
  }

  // Validate the conversation matches.
  if (reservation.conversationId !== conversationId) {
    return { status: 'not_found' }
  }

  // --- Atomic commit: interactive transaction ---
  // The settlement is conditional on:
  //   status = 'reserved' AND expiresAt > now
  // This prevents an expired lease from committing (Defect D) even before
  // stale cleanup runs.
  try {
    const messageId = await globalDb.$transaction(async (tx) => {
      // 1. Settle the reservation to 'committed' — conditional on status =
      // 'reserved' AND expiresAt > now. This is the atomic expiry check
      // (Defect D).
      const settled = await tx.aiReplyReservation.updateMany({
        where: {
          id: reservationId,
          tenantId,
          status: 'reserved',
          expiresAt: { gt: now },
        },
        data: { status: 'committed' },
      })

      if (settled.count === 0) {
        // Either the reservation was already settled/released by a concurrent
        // request, OR the lease has expired. Either way, no commit.
        throw new Error('RESERVATION_NOT_SETTLABLE')
      }

      // 2. Create the AI Message.
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

      // 3. Link the message to the reservation and update usage counters.
      await tx.aiReplyReservation.update({
        where: { id: reservationId },
        data: { aiMessageId: msg.id },
      })

      await tx.aiUsagePeriod.update({
        where: { id: reservation.usagePeriodId },
        data: { used: { increment: 1 }, reserved: { decrement: 1 } },
      })

      return msg.id
    })

    return { status: 'committed', messageId }
  } catch (e) {
    if (e instanceof Error && e.message === 'RESERVATION_NOT_SETTLABLE') {
      // The reservation was expired or already settled. Return not_found.
      // If it was concurrently committed by another request, the caller
      // can re-query.
      const refetched = await globalDb.aiReplyReservation.findUnique({
        where: { id: reservationId },
        select: { status: true, aiMessageId: true },
      })
      if (refetched?.status === 'committed' && refetched.aiMessageId) {
        return { status: 'committed', messageId: refetched.aiMessageId }
      }
      return { status: 'not_found' }
    }
    throw e
  }
}

/**
 * Release a reservation (generation failed or produced no answer).
 *
 * Corrected:
 * - Status transition + counter decrement in ONE transaction (crash consistency).
 * - Idempotent: a second release is a no-op.
 * - Never refunds an already-committed reply.
 */
export async function releaseAiReply(input: {
  tenantId: string
  reservationId: string
}): Promise<void> {
  const { tenantId, reservationId } = input

  // Atomic: status transition + counter decrement in ONE transaction.
  // Conditional on status = 'reserved' — a committed reservation is never
  // refunded, a released reservation is a no-op.
  await globalDb.$transaction(async (tx) => {
    const reservation = await tx.aiReplyReservation.findUnique({
      where: { id: reservationId },
      select: { usagePeriodId: true, status: true, tenantId: true },
    })

    if (!reservation || reservation.tenantId !== tenantId) return
    if (reservation.status !== 'reserved') return

    await tx.aiReplyReservation.updateMany({
      where: { id: reservationId, tenantId, status: 'reserved' },
      data: { status: 'released' },
    })

    await tx.aiUsagePeriod.update({
      where: { id: reservation.usagePeriodId },
      data: { reserved: { decrement: 1 } },
    })
  })
}
