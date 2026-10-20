/// <reference types="bun-types" />
/**
 * Unit tests for the hardened `validateRuleTrigger` (PR #3 §3).
 *
 * Source: `src/lib/routing-rules-validation.ts` (imported by
 * `src/app/api/routing-rules/route.ts` — called in BOTH POST, before
 * `db.routingRule.create`, AND PATCH, before `db.routingRule.updateMany`).
 *
 * These tests exercise the validator function directly. Because POST and PATCH
 * both call the SAME hardened validator, this single suite covers both paths
 * — the static regression checks at the bottom additionally assert at the
 * source-text level that BOTH handlers actually invoke it.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateRuleTrigger } from '@/lib/routing-rules-validation'

/** Assert a validation result is a failure with the given error code. */
function assertErr(r: { ok: true } | { ok: false; error: string }, code: string) {
  expect(r.ok).toBe(false)
  if (r.ok === false) {
    expect(r.error).toBe(code)
  }
}

/** Assert a validation result is a success. */
function assertOk(r: { ok: true } | { ok: false; error: string }) {
  expect(r.ok).toBe(true)
}

describe('validateRuleTrigger — trigger shape', () => {
  test('missing trigger (undefined) → invalid_trigger', () => {
    assertErr(validateRuleTrigger(undefined), 'invalid_trigger')
  })

  test('missing trigger (null) → invalid_trigger', () => {
    assertErr(validateRuleTrigger(null), 'invalid_trigger')
  })

  test('trigger is an array → invalid_trigger', () => {
    assertErr(validateRuleTrigger([]), 'invalid_trigger')
  })

  test('trigger is a string → invalid_trigger', () => {
    assertErr(validateRuleTrigger('hello'), 'invalid_trigger')
  })

  test('trigger is a number → invalid_trigger', () => {
    assertErr(validateRuleTrigger(42), 'invalid_trigger')
  })

  test('trigger is a boolean → invalid_trigger', () => {
    assertErr(validateRuleTrigger(true), 'invalid_trigger')
  })
})

describe('validateRuleTrigger — event', () => {
  test('missing event (trigger = {}) → invalid_event', () => {
    assertErr(validateRuleTrigger({}), 'invalid_event')
  })

  test('event is null → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: null }), 'invalid_event')
  })

  test('event is a number → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: 5 }), 'invalid_event')
  })

  test('event is an object → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: { x: 1 } }), 'invalid_event')
  })

  test('event is an array → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: ['conversation_created'] }), 'invalid_event')
  })

  test('event is a boolean → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: true }), 'invalid_event')
  })

  test('unknown event (e.g. "foo") → invalid_event', () => {
    assertErr(validateRuleTrigger({ event: 'foo' }), 'invalid_event')
  })

  test("valid event 'conversation_created' + no conditions → ok", () => {
    assertOk(validateRuleTrigger({ event: 'conversation_created' }))
  })

  test("valid event 'message_received' + no conditions → ok", () => {
    assertOk(validateRuleTrigger({ event: 'message_received' }))
  })

  test('valid event with empty conditions object → ok', () => {
    assertOk(validateRuleTrigger({ event: 'conversation_created', conditions: {} }))
  })
})

describe('validateRuleTrigger — conditions shape', () => {
  test('conditions is an array → invalid_conditions', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: [] }),
      'invalid_conditions',
    )
  })

  test('conditions is a string → invalid_conditions', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: 'hello' }),
      'invalid_conditions',
    )
  })

  test('conditions is null → invalid_conditions', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: null }),
      'invalid_conditions',
    )
  })

  test('conditions is a number → invalid_conditions', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: 42 }),
      'invalid_conditions',
    )
  })
})

describe('validateRuleTrigger — conditions.keyword', () => {
  test('keyword is a number → invalid_keyword', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: 5 } }),
      'invalid_keyword',
    )
  })

  test('keyword is an object → invalid_keyword', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: { x: 1 } } }),
      'invalid_keyword',
    )
  })

  test('keyword is empty string → invalid_keyword', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: '' } }),
      'invalid_keyword',
    )
  })

  test("keyword is only whitespace '   ' → invalid_keyword", () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: '   ' } }),
      'invalid_keyword',
    )
  })

  test('keyword length > 200 (trimmed) → invalid_keyword', () => {
    const long = 'a'.repeat(201)
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: long } }),
      'invalid_keyword',
    )
  })

  test('keyword length > 200 after trimming surrounding whitespace → invalid_keyword', () => {
    // 201 'a's surrounded by spaces — trimmed length still 201 → rejected.
    const long = '   ' + 'a'.repeat(201) + '   '
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: { keyword: long } }),
      'invalid_keyword',
    )
  })

  test('keyword valid non-empty trimmed (with surrounding whitespace) → ok', () => {
    assertOk(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { keyword: '  hello  ' },
      }),
    )
  })

  test('keyword exactly 200 chars → ok (boundary)', () => {
    assertOk(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { keyword: 'a'.repeat(200) },
      }),
    )
  })
})

describe('validateRuleTrigger — conditions.businessHours', () => {
  test('businessHours is an array → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: [] },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours is a string → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: '9-17' },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours missing start → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours missing end → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = null → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: null, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = NaN → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: NaN, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = Infinity → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: Infinity, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.end = NaN → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: NaN } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.end = Infinity → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: Infinity } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = 9.5 (fractional) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9.5, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.end = 17.5 (fractional) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: 17.5 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = -1 (out of range) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: -1, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = 24 (out of range) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 24, end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.end = -1 (out of range) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: -1 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.end = 24 (out of range) → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: 24 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start is a string → invalid_business_hours', () => {
    assertErr(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: '9', end: 17 } },
      }),
      'invalid_business_hours',
    )
  })

  test('businessHours.start = 0, end = 23 (boundary valid) → ok', () => {
    assertOk(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 0, end: 23 } },
      }),
    )
  })

  test('businessHours.start = 9, end = 17 (valid) → ok', () => {
    assertOk(
      validateRuleTrigger({
        event: 'conversation_created',
        conditions: { businessHours: { start: 9, end: 17 } },
      }),
    )
  })
})

describe('validateRuleTrigger — route integration (POST + PATCH paths)', () => {
  // POST and PATCH both call the SAME hardened validator, so a single direct
  // call exercises both paths' validation logic. The static regression
  // checks below additionally verify that BOTH handlers actually invoke it
  // at the source level.

  test('(POST path) trigger with valid event + valid conditions → ok (proves POST would proceed to create)', () => {
    assertOk(
      validateRuleTrigger({
        event: 'message_received',
        conditions: { keyword: 'urgent', businessHours: { start: 9, end: 17 } },
      }),
    )
  })

  test('(POST path) missing trigger → invalid_trigger (POST would reject BEFORE create)', () => {
    assertErr(validateRuleTrigger(undefined), 'invalid_trigger')
  })

  test('(PATCH path) trigger with invalid event returns the error (proves PATCH retains validation)', () => {
    assertErr(validateRuleTrigger({ event: 'unknown_event' }), 'invalid_event')
  })

  test('(PATCH path) trigger with array conditions returns invalid_conditions (PATCH retains hardened checks)', () => {
    assertErr(
      validateRuleTrigger({ event: 'conversation_created', conditions: [] }),
      'invalid_conditions',
    )
  })
})

describe('routing-rules/route.ts — static regression checks (source-level)', () => {
  // These tests do NOT execute the route handlers (which require a Next.js
  // runtime + DB). Instead, they read the route source text and verify that
  // BOTH POST and PATCH invoke the hardened validator at the right places.
  // This catches regressions where a future edit accidentally drops the call.

  const ROUTE_PATH = resolve(process.cwd(), 'src/app/api/routing-rules/route.ts')
  const src = () => readFileSync(ROUTE_PATH, 'utf-8')

  test('route imports validateRuleTrigger from the extracted lib (no local definition)', () => {
    const txt = src()
    expect(txt).toContain("from '@/lib/routing-rules-validation'")
    expect(txt).toMatch(/import\s+\{\s*validateRuleTrigger\s*\}\s+from/)
    // The local (lax) function definition MUST have been removed.
    expect(txt).not.toMatch(/function\s+validateRuleTrigger\s*\(/)
    // The old lax VALID_EVENTS local const is gone (now lives in the lib).
    expect(txt).not.toMatch(/const\s+VALID_EVENTS\s*=/)
    // POST no longer silently defaults the trigger.
    expect(txt).not.toContain("{ event: 'conversation_created', conditions: {} }")
  })

  test('POST calls validateRuleTrigger BEFORE db.routingRule.create', () => {
    const txt = src()
    const postStart = txt.indexOf('export async function POST')
    expect(postStart).toBeGreaterThan(-1)
    const postEnd = txt.indexOf('export async function PATCH')
    expect(postEnd).toBeGreaterThan(postStart)
    const postBody = txt.slice(postStart, postEnd)

    const vIdx = postBody.indexOf('validateRuleTrigger(')
    expect(vIdx).toBeGreaterThan(-1)
    const cIdx = postBody.indexOf('db.routingRule.create')
    expect(cIdx).toBeGreaterThan(-1)
    // The validator call MUST appear before the create call.
    expect(vIdx).toBeLessThan(cIdx)
  })

  test('PATCH retains validateRuleTrigger call', () => {
    const txt = src()
    const patchStart = txt.indexOf('export async function PATCH')
    expect(patchStart).toBeGreaterThan(-1)
    const patchEnd = txt.indexOf('export async function DELETE')
    expect(patchEnd).toBeGreaterThan(patchStart)
    const patchBody = txt.slice(patchStart, patchEnd)

    expect(patchBody).toContain('validateRuleTrigger(')
    // PATCH's existing guard pattern is preserved: validate only when
    // body.trigger is supplied (partial-update semantics).
    expect(patchBody).toMatch(/if\s*\(\s*body\.trigger\s*!==\s*undefined\s*\)/)
  })
})
