/// <reference types="bun-types" />
/**
 * Unit tests for the deterministic business-hours decision helper
 * (`src/lib/routing-hours.ts`) — extracted from the routing engine in the
 * PR #13 stability audit so business-hours routing can be proven WITHOUT
 * depending on wall-clock luck.
 *
 * CONTRACT under test (documented in the helper):
 *   - matches when  start <= hour < end   (half-open interval [start, end))
 *   - start is INCLUSIVE, end is EXCLUSIVE
 *   - start === end matches NOTHING (zero-width window)
 *   - `currentHour()` derives the local hour from a Date (default now)
 *
 * Invalid businessHours (non-integer, out of [0,23], missing start/end) are
 * REJECTED upstream by `validateRuleTrigger` — that rejection is covered by
 * `tests/unit/routing-rules.test.ts`. This suite covers the DECISION helper
 * once a valid window reaches the engine.
 */

import { test, expect, describe } from 'bun:test'
import { isWithinBusinessHours, currentHour } from '@/lib/routing-hours'

describe('isWithinBusinessHours — half-open interval [start, end)', () => {
  describe('typical 9–17 window', () => {
    const bh = { start: 9, end: 17 }

    test('hour before start → NOT within', () => {
      expect(isWithinBusinessHours(bh, 0)).toBe(false)
      expect(isWithinBusinessHours(bh, 8)).toBe(false)
    })

    test('hour === start (9) → WITHIN (start inclusive)', () => {
      expect(isWithinBusinessHours(bh, 9)).toBe(true)
    })

    test('hours strictly inside the window → WITHIN', () => {
      expect(isWithinBusinessHours(bh, 10)).toBe(true)
      expect(isWithinBusinessHours(bh, 15)).toBe(true)
      expect(isWithinBusinessHours(bh, 16)).toBe(true)
    })

    test('hour === end (17) → NOT within (end exclusive)', () => {
      expect(isWithinBusinessHours(bh, 17)).toBe(false)
    })

    test('hours after end → NOT within', () => {
      expect(isWithinBusinessHours(bh, 18)).toBe(false)
      expect(isWithinBusinessHours(bh, 23)).toBe(false)
    })
  })

  describe('boundary semantics', () => {
    test('start inclusive at hour 0 (window 0–1)', () => {
      expect(isWithinBusinessHours({ start: 0, end: 1 }, 0)).toBe(true)
      expect(isWithinBusinessHours({ start: 0, end: 1 }, 1)).toBe(false)
    })

    test('end exclusive at hour 23 (window 22–23)', () => {
      expect(isWithinBusinessHours({ start: 22, end: 23 }, 22)).toBe(true)
      expect(isWithinBusinessHours({ start: 22, end: 23 }, 23)).toBe(false)
    })

    test('full-day window 0–24 is NOT reachable (hours capped at 23)', () => {
      // 23 is the max valid hour; a 0–24 window would match 0..23.
      // The helper itself does NOT enforce the [0,23] cap (validation does),
      // but it evaluates the predicate honestly: 23 < 24 → within.
      expect(isWithinBusinessHours({ start: 0, end: 24 }, 23)).toBe(true)
      expect(isWithinBusinessHours({ start: 0, end: 24 }, 0)).toBe(true)
    })

    test('zero-width window (start === end) matches NOTHING', () => {
      // Documented behavior: start === end ⇒ no hour can satisfy start <= h < end.
      for (let h = 0; h <= 23; h++) {
        expect(isWithinBusinessHours({ start: 5, end: 5 }, h)).toBe(false)
      }
    })

    test('overnight-style window is NOT specially handled (documented limitation)', () => {
      // The engine reasons in a single 0..23 day. A window like 22–6 is
      // treated literally as [22, 6) which matches NOTHING (start > end).
      // This is a known, documented limitation — not a wrap-around.
      expect(isWithinBusinessHours({ start: 22, end: 6 }, 23)).toBe(false)
      expect(isWithinBusinessHours({ start: 22, end: 6 }, 2)).toBe(false)
    })
  })
})

describe('currentHour', () => {
  test('returns the local hour from a Date (deterministic for a fixed Date)', () => {
    // Construct a Date at a known local hour. getHours() is local-timezone,
    // so we assert against the SAME Date's getHours() to stay tz-agnostic.
    const noon = new Date(2026, 0, 15, 12, 30, 0) // 12:30 local
    expect(currentHour(noon)).toBe(noon.getHours())
    expect(currentHour(noon)).toBe(12)
  })

  test('default argument uses the current wall-clock (smoke only)', () => {
    const now = new Date()
    expect(currentHour()).toBe(now.getHours())
    expect(currentHour()).toBeGreaterThanOrEqual(0)
    expect(currentHour()).toBeLessThanOrEqual(23)
  })
})
