/**
 * AI-Q5 — Human takeover guard (server-side, persisted PostgreSQL state).
 *
 * `canAutoReplyToConversation` reads the CURRENT persisted conversation
 * state and message history from the tenant-scoped database and evaluates
 * the takeover policy.
 *
 * This function is called:
 *   - BEFORE AI reservation (early eligibility check in the widget route)
 *   - The commit-time guard in `commitAiReply` provides the ATOMIC
 *     check inside the settlement transaction (handles races where
 *     takeover occurs AFTER reservation but BEFORE commit).
 *
 * ## Tenant isolation
 *
 * This function MUST be called inside a `withTenant(tenantId, ...)`
 * context. The `db` proxy auto-injects `tenantId` into all queries,
 * ensuring strict tenant isolation. A conversation ID from a different
 * tenant will not be found → fail closed.
 *
 * ## No client-controlled flags
 *
 * The decision uses only server-verified PostgreSQL state:
 *   - Conversation status, assignedUserId, firstResponseAt
 *   - Count of agent messages (senderType = 'agent')
 *
 * Never uses a visitor-supplied field, header, or query parameter.
 */

import { db } from '@/lib/db'
import { canAiAutoReply, type HumanTakeoverState } from './human-takeover-policy'

/**
 * Check whether AI auto-reply is currently permitted for a conversation.
 *
 * Reads the conversation's persisted state (status, assignedUserId,
 * firstResponseAt) and counts agent messages. Evaluates the policy
 * via `canAiAutoReply`.
 *
 * @param conversationId The conversation to check.
 * @returns `true` if AI auto-reply is permitted, `false` otherwise.
 *
 * @requires Must be called inside `withTenant(tenantId, ...)`.
 */
export async function canAutoReplyToConversation(
  conversationId: string,
): Promise<boolean> {
  if (typeof conversationId !== 'string' || !conversationId) {
    return false
  }

  // Read the conversation's persisted state. The `db` proxy auto-injects
  // tenantId — a foreign-tenant conversation ID will not match → null.
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      status: true,
      assignedUserId: true,
      firstResponseAt: true,
    },
  })

  if (!conversation) {
    // Conversation not found (wrong tenant, deleted, or invalid ID) → fail closed.
    return false
  }

  // Count agent messages in this conversation.
  // Only senderType = 'agent' counts as human takeover.
  // AI ('ai') and system ('system') messages do NOT represent human takeover.
  const agentMessageCount = await db.message.count({
    where: {
      conversationId,
      senderType: 'agent',
    },
  })

  const state: HumanTakeoverState = {
    status: conversation.status,
    assignedUserId: conversation.assignedUserId,
    firstResponseAt: conversation.firstResponseAt,
    agentMessageCount,
  }

  return canAiAutoReply(state)
}
