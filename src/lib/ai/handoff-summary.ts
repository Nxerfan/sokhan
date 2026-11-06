/**
 * AI-Q6 — Real PostgreSQL handoff summary service.
 *
 * `ensureConversationHandoffSummary` runs under the actual tenant-scoped
 * database context. It validates persisted tenant ownership, the EFFECTIVE
 * plan (active Subscription → Plan → fallback to Tenant.plan), human-takeover
 * state, and presence of eligible pre-takeover AI messages.
 *
 * ## Key guarantees
 *
 * - No AI billing: does NOT call reserveAiReply, commitAiReply, or any LLM.
 * - No new AI Message rows created.
 * - No AiReplyReservation or AiUsagePeriod mutation.
 * - Exactly one summary per (tenantId, conversationId) via PostgreSQL UNIQUE.
 * - Concurrent attempts are safe — the unique constraint prevents duplicates.
 * - Reassignment/reopening does NOT rewrite the first summary.
 *
 * ## BLOCKER 1 — bounded retrieval: latest AI answers prioritized
 *
 * The service does NOT accumulate an unbounded array of message rows. It:
 *   1. Counts pre-takeover AI messages (DB-side COUNT — O(1) memory).
 *      If zero, returns null immediately (no AI history to summarize).
 *   2. Fetches the LATEST N AI messages in DESC (createdAt, id) order
 *      (take MAX_AI_FETCH). This prioritizes the most recent — potentially
 *      corrective — AI answers. If the conversation has 101 AI replies and
 *      substantial intervening visitor history, the final corrective reply
 *      is retained, not the oldest 100. A lone AI reply at row 5,001 is
 *      also found (it is the latest — and only — AI reply, selected by
 *      senderType, not by pagination position).
 *   3. Fetches a bounded context window ordered DESC (latest first) around
 *      the retained AI portion — not exclusively from the earliest messages.
 *   Memory is bounded to at most MAX_AI_FETCH + MAX_CONTEXT_WINDOW +
 *   MAX_PRE_AI_CONTEXT rows (= 530). No unbounded history array.
 *
 * ## BLOCKER 2 — earliest authoritative takeover cutoff
 *
 * The cutoff is `min(firstHandoffAt, firstResponseAt, firstAgentMsg.createdAt)`.
 * `firstHandoffAt` is persisted atomically by a PostgreSQL BEFORE UPDATE
 * trigger on the FIRST assignment (NULL → non-NULL). Reassignment never
 * overwrites it. Retried summary generation reads the same persisted cutoff
 * and never moves the boundary forward. Post-assignment messages are
 * excluded even when the summary runs much later. We NEVER fall back to
 * `new Date()` (summary-generation time).
 *
 * ## BLOCKER 3 & 4 — effective plan via shared resolver
 *
 * Plan eligibility uses `resolveTenantPlanSlug` (from payments/gating) — the
 * SAME authoritative resolver used by AI-Q2 billing. An active Subscription's
 * linked Plan takes precedence over a stale `Tenant.plan` value. This avoids
 * duplicating inconsistent plan logic and does NOT touch Q2 billing counters.
 *
 * ## Consistency — one defensible pre-handoff snapshot
 *
 * The cutoff resolution AND the message reads run inside a single REPEATABLE
 * READ transaction. The summary therefore represents one consistent database
 * state — the first agent message timestamp (used for the cutoff) and every
 * fetched source message are observed at the same snapshot. No mixture of
 * different database states.
 */

import { db, getCurrentTenantId } from '@/lib/db'
import {
  handoffSummaryEligible,
  summarizeHandoffMessages,
  type HandoffSourceMessage,
} from './handoff-summary-policy'
import { canAutoReplyToConversation } from './human-takeover'
import { resolveTenantPlanSlug } from '@/lib/payments/gating'

// ---------------------------------------------------------------------------
// Resource bounds — explicit and fail-closed.
// ---------------------------------------------------------------------------

/** Maximum AI messages fetched directly (targeted query, not paginated). */
const MAX_AI_FETCH = 100

/** Maximum context-window rows fetched around the AI-handled portion. */
const MAX_CONTEXT_WINDOW = 400

/** Maximum visitor context rows fetched immediately before the first AI reply. */
const MAX_PRE_AI_CONTEXT = 30

/** Transaction timeout (ms) — bounded, fail-closed. */
const TX_TIMEOUT_MS = 10000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FetchedSnapshot {
  messages: HandoffSourceMessage[]
  aiCount: number
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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

  // 1. Idempotent: if a summary already exists, return it (first summary wins).
  const existing = await db.conversationHandoffSummary.findUnique({
    where: { tenantId_conversationId: { tenantId, conversationId } },
    select: { summaryText: true },
  })
  if (existing) {
    return existing.summaryText
  }

  // 2. Q5 guard: human takeover must have occurred (AI must be suppressed).
  const aiEligible = await canAutoReplyToConversation(conversationId)
  if (aiEligible) {
    return null
  }

  // 3. Validate tenant ownership + read persisted takeover signals.
  //    firstHandoffAt is persisted atomically by the PostgreSQL trigger and
  //    never moves forward on retry/reassignment, so reading it here (outside
  //    the snapshot transaction) is safe — it is a monotonically stable value.
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      tenantId: true,
      status: true,
      assignedUserId: true,
      firstResponseAt: true,
      firstHandoffAt: true,
    },
  })
  if (!conversation || conversation.tenantId !== tenantId) {
    return null
  }

  // 4. BLOCKER 3 & 4: Effective plan via the SHARED authoritative resolver.
  //    An active Subscription's linked Plan takes precedence over a stale
  //    Tenant.plan. This is the SAME logic AI-Q2 billing uses — no duplicate.
  const effectivePlanSlug = await resolveTenantPlanSlug(tenantId)

  // 5. BLOCKER 1 & 2: Resolve cutoff + fetch bounded snapshot in ONE
  //    REPEATABLE READ transaction so the cutoff and every source message
  //    are observed at the same database snapshot. Finds AI messages beyond
  //    any arbitrary page limit without loading an unbounded history array.
  const snapshot = await fetchBoundedSnapshot(
    conversationId,
    tenantId,
    conversation.firstResponseAt,
    conversation.firstHandoffAt,
  )
  if (!snapshot || snapshot.aiCount === 0) {
    return null
  }

  // 6. Check eligibility with the effective plan + authoritative aiCount.
  if (!handoffSummaryEligible(effectivePlanSlug, true, snapshot.aiCount)) {
    return null
  }

  // 7. Generate the deterministic summary (pure policy, no DB/LLM).
  const summary = summarizeHandoffMessages(snapshot.messages)
  if (!summary) {
    return null
  }

  // 8. Persist with PostgreSQL UNIQUE constraint (one-time, idempotent).
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
      // Concurrent attempt won the race — return the existing summary.
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

// ---------------------------------------------------------------------------
// BLOCKER 1: Bounded retrieval — latest AI answers prioritized + one snapshot
// ---------------------------------------------------------------------------

/**
 * Fetch a bounded, consistent snapshot of pre-takeover messages.
 *
 * Runs inside a single REPEATABLE READ transaction so the cutoff resolution
 * (first agent message) and every source message read are observed at the
 * SAME database snapshot — one defensible pre-handoff state.
 *
 * Strategy (memory-bounded, prioritizes the LATEST AI answers):
 *
 *   1. Find the earliest agent message (inside the snapshot transaction).
 *      Compute cutoff = min(firstHandoffAt, firstResponseAt, firstAgentMsg).
 *      If no takeover signal exists at all, return null (no summary).
 *
 *   2. COUNT pre-takeover AI messages (DB-side, O(1) memory). If zero,
 *      return immediately — no AI history. An exhausted scan budget is
 *      NEVER interpreted as "no AI history exists."
 *
 *   3. Fetch the LATEST N AI messages in DESC (createdAt, id) order
 *      (take MAX_AI_FETCH). This prioritizes the most recent — potentially
 *      corrective — AI answers. If the conversation has 101 AI replies and
 *      substantial intervening visitor history, the final corrective reply
 *      is retained, not the oldest 100. A lone AI reply at row 5,001 is
 *      also found (it is the latest — and only — AI reply).
 *
 *   4. Sort the fetched AI messages chronologically (ASC) to define the
 *      "retained AI portion": from earliestRetainedAi to latestRetainedAi.
 *
 *   5. Fetch a bounded context window of ALL pre-takeover text messages
 *      from earliestRetainedAi to the cutoff, ordered DESC (latest first)
 *      so the context budget is filled from the MOST RECENT context around
 *      the latest AI answers — not exclusively from the earliest historical
 *      messages. Bounded to MAX_CONTEXT_WINDOW rows.
 *
 *   6. Fetch a small visitor context window immediately before the earliest
 *      retained AI message (MAX_PRE_AI_CONTEXT rows, DESC) so the agent sees
 *      what triggered the earliest retained AI reply.
 *
 *   7. Merge all fetched rows, deduplicate by id. The pure policy handles
 *      full-identity conflict detection and chronological sorting.
 *
 * Memory: at most MAX_AI_FETCH + MAX_CONTEXT_WINDOW + MAX_PRE_AI_CONTEXT
 * rows (= 530) materialized at any time. No unbounded history array.
 */
async function fetchBoundedSnapshot(
  conversationId: string,
  tenantId: string,
  firstResponseAt: Date | null,
  firstHandoffAt: Date | null,
): Promise<FetchedSnapshot | null> {
  return db.$transaction(
    async (tx) => {
      // --- Resolve the earliest authoritative takeover cutoff ---
      // (inside the snapshot transaction for consistency)
      const candidates: Date[] = []
      if (firstHandoffAt) candidates.push(firstHandoffAt)
      if (firstResponseAt) candidates.push(firstResponseAt)

      // Earliest agent message (authoritative human message timestamp).
      const firstAgentMsg = await tx.message.findFirst({
        where: {
          conversationId,
          tenantId,
          senderType: 'agent',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      })
      if (firstAgentMsg) {
        candidates.push(firstAgentMsg.createdAt)
      }

      if (candidates.length === 0) {
        // No timestamped takeover signal at all. We NEVER fall back to
        // `new Date()` (summary-generation time) — that would include
        // post-assignment messages. Fail closed (no summary).
        return { messages: [], aiCount: 0 }
      }

      // Earliest authoritative signal wins.
      const cutoff = candidates.reduce((earliest, current) =>
        current.getTime() < earliest.getTime() ? current : earliest,
      )

      // --- BLOCKER 1: Bounded retrieval prioritizing LATEST AI answers ---

      // 1. DB-side COUNT of pre-takeover AI messages — O(1) memory.
      const aiCount = await tx.message.count({
        where: {
          conversationId,
          tenantId,
          senderType: 'ai',
          contentType: 'text',
          createdAt: { lt: cutoff },
        },
      })

      if (aiCount === 0) {
        return { messages: [], aiCount: 0 }
      }

      // 2. Fetch the LATEST N AI messages in DESC (createdAt, id) order.
      //    This is the key fix for BLOCKER 1 (latest answer lost): AI rows
      //    are selected by senderType (so row 5,001 is found), and ordered
      //    DESC so the most recent — potentially corrective — AI reply is
      //    retained even when there are 101+ AI replies. The oldest surplus
      //    AI replies are the ones dropped, not the latest.
      const aiMessagesDesc = await tx.message.findMany({
        where: {
          conversationId,
          tenantId,
          senderType: 'ai',
          contentType: 'text',
          createdAt: { lt: cutoff },
        },
        select: selectFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_AI_FETCH,
      })

      if (aiMessagesDesc.length === 0) {
        // Count said >0 but fetch returned 0 — concurrent deletion. Fail safe.
        return { messages: [], aiCount: 0 }
      }

      // 3. Sort the fetched AI messages chronologically (ASC) to define the
      //    "retained AI portion." The pure policy also sorts, but we need
      //    the chronological bounds here to scope the context window.
      const aiMessages = [...aiMessagesDesc].sort((a, b) => {
        const ta = a.createdAt.getTime()
        const tb = b.createdAt.getTime()
        if (ta !== tb) return ta - tb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

      const earliestRetainedAiCreatedAt = aiMessages[0].createdAt

      // 4. Bounded context window: all pre-takeover text messages from the
      //    earliest retained AI to the cutoff. Ordered DESC (latest first)
      //    so the context budget fills from the MOST RECENT context around
      //    the latest AI answers — not exclusively from the earliest
      //    historical messages. Bounded to MAX_CONTEXT_WINDOW rows.
      const contextWindow = await tx.message.findMany({
        where: {
          conversationId,
          tenantId,
          senderType: { in: ['contact', 'ai'] },
          contentType: 'text',
          createdAt: {
            gte: earliestRetainedAiCreatedAt,
            lt: cutoff,
          },
        },
        select: selectFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_CONTEXT_WINDOW,
      })

      // 5. Visitor context immediately before the earliest retained AI
      //    message. Ordered DESC to get the most-recent-before. This
      //    captures what triggered the earliest retained AI reply.
      const preAiContext = await tx.message.findMany({
        where: {
          conversationId,
          tenantId,
          senderType: 'contact',
          contentType: 'text',
          createdAt: { lt: earliestRetainedAiCreatedAt },
        },
        select: selectFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_PRE_AI_CONTEXT,
      })

      // 6. Merge + deduplicate by id. AI messages are always included
      //    (they are the essential facts). Context-window and pre-AI rows
      //    supplement them. Dedup is by id (full-identity conflict detection
      //    happens in the pure policy).
      const merged = new Map<string, HandoffSourceMessage>()
      for (const m of aiMessages) {
        merged.set(m.id, toHandoffMessage(m))
      }
      for (const m of contextWindow) {
        if (!merged.has(m.id)) {
          merged.set(m.id, toHandoffMessage(m))
        }
      }
      for (const m of preAiContext) {
        if (!merged.has(m.id)) {
          merged.set(m.id, toHandoffMessage(m))
        }
      }

      const messages = Array.from(merged.values())

      return { messages, aiCount }
    },
    {
      isolationLevel: 'RepeatableRead' as const,
      timeout: TX_TIMEOUT_MS,
    },
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const selectFields = {
  id: true,
  senderType: true,
  contentType: true,
  content: true,
  createdAt: true,
} as const

function toHandoffMessage(m: {
  id: string
  senderType: string
  contentType: string
  content: unknown
  createdAt: Date
}): HandoffSourceMessage {
  return {
    id: m.id,
    senderType: m.senderType,
    contentType: m.contentType,
    content: m.content,
    createdAt: m.createdAt,
  }
}
