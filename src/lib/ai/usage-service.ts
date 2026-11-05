/**
 * AI-Q2 — Atomic successful-reply accounting service (final corrections).
 *
 * ## Corrected defects (final reviewer corrections)
 *
 * A. Concurrent release negative counters: the conditional `updateMany` result
 *    count is checked. `reserved` is decremented ONLY when `count === 1`.
 *    Concurrent duplicate releases are idempotent — no negative counters.
 *
 * B. Concurrent reactivation multiple slots: the reactivation `updateMany`
 *    result count is checked. If `count === 0` (another concurrent request
 *    already reactivated), the capacity increment is rolled back (throw to
 *    abort the transaction). Only ONE of 12 concurrent retries succeeds.
 *
 * C. Expired active subscription gating: `checkPlanLimit('aiActions')` in
 *    gating.ts derives BOTH limit and current from `getAiUsageState` — an
 *    expired active subscription returns limit=0, so the gate denies.
 *
 * D. Commit-time tenant ownership: inside the settlement transaction, the
 *    Conversation is verified to belong to `tenantId`, and the visitor
 *    Message is verified to belong to the same tenant and conversation. A
 *    corrupted reservation pointing at a foreign conversation → `not_found`.
 *
 * E. Stale cleanup vs renewal race: the stale cleanup `updateMany` checks
 *    `expiresAt < now` IN ADDITION to `status = 'reserved'`. A reactivated
 *    reservation with a fresh `expiresAt` is not released by a stale cleanup.
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

const RESERVATION_LEASE_MS = 5 * 60 * 1000 // 5 minutes
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
// Visitor message + conversation ownership verification
// ---------------------------------------------------------------------------

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

  const conv = await globalDb.conversation.findUnique({
    where: { id: conversationId },
    select: { tenantId: true },
  })
  if (!conv || conv.tenantId !== tenantId) return false

  return true
}

/**
 * Verify ownership INSIDE a transaction (for commit-time validation).
 * Uses the transaction client `tx`.
 */
async function verifyOwnershipInTx(
  tx: Parameters<Parameters<typeof globalDb.$transaction>[0]>[0],
  tenantId: string,
  conversationId: string,
  visitorMessageId: string,
): Promise<boolean> {
  const conv = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { tenantId: true },
  })
  if (!conv || conv.tenantId !== tenantId) return false

  const msg = await tx.message.findUnique({
    where: { id: visitorMessageId },
    select: { tenantId: true, conversationId: true, senderType: true },
  })
  if (!msg) return false
  if (msg.tenantId !== tenantId) return false
  if (msg.conversationId !== conversationId) return false
  if (msg.senderType !== 'contact') return false

  return true
}

// ---------------------------------------------------------------------------
// Stale reservation recovery (atomic + expiry re-check)
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
    await globalDb.$transaction(async (tx) => {
      // Conditional: status = 'reserved' AND expiresAt < now.
      // The expiresAt re-check prevents releasing a reservation that was
      // reactivated with a fresh lease between the select and this update.
      const updated = await tx.aiReplyReservation.updateMany({
        where: { id: r.id, tenantId, status: 'reserved', expiresAt: { lt: now } },
        data: { status: 'released' },
      })
      // Decrement ONLY when the transition succeeded (count === 1).
      if (updated.count === 1) {
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

export async function reserveAiReply(input: {
  tenantId: string
  conversationId: string
  visitorMessageId: string
  now?: Date
}): Promise<ReserveResult> {
  const { tenantId, conversationId, visitorMessageId } = input
  const now = input.now ?? new Date()

  const { limit, window } = await resolvePlanAndWindow(tenantId, now)

  await releaseStaleReservations(tenantId, now)

  if (!window) {
    return { status: 'limit_reached' }
  }

  // --- Ownership verification ---
  const owned = await verifyMessageOwnership(tenantId, conversationId, visitorMessageId)
  if (!owned) {
    return { status: 'limit_reached' }
  }

  // --- Check for an existing reservation ---
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
  // in ONE transaction ---
  try {
    const result = await globalDb.$transaction(async (tx) => {
      // Conditional capacity increment.
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
        // Reactivation: conditional on status = 'released'. If another
        // concurrent request already reactivated (count = 0), abort the
        // transaction to roll back the capacity increment.
        const reactivated = await tx.aiReplyReservation.updateMany({
          where: { id: existing.id, tenantId, status: 'released' },
          data: {
            status: 'reserved',
            usagePeriodId: period.id,
            conversationId,
            expiresAt,
            aiMessageId: null,
          },
        })
        if (reactivated.count === 0) {
          // Lost the reactivation race — another request reactivated first.
          // Roll back the capacity increment.
          throw new Error('REACTIVATION_LOST')
        }
        return { reservationId: existing.id }
      } else {
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
    // Either REACTIVATION_LOST or a unique constraint violation.
    // Re-query the current state and return the correct idempotent result.
    const concurrent = await globalDb.aiReplyReservation.findUnique({
      where: { tenantId_visitorMessageId: { tenantId, visitorMessageId } },
      select: { id: true, status: true, aiMessageId: true },
    })
    if (!concurrent) {
      return { status: 'limit_reached' }
    }
    if (concurrent.status === 'committed' && concurrent.aiMessageId) {
      return { status: 'already_committed', messageId: concurrent.aiMessageId }
    }
    if (concurrent.status === 'reserved') {
      return { status: 'in_progress', reservationId: concurrent.id }
    }
    // status === 'released' — a concurrent request released it after
    // reactivation. The caller can retry.
    return { status: 'limit_reached' }
  }
}

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

  // --- Content validation ---
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
      visitorMessageId: true,
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
  try {
    const messageId = await globalDb.$transaction(async (tx) => {
      // 1. Settle the reservation — conditional on status = 'reserved'
      // AND expiresAt > now (atomic expiry check).
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
        throw new Error('RESERVATION_NOT_SETTLABLE')
      }

      // 2. Commit-time ownership revalidation (Defect D).
      // Verify the Conversation belongs to the same tenant AND the visitor
      // Message belongs to the same tenant and conversation — inside the
      // transaction, not just a pre-read.
      const owned = await verifyOwnershipInTx(
        tx,
        tenantId,
        conversationId,
        reservation.visitorMessageId,
      )
      if (!owned) {
        throw new Error('OWNERSHIP_INVALID')
      }

      // 2b. Commit-time human-takeover guard (AI-Q5).
      // Inside the transaction, check if a human has taken over the
      // conversation since the reservation was made. This handles the
      // critical race: visitor message → AI reserves → human takes over
      // → AI attempts to commit. The commit MUST fail without producing
      // an AI message or charge.
      //
      // Checks: assignedUserId, firstResponseAt, status, agentMessageCount.
      // All checks use the transaction's `tx` client for a consistent
      // read within the same atomic operation.
      const convState = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          tenantId: true,
          status: true,
          assignedUserId: true,
          firstResponseAt: true,
        },
      })
      if (!convState || convState.tenantId !== tenantId) {
        throw new Error('OWNERSHIP_INVALID')
      }
      if (convState.status !== 'open' ||
          convState.assignedUserId !== null ||
          convState.firstResponseAt !== null) {
        throw new Error('HUMAN_TAKEOVER')
      }
      // Check for agent messages in this conversation (persisted human reply).
      const agentMsgCount = await tx.message.count({
        where: { conversationId, tenantId, senderType: 'agent' },
      })
      if (agentMsgCount > 0) {
        throw new Error('HUMAN_TAKEOVER')
      }

      // 3. Create the AI Message.
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

      // 4. Link the message and update usage counters.
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
    if (e instanceof Error && (e.message === 'RESERVATION_NOT_SETTLABLE' || e.message === 'OWNERSHIP_INVALID' || e.message === 'HUMAN_TAKEOVER')) {
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

export async function releaseAiReply(input: {
  tenantId: string
  reservationId: string
}): Promise<void> {
  const { tenantId, reservationId } = input

  // Atomic: conditional status transition + counter decrement in ONE
  // transaction. The decrement happens ONLY when the conditional
  // updateMany succeeds (count === 1). Concurrent duplicate releases are
  // idempotent — no negative counters.
  await globalDb.$transaction(async (tx) => {
    // Get the usagePeriodId (needed for the decrement).
    const reservation = await tx.aiReplyReservation.findUnique({
      where: { id: reservationId },
      select: { usagePeriodId: true, tenantId: true },
    })

    if (!reservation || reservation.tenantId !== tenantId) return

    // Conditional status transition — only if still 'reserved'.
    const updated = await tx.aiReplyReservation.updateMany({
      where: { id: reservationId, tenantId, status: 'reserved' },
      data: { status: 'released' },
    })

    // Decrement ONLY when the transition succeeded.
    // This prevents concurrent duplicate releases from driving `reserved`
    // below zero.
    if (updated.count === 1) {
      await tx.aiUsagePeriod.update({
        where: { id: reservation.usagePeriodId },
        data: { reserved: { decrement: 1 } },
      })
    }
  })
}
