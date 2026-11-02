/**
 * Quick Replies types + validation helpers — standalone module.
 *
 * Mirrors the launcher-types.ts / attention-types.ts separation pattern.
 * Pure TS — no Prisma, no Next.js, no browser dependencies.
 *
 * Feature 6 — Quick Replies.
 *
 * Plan limits:
 *   - Free: max 2 quick reply buttons.
 *   - Pro / Max / Self-hosted: max 10.
 *   - Unknown: fail closed (0).
 *
 * Text rules:
 *   - 1–80 Unicode code points per item.
 *   - No blank, whitespace-padded, or multiline labels.
 *   - No case-insensitive duplicates within the list.
 */

/** Maximum quick replies for the Free plan. */
export const FREE_QUICK_REPLIES_MAX = 2

/** Maximum quick replies for paid plans (Pro / Max / Self-hosted). */
export const PAID_QUICK_REPLIES_MAX = 10

/** Maximum text length per item in Unicode code points. */
export const QUICK_REPLY_MAX_CODE_POINTS = 80

/**
 * Check if a plan's quick-replies max is "advanced" (paid) — i.e., greater
 * than the Free max. Used by the merge + resolver to determine whether
 * paidItems should be cleared (Pro explicit save) or restored (upgrade).
 */
export function isAdvancedQuickRepliesPlan(max: number): boolean {
  return max > FREE_QUICK_REPLIES_MAX
}

/**
 * Validate a single quick-reply label. Returns the label string if valid,
 * or null if invalid. Does NOT trim — whitespace-padded labels are rejected.
 *
 * Rules:
 *   - Must be a string.
 *   - Must not be blank (whitespace-only).
 *   - Must not be whitespace-padded (leading or trailing whitespace).
 *   - Must not contain newlines (single line only).
 *   - Must be 1–80 Unicode code points.
 */
export function normalizeQuickReplyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Reject blank (whitespace-only).
  if (value.trim() === '') return null
  // Reject whitespace-padded (leading or trailing whitespace).
  if (value !== value.trim()) return null
  // Reject multiline labels (no newlines allowed).
  if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) return null
  const codePoints = Array.from(value).length
  if (codePoints < 1 || codePoints > QUICK_REPLY_MAX_CODE_POINTS) return null
  return value
}

/**
 * Case-insensitive duplicate check. Returns true if the list contains
 * case-insensitive duplicates. Each item is pre-normalized.
 */
export function hasCaseInsensitiveDuplicate(items: string[]): boolean {
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/**
 * Pure visibility policy for Quick Replies. Returns true if the suggestion
 * buttons should be visible given the current runtime state.
 *
 * All five conditions must hold:
 *   1. The panel is open.
 *   2. The visitor is authorized (valid token — identity bootstrap completed).
 *      The token is cleared on authorization recovery/revocation/policy-change.
 *   3. Configured items exist.
 *   4. No previously persisted visitor message exists.
 *
 * This mirrors the runtime `updateQuickReplies()` logic and is independently
 * testable. The runtime passes `authorized = !!state.token && !!state.conversationId`.
 */
export function shouldShowQuickReplies(opts: {
  panelOpen: boolean
  authorized: boolean
  itemsCount: number
  hasVisitorMessage: boolean
}): boolean {
  return (
    opts.panelOpen &&
    opts.authorized &&
    opts.itemsCount > 0 &&
    !opts.hasVisitorMessage
  )
}

/**
 * Whether the Quick Reply buttons should be DISABLED (not removed) while a
 * message send is in-flight. Returns true when there is a pending optimistic
 * visitor message or an explicit in-flight flag. The buttons remain visible
 * but non-interactive to prevent duplicate sends. On failure, the pending
 * state clears and the buttons are re-enabled.
 */
export function shouldDisableQuickReplies(opts: {
  hasPendingVisitorMessage: boolean
  inFlight: boolean
}): boolean {
  return opts.hasPendingVisitorMessage || opts.inFlight
}
