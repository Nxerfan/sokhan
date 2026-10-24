/**
 * Deterministic business-hours decision helper.
 *
 * Extracted from the routing engine (PR #13 stability audit) so the
 * business-hours routing decision can be unit-tested and behaviorally proven
 * WITHOUT depending on wall-clock luck. The production engine path still
 * derives the current hour from `new Date()`, but tests inject a
 * deterministic hour through `evaluateRoutingRules`'s optional `getHour`
 * argument (see `src/lib/routing-engine.ts`).
 *
 * CONTRACT (documented — do NOT change without updating the UI + tests):
 *   - A businessHours condition matches when  start <= hour < end
 *   - `start` is INCLUSIVE, `end` is EXCLUSIVE (half-open interval [start, end))
 *   - hours are 24h integers in [0, 23] (enforced upstream by
 *     `validateRuleTrigger` in `src/lib/routing-rules-validation.ts`)
 *   - `start === end` therefore matches NOTHING (zero-width window) — this
 *     is intentional and documented, not a bug.
 *   - `tz` is accepted for forward-compatibility but NOT honoured by the
 *     current engine (the engine reasons in the server's local hour). This
 *     is a known limitation, truthfully documented in the audit.
 *
 * Boundary examples (for a rule with start=9, end=17):
 *   hour=8  → NOT within (8 < 9)
 *   hour=9  → WITHIN     (9 >= 9 && 9 < 17)   ← start inclusive
 *   hour=16 → WITHIN     (16 >= 9 && 16 < 17)
 *   hour=17 → NOT within (17 < 17 is false)    ← end exclusive
 *   hour=23 → NOT within
 */

export interface BusinessHours {
  start: number
  end: number
  tz?: string
}

/**
 * Pure decision: is `hour` within the configured business-hours window?
 *
 * Returns true iff `start <= hour < end`. Performs NO I/O and reads NO
 * wall-clock — fully deterministic. Used by the routing engine's
 * `matchConditions` and covered by `tests/unit/routing-hours.test.ts`.
 */
export function isWithinBusinessHours(bh: BusinessHours, hour: number): boolean {
  return hour >= bh.start && hour < bh.end
}

/**
 * Derive the current 24h hour (0-23) from a Date. Defaults to `new Date()`.
 * Tests inject a fixed Date or pass a custom `getHour` to the engine.
 */
export function currentHour(now: Date = new Date()): number {
  return now.getHours()
}
