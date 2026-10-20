/**
 * Routing rule trigger validator (PR #3 §3 — input hardening).
 *
 * Extracted from `src/app/api/routing-rules/route.ts` so it can be unit-tested
 * directly. The route file imports this hardened version and calls it in BOTH
 * POST (before `db.routingRule.create`) and PATCH (before
 * `db.routingRule.updateMany`).
 *
 * Contract enforced:
 *
 *   trigger:
 *     - MUST be an object (not null, not array, not string/number) → invalid_trigger
 *     - MUST NOT be an array → invalid_trigger
 *
 *   trigger.event:
 *     - REQUIRED (missing/null) → invalid_event
 *     - MUST be a string (not number/object/array) → invalid_event
 *     - MUST be one of VALID_EVENTS → invalid_event
 *
 *   trigger.conditions (when present — `!== undefined`):
 *     - MUST be a non-null object → invalid_conditions
 *     - MUST NOT be an array → invalid_conditions
 *
 *   conditions.keyword (when present):
 *     - MUST be a string → invalid_keyword
 *     - Trimmed value MUST be non-empty → invalid_keyword
 *     - Trimmed length MUST be between 1 and 200 → invalid_keyword
 *
 *   conditions.businessHours (when present):
 *     - MUST be a non-null, non-array object → invalid_business_hours
 *     - start REQUIRED (missing/null) → invalid_business_hours
 *     - end REQUIRED (missing/null) → invalid_business_hours
 *     - Number.isFinite(start) AND Number.isFinite(end) → invalid_business_hours
 *       (rejects NaN and Infinity)
 *     - Number.isInteger(start) AND Number.isInteger(end) → invalid_business_hours
 *       (rejects fractional values like 9.5)
 *     - start ∈ [0,23] AND end ∈ [0,23] → invalid_business_hours
 *
 * This is a SAVE-TIME guard: better to reject a misconfigured rule up-front
 * than to discover at execution time that the routing engine silently no-ops
 * (the routing engine also re-validates at execution time as defense-in-depth).
 *
 * NOTE: This function is PURE — it touches no database, no tenant context,
 * no async state. It only inspects the shape of the supplied trigger object.
 *
 * The `trigger: any` parameter type is preserved from the original
 * module-private signature in `route.ts` so the extracted function is a
 * drop-in replacement.
 */

/** Supported routing-rule trigger events. */
export const VALID_EVENTS = ['conversation_created', 'message_received'] as const

export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Validate a routing rule trigger.
 *
 * @param trigger - raw `body.trigger` value from a POST/PATCH request
 * @returns `{ ok: true }` on success, `{ ok: false, error: '<code>' }` on
 *          failure, where `<code>` is one of:
 *          `invalid_trigger`, `invalid_event`, `invalid_conditions`,
 *          `invalid_keyword`, `invalid_business_hours`.
 */
export function validateRuleTrigger(trigger: any): ValidationResult {
  // --- trigger MUST be a non-array object ---
  if (trigger === null || typeof trigger !== 'object') return { ok: false, error: 'invalid_trigger' }
  if (Array.isArray(trigger)) return { ok: false, error: 'invalid_trigger' }

  // --- trigger.event: REQUIRED, MUST be a string, MUST be supported ---
  // Treat both `undefined` and `null` as "missing" → invalid_event.
  if (trigger.event === undefined || trigger.event === null) return { ok: false, error: 'invalid_event' }
  if (typeof trigger.event !== 'string') return { ok: false, error: 'invalid_event' }
  if (!(VALID_EVENTS as readonly string[]).includes(trigger.event)) {
    return { ok: false, error: 'invalid_event' }
  }

  // --- trigger.conditions (when present — `!== undefined`) ---
  if (trigger.conditions !== undefined) {
    const conditions = trigger.conditions
    // MUST be a non-null object, MUST NOT be an array.
    if (conditions === null || typeof conditions !== 'object') return { ok: false, error: 'invalid_conditions' }
    if (Array.isArray(conditions)) return { ok: false, error: 'invalid_conditions' }

    // --- conditions.keyword (when present) ---
    if (conditions.keyword !== undefined) {
      const keyword = conditions.keyword
      if (typeof keyword !== 'string') return { ok: false, error: 'invalid_keyword' }
      const trimmed = keyword.trim()
      if (trimmed.length === 0) return { ok: false, error: 'invalid_keyword' }
      if (trimmed.length > 200) return { ok: false, error: 'invalid_keyword' }
    }

    // --- conditions.businessHours (when present) ---
    if (conditions.businessHours !== undefined) {
      const bh = conditions.businessHours
      // MUST be a non-null, non-array object.
      if (bh === null || typeof bh !== 'object') return { ok: false, error: 'invalid_business_hours' }
      if (Array.isArray(bh)) return { ok: false, error: 'invalid_business_hours' }
      // start + end both REQUIRED (missing/null rejected).
      if (bh.start === undefined || bh.start === null) return { ok: false, error: 'invalid_business_hours' }
      if (bh.end === undefined || bh.end === null) return { ok: false, error: 'invalid_business_hours' }
      // Reject NaN and Infinity (Number.isFinite is false for both).
      if (!Number.isFinite(bh.start) || !Number.isFinite(bh.end)) {
        return { ok: false, error: 'invalid_business_hours' }
      }
      // Reject fractional values like 9.5.
      if (!Number.isInteger(bh.start) || !Number.isInteger(bh.end)) {
        return { ok: false, error: 'invalid_business_hours' }
      }
      // Valid 24h hour range.
      if (bh.start < 0 || bh.start > 23 || bh.end < 0 || bh.end > 23) {
        return { ok: false, error: 'invalid_business_hours' }
      }
    }
  }

  return { ok: true }
}
