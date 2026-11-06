/**
 * AI-Q6 — Real PostgreSQL handoff summary service.
 *
 * `ensureConversationHandoffSummary` runs under the actual tenant-scoped
 * database context. It validates persisted tenant ownership, effective plan,
 * human-takeover state, and presence of eligible pre-takeover AI messages.
 *
 * ## Key guarantees
 *
 * - No AI billing: does NOT call reserveAiReply, commitAiReply, or any LLM.
 * - No new AI Message rows created.
 * - No AiReplyReservation or AiUsagePeriod mutation.
 * - Exactly one summary per (tenantId, conversationId) via PostgreSQL UNIQUE.
 * - Concurrent attempts are safe — the unique constraint prevents duplicates.
 * - Reassignment/reopening does NOT rewrite the first summary.
 * - BLOCKER 4: Bounded keyset pagination finds AI messages beyond first 500.
 * - BLOCKER 5: Earliest authoritative human takeover event is used as cutoff.
 */

import { db, getCurrentTenantId } from '@/lib/db'
import {
  handoffSummaryEligible,
  summarizeHandoffMessages,
  type HandoffSourceMessage,
} from './handoff-summary-policy'
import { canAutoReplyToConversation } from './human-takeover'

const MSG_BATCH_SIZE = 200

/**
 * Ensure exactly one handoff summary exists for a conversation.
 *
 * @returns The summary text if created/found, or null if ineligible.
 * @requires Must be called inside `withTenant(tenantId, ...)`.
 */
export async function ensureConversationHandoffSummary(
  conversationId: string,
): Promise<string | null> {
  if (typeof conversationId !== 'string' || !conversationId) {
    return null
  }

  const tenantId = getCurrentTenantId()
  if (!tenantId) {
    return null
  }

  // 1. Check if a summary already exists (idempotent — first summary wins).
  const existing = await db.conversationHandoffSummary.findUnique({
    where: { tenantId_conversationId: { tenantId, conversationId } },
    select: { summaryText: true },
  })
  if (existing) {
    return existing.summaryText
  }

  // 2. Validate human takeover has occurred (Q5 guard).
  const aiEligible = await canAutoReplyToConversation(conversationId)
  if (aiEligible) {
    return null
  }

  // 3. Read conversation for tenant ownership + plan + takeover signals.
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      tenantId: true,
      status: true,
      assignedUserId: true,
      firstResponseAt: true,
    },
  })
  if (!conversation || conversation.tenantId !== tenantId) {
    return null
  }

  // 4. Get the tenant's plan.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  })
  if (!tenant) {
    return null
  }

  // 5. BLOCKER 5: Determine the EARLIEST authoritative human takeover event.
  // The cutoff is the minimum of:
  //   a) conversation.firstResponseAt
  //   b) The first agent message's createdAt
  //   c) The conversation's assignedUserId (if set, assignment is a takeover)
  //      — but we need the timestamp of the assignment, which we approximate
  //        by the earliest agent message or firstResponseAt.
  //
  // If firstResponseAt was populated later than the first agent message,
  // the first agent message timestamp is the authoritative cutoff.
  let takeoverTime: Date | null = conversation.firstResponseAt

  // Find the first agent message (earliest by createdAt).
  const firstAgentMsg = await db.message.findFirst({
    where: {
      conversationId,
      tenantId,
      senderType: 'agent',
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })

  if (firstAgentMsg) {
    if (!takeoverTime || firstAgentMsg.createdAt.getTime() < takeoverTime.getTime()) {
      takeoverTime = firstAgentMsg.createdAt
    }
  }

  // If no takeover signal found at all, check if assignment exists.
  // Assignment without a timestamp or agent message is still a takeover,
  // but we can't determine a precise cutoff. Use the current time as the
  // cutoff (exclude everything from now on — but include all past messages).
  if (!takeoverTime && conversation.assignedUserId !== null) {
    // Assignment happened but we don't know when. Use current time as cutoff
    // to include all pre-existing messages.
    takeoverTime = new Date()
  }

  // If still no takeover signal, no summary.
  if (!takeoverTime) {
    return null
  }

  // 6. BLOCKER 4: Bounded keyset pagination to find pre-takeover messages.
  // Read messages in batches of MSG_BATCH_SIZE using cursor pagination.
  // This discovers AI messages beyond the first 500 rows without loading
  // an unbounded conversation history into memory.
  const allMessages: HandoffSourceMessage[] = []
  let cursor: string | undefined = undefined
  let foundAi = false

  while (true) {
    const batch = await db.message.findMany({
      where: {
        conversationId,
        tenantId,
        senderType: { in: ['contact', 'ai'] },
        contentType: 'text',
        createdAt: { lt: takeoverTime },
      },
      select: {
        id: true,
        senderType: true,
        contentType: true,
        content: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: MSG_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    for (const m of batch) {
      allMessages.push({
        id: m.id,
        senderType: m.senderType,
        contentType: m.contentType,
        content: m.content,
        createdAt: m.createdAt,
      })
      if (m.senderType === 'ai') foundAi = true
    }

    if (batch.length < MSG_BATCH_SIZE) break
    cursor = batch[batch.length - 1].id

    // Safety: if we've collected a very large number, stop.
    // The summarizer will bound the output to 30 source IDs.
    if (allMessages.length >= 5000) break
  }

  // 7. Count AI messages for eligibility.
  const aiCount = allMessages.filter((m) => m.senderType === 'ai').length

  // 8. Check eligibility.
  if (!handoffSummaryEligible(tenant.plan, true, aiCount)) {
    return null
  }

  // 9. Generate the deterministic summary.
  const summary = summarizeHandoffMessages(allMessages)
  if (!summary) {
    return null
  }

  // 10. Persist with PostgreSQL UNIQUE constraint.
  try {
    await db.conversationHandoffSummary.create({
      data: {
        tenantId,
        conversationId,
        summaryText: summary.text,
        sourceMessageIds: summary.sourceMessageIds,
      },
    })
    return summary.text
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const existing = await db.conversationHandoffSummary.findUnique({
        where: { tenantId_conversationId: { tenantId, conversationId } },
        select: { summaryText: true },
      })
      return existing?.summaryText ?? null
    }
    console.error('[ai:handoff-summary] persistence error:', e instanceof Error ? e.message : e)
    return null
  }
}
