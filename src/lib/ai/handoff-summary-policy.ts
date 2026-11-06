/**
 * AI-Q6 — Deterministic Human Handoff Summary Policy (pure, no DB).
 *
 * This module produces a read-only, fact-grounded summary of the AI-handled
 * portion of a conversation for human agents at takeover time.
 *
 * It is NOT LLM summarization. It does not call any paid model. It does not
 * create AI messages or consume AI quota. The summary is metadata for human
 * agents — never displayed to visitors.
 *
 * ## Safety guarantees
 *
 * - Only persisted `contact` and `ai` text messages contribute.
 * - Agent, system, file, and malformed messages are excluded.
 * - Source text is treated as untrusted — HTML/script tags are stripped.
 * - No hallucinated prices, availability, commitments, or recommendations.
 * - Duplicate message IDs with ANY conflicting field → fail closed (null).
 * - Maximum 30 source message IDs and 3,000 characters of summary text.
 * - Per-message extract bounded to 200 characters.
 * - Every source ID in the output has visible evidence in the summary text.
 * - Never mutates source messages or input arrays.
 * - Deterministic chronological ordering with stable ID tie-breaking.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandoffSourceMessage {
  id: string
  senderType: string
  contentType: string
  content: unknown
  createdAt: Date
}

export interface HandoffSummaryResult {
  version: 1
  text: string
  sourceMessageIds: string[]
  aiMessageCount: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SOURCE_IDS = 30
const MAX_SUMMARY_TEXT = 3000
const MAX_PER_MESSAGE_EXTRACT = 200
const ELIGIBLE_PLANS = new Set(['pro', 'max', 'self-hosted'])

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Determine whether a handoff summary should be generated.
 *
 * Returns true ONLY when:
 * - planSlug is exactly 'pro', 'max', or 'self-hosted'
 * - hasTakeover is exactly true (boolean)
 * - aiCount is a finite, positive integer (>= 1)
 *
 * Returns false for free, unknown, coerced, or invalid values.
 */
export function handoffSummaryEligible(
  planSlug: string,
  hasTakeover: boolean,
  aiCount: number,
): boolean {
  if (typeof planSlug !== 'string' || !ELIGIBLE_PLANS.has(planSlug)) {
    return false
  }
  if (hasTakeover !== true) {
    return false
  }
  if (typeof aiCount !== 'number' || !Number.isFinite(aiCount)) {
    return false
  }
  if (!Number.isInteger(aiCount) || aiCount < 1) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function sanitizeText(raw: string): string {
  let s = raw.replace(/<[^>]*>/g, '')
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function extractText(content: unknown): string | null {
  if (content === null || typeof content !== 'object') return null
  const obj = content as Record<string, unknown>
  if (typeof obj.text !== 'string') return null
  const text = obj.text.trim()
  if (!text) return null
  return sanitizeText(text)
}

// ---------------------------------------------------------------------------
// Deterministic JSON structural comparison (BLOCKER 2 — full raw identity)
// ---------------------------------------------------------------------------

/**
 * Produce a canonical, deterministic JSON string from an unknown value.
 *
 * Object keys are sorted lexicographically at every depth. Arrays preserve
 * their element order (arrays are ordered sequences, not sets). This makes
 * the stringification stable regardless of key insertion order, so two
 * structurally identical objects produce the same string even if their
 * properties were defined in a different order.
 *
 * Used to compare the FULL raw `content` JSON of two messages — not just
 * their sanitized visible text. This catches conflicts in factual metadata
 * (source, verification flags, HTML tags) that sanitize to the same visible
 * string but represent different persisted records.
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    // Distinguish NaN/Infinity from real numbers — they are not valid JSON.
    if (!Number.isFinite(value)) return 'null'
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
    return '{' + parts.join(',') + '}'
  }
  // Functions, symbols, undefined → not part of persisted JSON content.
  return 'null'
}

// ---------------------------------------------------------------------------
// Full raw identity comparison (BLOCKER 1 + BLOCKER 2)
// ---------------------------------------------------------------------------

/**
 * Compare ALL factual fields of two messages with the same ID, including
 * the COMPLETE original raw JSON content — not only the rendered/sanitized
 * text.
 *
 * Returns true if they are genuinely identical (safe to deduplicate).
 * Returns false if ANY field differs (contradictory duplicate → fail closed).
 *
 * Compared fields:
 *   - senderType
 *   - contentType
 *   - createdAt (exact millisecond timestamp)
 *   - content (full raw JSON, via deterministic stable stringification)
 *
 * BLOCKER 2: Comparing only sanitized visible text is insufficient. Two
 * records with the same ID and same visible text but different raw HTML
 * tags (e.g. `<b>text</b>` vs `text`) or different factual metadata (e.g.
 * `source:'product'` vs `source:'faq'`, `verified:true` vs `verified:false`)
 * represent different persisted records and must fail closed.
 */
function messagesIdentical(a: HandoffSourceMessage, b: HandoffSourceMessage): boolean {
  if (a.senderType !== b.senderType) return false
  if (a.contentType !== b.contentType) return false
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return false
  // Full raw JSON structural comparison — not just sanitized text.
  return stableStringify(a.content) === stableStringify(b.content)
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, grounded summary from conversation messages.
 *
 * BLOCKER 1: Duplicate IDs compared across ALL factual fields
 *   (senderType, contentType, createdAt, content). Any conflict → null.
 *
 * BLOCKER 2: Source IDs and excerpts built together — only IDs whose
 *   evidence is genuinely in the final text are retained.
 *
 * BLOCKER 3: Bounded subset selected first, then sorted chronologically
 *   by (createdAt, id) before rendering. Deterministic regardless of
 *   input order. When an older AI reply is retained from beyond the
 *   30-message window, it appears in chronological position.
 *
 * Returns null when no valid AI message exists, or duplicate IDs conflict.
 */
export function summarizeHandoffMessages(
  messages: ReadonlyArray<HandoffSourceMessage>,
): HandoffSummaryResult | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  // Filter + deduplicate with full identity comparison (BLOCKER 1).
  const seenIds = new Map<string, HandoffSourceMessage>()
  const valid: HandoffSourceMessage[] = []

  for (const msg of messages) {
    if (msg === null || typeof msg !== 'object') continue
    if (typeof msg.id !== 'string' || !msg.id) continue
    if (typeof msg.senderType !== 'string') continue
    if (typeof msg.contentType !== 'string') continue
    if (msg.contentType !== 'text') continue
    if (msg.senderType !== 'contact' && msg.senderType !== 'ai') continue
    if (!(msg.createdAt instanceof Date) || isNaN(msg.createdAt.getTime())) continue
    const text = extractText(msg.content)
    if (text === null) continue

    const existing = seenIds.get(msg.id)
    if (existing) {
      // BLOCKER 1: Compare ALL factual fields, not just text.
      if (!messagesIdentical(existing, msg)) {
        return null // Conflicting duplicate — fail closed.
      }
      continue // Identical duplicate — skip.
    }
    seenIds.set(msg.id, msg)
    valid.push(msg)
  }

  // Must have at least one AI message.
  const hasAi = valid.some((m) => m.senderType === 'ai')
  if (!hasAi) {
    return null
  }

  // Sort chronologically FIRST: (createdAt asc, id asc).
  const sorted = [...valid].sort((a, b) => {
    const timeA = a.createdAt.getTime()
    const timeB = b.createdAt.getTime()
    if (timeA !== timeB) return timeA - timeB
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const aiMessageCount = sorted.filter((m) => m.senderType === 'ai').length

  // BLOCKER 3: Select a bounded subset that includes AI context.
  // If we have > MAX_SOURCE_IDS messages, select a window that:
  // 1. Contains at least one AI message.
  // 2. Is bounded to MAX_SOURCE_IDS entries.
  // 3. Is then sorted chronologically before rendering.
  let selected: HandoffSourceMessage[]
  let truncated = false

  if (sorted.length <= MAX_SOURCE_IDS) {
    selected = sorted
  } else {
    truncated = true
    // Find the last AI message index.
    let lastAiIdx = -1
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].senderType === 'ai') {
        lastAiIdx = i
        break
      }
    }
    if (lastAiIdx >= 0) {
      // Take a window that includes the last AI message and surrounding context.
      // Center the window around the AI message if possible.
      const halfWindow = Math.floor(MAX_SOURCE_IDS / 2)
      let start = Math.max(0, lastAiIdx - halfWindow)
      const end = Math.min(sorted.length, start + MAX_SOURCE_IDS)
      // Adjust start if end hit the limit.
      if (end - start < MAX_SOURCE_IDS) {
        start = Math.max(0, end - MAX_SOURCE_IDS)
      }
      selected = sorted.slice(start, end)
      // Ensure at least one AI message is in the selection.
      if (!selected.some((m) => m.senderType === 'ai')) {
        // Force-include the last AI message.
        selected = [...selected.slice(0, -1), sorted[lastAiIdx]]
      }
    } else {
      // No AI message found (shouldn't happen since hasAi is true).
      selected = sorted.slice(0, MAX_SOURCE_IDS)
    }
  }

  // BLOCKER 2: Build source IDs and excerpts TOGETHER.
  // Only retain IDs whose evidence is genuinely included in the final text.
  // We build parts incrementally and stop when we hit the text limit.
  // Source IDs are only added for parts that make it into the final text.
  //
  // IMPORTANT: We must ensure at least one AI message is included in the
  // text. If visitor messages are very long and fill the text limit before
  // an AI message is reached, we reserve space for the AI message by
  // processing AI messages first in the text budget.
  const sourceMessageIds: string[] = []
  const parts: string[] = []
  let currentLength = 0

  // Helper to build a part string for a message.
  function buildPart(msg: HandoffSourceMessage): string {
    const text = extractText(msg.content)
    if (text === null) return ''
    let extract = text
    if (extract.length > MAX_PER_MESSAGE_EXTRACT) {
      extract = extract.slice(0, MAX_PER_MESSAGE_EXTRACT) + '…'
      truncated = true // Set truncated when per-message extract is cut.
    }
    const label = msg.senderType === 'ai' ? 'AI' : 'بازدیدکننده'
    return `${label}: ${extract}`
  }

  // Find the first AI message in the selection (chronologically earliest).
  const firstAiInSelection = selected.find((m) => m.senderType === 'ai')

  // First pass: build parts in chronological order, but ensure the AI
  // message gets included. If the AI message hasn't been added yet when
  // we're near the text limit, we force-include it.
  let aiIncluded = false

  for (const msg of selected) {
    const part = buildPart(msg)
    if (!part) continue

    const separator = parts.length > 0 ? 1 : 0

    // Check if this is an AI message.
    if (msg.senderType === 'ai') {
      aiIncluded = true
    }

    // If this is NOT an AI message and we haven't included an AI message yet,
    // check if adding this part would leave room for an AI message.
    if (msg.senderType !== 'ai' && !aiIncluded && firstAiInSelection) {
      const aiPart = buildPart(firstAiInSelection)
      // Reserve space for the AI message.
      if (currentLength + separator + part.length + 1 + aiPart.length > MAX_SUMMARY_TEXT) {
        // Skip this visitor message — we need room for the AI message.
        truncated = true
        continue
      }
    }

    // Check if adding this part would exceed the text limit.
    if (currentLength + separator + part.length > MAX_SUMMARY_TEXT) {
      truncated = true
      // If this is an AI message and no AI has been included yet, force it.
      if (msg.senderType === 'ai' && !aiIncluded) {
        // Remove visitor messages from the end to make room.
        while (parts.length > 0 && currentLength + 1 + part.length > MAX_SUMMARY_TEXT) {
          const removed = parts.pop()!
          const removedId = sourceMessageIds.pop()!
          currentLength -= removed.length + 1
          truncated = true
        }
        if (currentLength + (parts.length > 0 ? 1 : 0) + part.length <= MAX_SUMMARY_TEXT) {
          parts.push(part)
          currentLength += (parts.length > 1 ? 1 : 0) + part.length
          sourceMessageIds.push(msg.id)
          aiIncluded = true
        }
      }
      break
    }

    parts.push(part)
    currentLength += separator + part.length
    sourceMessageIds.push(msg.id)
  }

  // Join parts.
  let text = parts.join('\n')

  // If text is still over the limit (edge case), truncate.
  if (text.length > MAX_SUMMARY_TEXT) {
    text = text.slice(0, MAX_SUMMARY_TEXT - 1) + '…'
    truncated = true
    // BLOCKER 2: Remove source IDs whose evidence was truncated away.
    // Re-check which IDs still have visible evidence.
    const visibleIds: string[] = []
    for (const id of sourceMessageIds) {
      const msg = selected.find((m) => m.id === id)
      if (!msg) continue
      const msgText = extractText(msg.content)
      if (msgText && text.includes(sanitizeText(msgText).slice(0, Math.min(msgText.length, 20)))) {
        visibleIds.push(id)
      }
    }
    // Only keep IDs with visible evidence.
    while (sourceMessageIds.length > visibleIds.length) {
      sourceMessageIds.pop()
    }
  }

  return {
    version: 1,
    text,
    sourceMessageIds,
    aiMessageCount,
    truncated,
  }
}
