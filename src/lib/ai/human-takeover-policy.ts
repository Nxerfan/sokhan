/**
 * AI-Q5 — Human takeover policy (pure, deterministic, no DB).
 *
 * The decision to suppress AI auto-reply is based on SERVER-VERIFIED
 * persisted state, never a client-supplied flag. This module provides
 * the pure policy function that evaluates a `HumanTakeoverState`
 * snapshot.
 *
 * ## Rules
 *
 * AI auto-reply is permitted ONLY when ALL of the following are true:
 *   - `status` is exactly `'open'` (string)
 *   - `assignedUserId` is exactly `null`
 *   - `firstResponseAt` is exactly `null`
 *   - `agentMessageCount` is exactly `0` (a finite nonnegative integer)
 *
 * Any other value — including missing, malformed, coerced, or unknown
 * fields — causes a fail-closed (return false).
 *
 * Never mutates the input state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Server-verified snapshot of a conversation's human-takeover state.
 * All fields must be populated from persisted PostgreSQL records.
 */
export interface HumanTakeoverState {
  /** Conversation status: 'open', 'closed', 'pending', 'resolved', etc. */
  status: string
  /** The user ID of the assigned agent, or null if unassigned. */
  assignedUserId: string | null
  /** Timestamp of the first human (agent) response, or null. */
  firstResponseAt: Date | null
  /** Count of agent messages in the conversation (must be a nonnegative integer). */
  agentMessageCount: number
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Determine whether AI auto-reply is permitted for the given state.
 *
 * Returns `true` ONLY when ALL conditions hold:
 *   - status === 'open'
 *   - assignedUserId === null
 *   - firstResponseAt === null
 *   - agentMessageCount === 0 (strictly integer, finite, nonnegative)
 *
 * Returns `false` (fail closed) for ANY other value, including:
 *   - Missing or malformed fields
 *   - Non-string status, non-null assignedUserId
 *   - Non-Date firstResponseAt (including strings, numbers, undefined)
 *   - Non-integer, negative, NaN, Infinity, or coerced agentMessageCount
 *
 * Never mutates the input.
 */
export function canAiAutoReply(state: HumanTakeoverState): boolean {
  // status must be exactly the string 'open'.
  if (typeof state.status !== 'string' || state.status !== 'open') {
    return false
  }

  // assignedUserId must be exactly null (not undefined, not a string).
  if (state.assignedUserId !== null) {
    return false
  }

  // firstResponseAt must be exactly null (not undefined, not a Date, not a string).
  if (state.firstResponseAt !== null) {
    // Accept only null. A Date object, string, number, or undefined → fail closed.
    // Also reject invalid Date objects (NaN time).
    if (state.firstResponseAt instanceof Date) {
      return false
    }
    // Any other non-null value (string, number, undefined, etc.) → fail closed.
    return false
  }

  // agentMessageCount must be exactly 0 — a finite, nonnegative integer.
  // Reject NaN, Infinity, -0, 0.5, '0', true, undefined, null, etc.
  if (typeof state.agentMessageCount !== 'number') {
    return false
  }
  if (!Number.isFinite(state.agentMessageCount)) {
    return false
  }
  if (!Number.isInteger(state.agentMessageCount)) {
    return false
  }
  if (state.agentMessageCount < 0) {
    return false
  }
  if (state.agentMessageCount !== 0) {
    return false
  }

  // All conditions satisfied — AI auto-reply is permitted.
  return true
}
