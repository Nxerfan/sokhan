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
 * - Duplicate message IDs with conflicting content → fail closed (null).
 * - Maximum 30 source message IDs and 3,000 characters of summary text.
 * - Per-message extract bounded to 200 characters.
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

/**
 * Strip HTML/script tags and dangerous attributes from untrusted text.
 * The output is safe for React text rendering (never dangerouslySetInnerHTML).
 */
function sanitizeText(raw: string): string {
  // Remove any HTML tags entirely — keep only text content.
  let s = raw.replace(/<[^>]*>/g, '')
  // Remove dangerous protocol prefixes that could appear in stripped text.
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  // Collapse excessive whitespace.
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Extract a safe text string from a message's content field.
 * Returns null if the content is not a valid text message.
 */
function extractText(content: unknown): string | null {
  if (content === null || typeof content !== 'object') return null
  const obj = content as Record<string, unknown>
  if (typeof obj.text !== 'string') return null
  const text = obj.text.trim()
  if (!text) return null
  return sanitizeText(text)
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, grounded summary from conversation messages.
 *
 * Only `contact` and `ai` messages with `contentType: 'text'` and valid
 * text content contribute. Messages are sorted chronologically (createdAt
 * asc, then ID asc for stable tie-breaking).
 *
 * Returns null when:
 * - No valid AI message exists in the source
 * - Duplicate IDs have conflicting content
 * - All messages are invalid/malformed
 *
 * Bounded output:
 * - Maximum 30 source message IDs (most recent first if truncated)
 * - Maximum 3,000 characters of summary text
 * - Per-message extract: 200 characters
 * - `truncated` flag set when any bound is hit
 *
 * Never mutates the input array or its elements.
 */
export function summarizeHandoffMessages(
  messages: ReadonlyArray<HandoffSourceMessage>,
): HandoffSummaryResult | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  // Filter to valid contact/ai text messages with valid dates and content.
  // Track seen IDs for deduplication + conflict detection.
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

    // Deduplicate by ID — detect conflicting content.
    const existing = seenIds.get(msg.id)
    if (existing) {
      // Same ID already seen — compare content.
      const existingText = extractText(existing.content)
      if (existingText !== text) {
        // Conflicting duplicate — fail closed.
        return null
      }
      // Identical duplicate — skip (don't add again).
      continue
    }
    seenIds.set(msg.id, msg)
    valid.push(msg)
  }

  // Must have at least one AI message.
  const hasAi = valid.some((m) => m.senderType === 'ai')
  if (!hasAi) {
    return null
  }

  // Sort chronologically: createdAt asc, then ID asc for stable tie-breaking.
  // Create a shallow copy to avoid mutating the input.
  const sorted = [...valid].sort((a, b) => {
    const timeA = a.createdAt.getTime()
    const timeB = b.createdAt.getTime()
    if (timeA !== timeB) return timeA - timeB
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // Count AI messages.
  const aiMessageCount = sorted.filter((m) => m.senderType === 'ai').length

  // Build summary text and source IDs with bounds.
  let truncated = false
  const sourceMessageIds: string[] = []
  const parts: string[] = []

  // If we have more than MAX_SOURCE_IDS messages, keep the most recent ones
  // that include at least one AI message. Take the last MAX_SOURCE_IDS from
  // the sorted array (most recent).
  let selected = sorted
  if (sorted.length > MAX_SOURCE_IDS) {
    selected = sorted.slice(-MAX_SOURCE_IDS)
    truncated = true
    // Ensure at least one AI message is in the selection.
    if (!selected.some((m) => m.senderType === 'ai')) {
      // Find the last AI message and include it.
      const lastAi = sorted.filter((m) => m.senderType === 'ai').pop()
      if (lastAi) {
        selected = [...selected.slice(0, -1), lastAi]
      }
    }
  }

  for (const msg of selected) {
    const text = extractText(msg.content)
    if (text === null) continue

    sourceMessageIds.push(msg.id)

    // Truncate per-message extract.
    let extract = text
    if (extract.length > MAX_PER_MESSAGE_EXTRACT) {
      extract = extract.slice(0, MAX_PER_MESSAGE_EXTRACT) + '…'
      truncated = true
    }

    // Prefix with sender label.
    const label = msg.senderType === 'ai' ? 'AI' : 'بازدیدکننده'
    parts.push(`${label}: ${extract}`)
  }

  // Join parts and truncate total text.
  let text = parts.join('\n')
  if (text.length > MAX_SUMMARY_TEXT) {
    text = text.slice(0, MAX_SUMMARY_TEXT - 1) + '…'
    truncated = true
  }

  return {
    version: 1,
    text,
    sourceMessageIds,
    aiMessageCount,
    truncated,
  }
}
