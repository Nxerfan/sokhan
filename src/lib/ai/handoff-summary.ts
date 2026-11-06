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
 *   2. Fetches the LATEST N AI messages in DESC (createdAt, id) order
 *      (take MAX_AI_FETCH). Prioritizes the most recent corrective answers.
 *   3. Fetches a bounded context window ordered DESC (latest first).
 *   Memory is bounded to at most MAX_AI_FETCH + MAX_CONTEXT_WINDOW +
 *   MAX_PRE_AI_CONTEXT rows (= 530). No unbounded history array.
 *
 * ## BLOCKER 2 — earliest authoritative takeover cutoff
 *
 * The cutoff is `min(firstHandoffAt, firstResponseAt, firstAgentMsg.createdAt)`.
 * `firstHandoffAt` is persisted atomically by a PostgreSQL BEFORE UPDATE
 * trigger on the FIRST assignment (NULL → non-NULL). Reassignment never
 * overwrites it. We NEVER fall back to `new Date()` (summary-generation time).
 *
 * ## Exact handoff boundary — txid_snapshot (SERIAL ≠ commit order)
 *
 * PostgreSQL SERIAL defaults allocate nextval BEFORE BEFORE INSERT triggers
 * and before the foreign-key check. A writer can allocate a lower seq but
 * remain uncommitted, while another writer commits a higher seq. The seq
 * boundary alone is insufficient.
 *
 * The PRIMARY boundary is `Conversation.handoffSnapshot` — a
 * `txid_current_snapshot()::text` captured atomically during the first
 * takeover (after a FOR UPDATE lock upgrade that blocks on pending FK
 * locks). When filtering messages, `txid_visible_in_snapshot(xmin::text::bigint, snapshot::txid_snapshot)`
 * returns true ONLY for messages whose inserting transaction was committed
 * (visible) at the snapshot time — regardless of SERIAL allocation order.
 *
 * Message inserts are NOT locked. Concurrent uncommitted writers are allowed.
 *
 * FALLBACK: `seq <= handoffSourceSeq` (for legacy conversations with seq but
 * no snapshot) or `createdAt < cutoff` (strict lt, fail closed for same-ms).
 *
 * ## BLOCKER 3 & 4 — effective plan via shared resolver
 *
 * Plan eligibility uses `resolveTenantPlanSlug` (from payments/gating) — the
 * SAME authoritative resolver used by AI-Q2 billing.
 *
 * ## Consistency — one defensible pre-handoff snapshot
 *
 * All reads run inside a single REPEATABLE READ transaction.
 */

import { db, getCurrentTenantId } from '@/lib/db'
import {
  handoffSummaryEligible,
  summarizeHandoffMessages,
  type HandoffSourceMessage,
} from './handoff-summary-policy'
import { canAutoReplyToConversation } from './human-takeover'
import { resolveTenantPlanSlug } from '@/lib/payments/gating'
import { Prisma } from '@prisma/client'

// ---------------------------------------------------------------------------
// Resource bounds — explicit and fail-closed.
// ---------------------------------------------------------------------------

const MAX_AI_FETCH = 100
const MAX_CONTEXT_WINDOW = 400
const MAX_PRE_AI_CONTEXT = 30
const TX_TIMEOUT_MS = 10000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FetchedSnapshot {
  messages: HandoffSourceMessage[]
  aiCount: number
}

interface RawMessage {
  id: string
  senderType: string
  contentType: string
  content: unknown
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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

  // 1. Idempotent: if a summary already exists, return it.
  const existing = await db.conversationHandoffSummary.findUnique({
    where: { tenantId_conversationId: { tenantId, conversationId } },
    select: { summaryText: true },
  })
  if (existing) {
    return existing.summaryText
  }

  // 2. Q5 guard: human takeover must have occurred.
  const aiEligible = await canAutoReplyToConversation(conversationId)
  if (aiEligible) {
    return null
  }

  // 3. Validate tenant ownership + read persisted takeover signals.
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      tenantId: true,
      status: true,
      assignedUserId: true,
      firstResponseAt: true,
      firstHandoffAt: true,
      handoffSourceSeq: true,
      handoffSnapshot: true,
    },
  })
  if (!conversation || conversation.tenantId !== tenantId) {
    return null
  }

  // 4. Effective plan via the shared authoritative resolver.
  const effectivePlanSlug = await resolveTenantPlanSlug(tenantId)

  // 5. Fetch bounded snapshot.
  const snapshot = await fetchBoundedSnapshot(
    conversationId,
    tenantId,
    conversation.firstResponseAt,
    conversation.firstHandoffAt,
    conversation.handoffSourceSeq,
    conversation.handoffSnapshot,
  )
  if (!snapshot || snapshot.aiCount === 0) {
    return null
  }

  // 6. Check eligibility.
  if (!handoffSummaryEligible(effectivePlanSlug, true, snapshot.aiCount)) {
    return null
  }

  // 7. Generate the deterministic summary (pure policy, no DB/LLM).
  const summary = summarizeHandoffMessages(snapshot.messages)
  if (!summary) {
    return null
  }

  // 8. Persist with PostgreSQL UNIQUE constraint.
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

// ---------------------------------------------------------------------------
// Bounded retrieval — latest AI answers + snapshot commit-order boundary
// ---------------------------------------------------------------------------

async function fetchBoundedSnapshot(
  conversationId: string,
  tenantId: string,
  firstResponseAt: Date | null,
  firstHandoffAt: Date | null,
  handoffSourceSeq: number | null,
  handoffSnapshot: string | null,
): Promise<FetchedSnapshot | null> {
  return db.$transaction(
    async (tx) => {
      // --- Resolve the earliest authoritative takeover cutoff ---
      const candidates: Date[] = []
      if (firstHandoffAt) candidates.push(firstHandoffAt)
      if (firstResponseAt) candidates.push(firstResponseAt)

      const firstAgentMsg = await tx.message.findFirst({
        where: { conversationId, tenantId, senderType: 'agent' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      })
      if (firstAgentMsg) {
        candidates.push(firstAgentMsg.createdAt)
      }

      if (candidates.length === 0) {
        return { messages: [], aiCount: 0 }
      }

      const cutoff = candidates.reduce((earliest, current) =>
        current.getTime() < earliest.getTime() ? current : earliest,
      )

      // --- Boundary selection: snapshot > seq > timestamp ---
      const useSnapshot = !!handoffSnapshot
      const useSeqBoundary = !useSnapshot && handoffSourceSeq !== null && handoffSourceSeq !== undefined

      // Raw SQL visibility condition for the snapshot boundary.
      // txid_visible_in_snapshot(xmin::text::bigint, snapshot::txid_snapshot) returns true
      // iff the message's inserting transaction was committed at snapshot time.
      // xmin is a 32-bit xid system column; casting via text::bigint gives the
      // raw value which txid_visible_in_snapshot accepts (epoch 0 in practice).
      const visibilityCondition = useSnapshot
        ? Prisma.sql`AND txid_visible_in_snapshot(m.xmin::text::bigint, ${handoffSnapshot}::txid_snapshot)`
        : Prisma.empty

      // Prisma where filters for non-snapshot boundaries.
      const seqFilter = useSeqBoundary ? { seq: { lte: handoffSourceSeq as number } } : {}
      const timestampFilter = (!useSnapshot && !useSeqBoundary) ? { createdAt: { lt: cutoff } } : {}

      // 1. COUNT pre-takeover AI messages.
      let aiCount: number
      if (useSnapshot) {
        const countResult = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM "Message" m
          WHERE m."conversationId" = ${conversationId}
            AND m."tenantId" = ${tenantId}
            AND m."senderType" = 'ai'
            AND m."contentType" = 'text'
            ${visibilityCondition}
        `
        aiCount = Number(countResult[0]?.count ?? 0)
      } else {
        aiCount = await tx.message.count({
          where: {
            conversationId, tenantId,
            senderType: 'ai',
            contentType: 'text',
            ...seqFilter,
            ...timestampFilter,
          },
        })
      }

      if (aiCount === 0) {
        return { messages: [], aiCount: 0 }
      }

      // 2. Fetch LATEST N AI messages DESC.
      let aiMessagesDesc: RawMessage[]
      if (useSnapshot) {
        aiMessagesDesc = await tx.$queryRaw<RawMessage[]>`
          SELECT m."id", m."senderType", m."contentType", m."content", m."createdAt"
          FROM "Message" m
          WHERE m."conversationId" = ${conversationId}
            AND m."tenantId" = ${tenantId}
            AND m."senderType" = 'ai'
            AND m."contentType" = 'text'
            ${visibilityCondition}
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT ${MAX_AI_FETCH}
        `
      } else {
        aiMessagesDesc = await tx.message.findMany({
          where: {
            conversationId, tenantId,
            senderType: 'ai',
            contentType: 'text',
            ...seqFilter,
            ...timestampFilter,
          },
          select: selectFields,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_AI_FETCH,
        }) as RawMessage[]
      }

      if (aiMessagesDesc.length === 0) {
        return { messages: [], aiCount: 0 }
      }

      // 3. Sort ASC to define the retained AI portion.
      const aiMessages = [...aiMessagesDesc].sort((a, b) => {
        const ta = a.createdAt.getTime()
        const tb = b.createdAt.getTime()
        if (ta !== tb) return ta - tb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

      const earliestRetainedAiCreatedAt = aiMessages[0].createdAt

      // 4. Context window DESC.
      let contextWindow: RawMessage[]
      if (useSnapshot) {
        contextWindow = await tx.$queryRaw<RawMessage[]>`
          SELECT m."id", m."senderType", m."contentType", m."content", m."createdAt"
          FROM "Message" m
          WHERE m."conversationId" = ${conversationId}
            AND m."tenantId" = ${tenantId}
            AND m."senderType" IN ('contact', 'ai')
            AND m."contentType" = 'text'
            AND m."createdAt" >= ${earliestRetainedAiCreatedAt}
            ${visibilityCondition}
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT ${MAX_CONTEXT_WINDOW}
        `
      } else {
        contextWindow = await tx.message.findMany({
          where: {
            conversationId, tenantId,
            senderType: { in: ['contact', 'ai'] },
            contentType: 'text',
            ...seqFilter,
            createdAt: {
              gte: earliestRetainedAiCreatedAt,
              ...(useSeqBoundary ? {} : { lt: cutoff }),
            },
          },
          select: selectFields,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_CONTEXT_WINDOW,
        }) as RawMessage[]
      }

      // 5. Pre-AI visitor context DESC.
      let preAiContext: RawMessage[]
      if (useSnapshot) {
        preAiContext = await tx.$queryRaw<RawMessage[]>`
          SELECT m."id", m."senderType", m."contentType", m."content", m."createdAt"
          FROM "Message" m
          WHERE m."conversationId" = ${conversationId}
            AND m."tenantId" = ${tenantId}
            AND m."senderType" = 'contact'
            AND m."contentType" = 'text'
            AND m."createdAt" < ${earliestRetainedAiCreatedAt}
            ${visibilityCondition}
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT ${MAX_PRE_AI_CONTEXT}
        `
      } else {
        preAiContext = await tx.message.findMany({
          where: {
            conversationId, tenantId,
            senderType: 'contact',
            contentType: 'text',
            ...seqFilter,
            createdAt: { lt: earliestRetainedAiCreatedAt },
          },
          select: selectFields,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_PRE_AI_CONTEXT,
        }) as RawMessage[]
      }

      // 6. Merge + deduplicate by id.
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

function toHandoffMessage(m: RawMessage): HandoffSourceMessage {
  return {
    id: m.id,
    senderType: m.senderType,
    contentType: m.contentType,
    content: m.content,
    createdAt: m.createdAt,
  }
}
