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
 * - The summary is based exclusively on persisted contact+ai text messages
 *   BEFORE the human takeover event (first agent message or assignment).
 * - Cross-tenant conversation IDs fail closed (db proxy enforces tenantId).
 */

import { db, getCurrentTenantId } from '@/lib/db'
import {
  handoffSummaryEligible,
  summarizeHandoffMessages,
  type HandoffSourceMessage,
} from './handoff-summary-policy'
import { canAutoReplyToConversation } from './human-takeover'

/**
 * Ensure exactly one handoff summary exists for a conversation.
 *
 * This function is called after a human takeover event (assignment or
 * first agent reply). It is idempotent — if a summary already exists,
 * it returns the existing one without modification.
 *
 * @returns The summary text if created/found, or null if ineligible.
 *
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
    // AI is still eligible — human has NOT taken over yet.
    return null
  }

  // 3. Read conversation for tenant ownership + plan.
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

  // 5. Find the takeover timestamp — the first agent message or
  // firstResponseAt, whichever is earlier. Messages after this point
  // are excluded from the summary (they belong to the human-handled phase).
  let takeoverTime: Date | null = conversation.firstResponseAt

  if (!takeoverTime) {
    // Check for the first agent message.
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
      takeoverTime = firstAgentMsg.createdAt
    }
  }

  // If no takeover signal found, no summary.
  if (!takeoverTime && conversation.assignedUserId === null) {
    return null
  }

  // 6. Read pre-takeover messages (contact + ai text only).
  // Use a bounded query: only messages before the takeover time (if known).
  // If takeoverTime is null but assignment exists, read all messages
  // (there are no agent messages to exclude).
  const messageWhere: Record<string, unknown> = {
    conversationId,
    tenantId,
    senderType: { in: ['contact', 'ai'] },
    contentType: 'text',
  }
  if (takeoverTime) {
    messageWhere.createdAt = { lt: takeoverTime }
  }

  const messages = await db.message.findMany({
    where: messageWhere as any,
    select: {
      id: true,
      senderType: true,
      contentType: true,
      content: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500, // Bounded read — at most 500 pre-takeover messages.
  })

  // 7. Count AI messages for eligibility.
  const aiCount = messages.filter((m) => m.senderType === 'ai').length

  // 8. Check eligibility.
  if (!handoffSummaryEligible(tenant.plan, true, aiCount)) {
    return null
  }

  // 9. Transform to HandoffSourceMessage format.
  const sourceMessages: HandoffSourceMessage[] = messages.map((m) => ({
    id: m.id,
    senderType: m.senderType,
    contentType: m.contentType,
    content: m.content,
    createdAt: m.createdAt,
  }))

  // 10. Generate the deterministic summary.
  const summary = summarizeHandoffMessages(sourceMessages)
  if (!summary) {
    return null
  }

  // 11. Persist with PostgreSQL UNIQUE constraint — safe against
  // concurrent attempts. If a race produces a duplicate, the unique
  // constraint throws P2002 and we return the existing row.
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
    // P2002 = unique constraint violation — another concurrent attempt
    // created the summary first. Return the existing one.
    if (e?.code === 'P2002') {
      const existing = await db.conversationHandoffSummary.findUnique({
        where: { tenantId_conversationId: { tenantId, conversationId } },
        select: { summaryText: true },
      })
      return existing?.summaryText ?? null
    }
    // Any other error — fail closed (no summary, no charge).
    console.error('[ai:handoff-summary] persistence error:', e instanceof Error ? e.message : e)
    return null
  }
}
