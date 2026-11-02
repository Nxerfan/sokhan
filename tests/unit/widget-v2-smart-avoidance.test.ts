/// <reference types="bun-types" />
/**
 * Reviewer-owned independent Feature 10 Smart Avoidance contract.
 * Geometry is deterministic and pure. No browser/DOM in this file.
 * The implementation agent must never change these assertions.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { isValidSmartAvoidanceConfig } from '../../src/lib/widget/smart-avoidance-types'
import { validateSmartAvoidancePatch, mergeSmartAvoidancePatch } from '../../src/lib/widget/smart-avoidance-patch'
import { resolveEffectiveSmartAvoidance } from '../../src/lib/widget/effective-smart-avoidance'
import { computeSmartAvoidanceShift, type AvoidanceRect } from '../../src/lib/widget/smart-avoidance-geometry'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'
import { mergeAlternativeContactButtonsPatch } from '../../src/lib/widget/alternative-contact-patch'

const free = getEntitlements('free')!
const pro = getEntitlements('pro')!
const max = getEntitlements('max')!
const self = getEntitlements('self-hosted')!
const stored = (enabled: boolean) => ({ version: 1 as const, desktop: {}, mobile: {}, smartAvoidance: { enabled } })
const rect = (left: number, top: number, right: number, bottom: number): AvoidanceRect => ({ left, top, right, bottom })
const viewport = { width: 400, height: 800 }
const clean = (result: { dx: number, dy: number }) => {
  expect(Number.isFinite(result.dx)).toBe(true)
  expect(Number.isFinite(result.dy)).toBe(true)
}
function separated(a: AvoidanceRect, b: AvoidanceRect, gap = 0) {
  return a.right + gap <= b.left || a.left >= b.right + gap || a.bottom + gap <= b.top || a.top >= b.bottom + gap
}

describe('Reviewer — Smart Avoidance entitlement and persistence', () => {
  test('Free disabled, advanced plans enabled, unknown plans fail closed', () => {
    expect(free.smartAvoidance).toBe(false)
    for (const e of [pro, max, self]) expect(e.smartAvoidance).toBe(true)
    expect(getEntitlements('unknown')).toBeNull()
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: stored(true) }, free)).toEqual({ enabled: false })
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: stored(true) }, null)).toEqual({ enabled: false })
  })
  test('Legacy config defaults off for paid and Free', () => {
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: null }, pro)).toEqual({ enabled: false })
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: { version: 1 } }, pro)).toEqual({ enabled: false })
  })
  test('Only a paying tenant may enable or disable; Free writes rejected even when false', () => {
    for (const value of [true, false]) {
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: value } }, pro).ok).toBe(true)
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: value } }, max).ok).toBe(true)
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: value } }, self).ok).toBe(true)
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: value } }, free).ok).toBe(false)
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: value } }, null).ok).toBe(false)
    }
  })
  test('Reject malformed and extra fields; do not execute accessor getters', () => {
    const invalid: unknown[] = [
      null, undefined, [], {}, 'true', true, { enabled: 1 }, { enabled: 'true' },
      { enabled: true, paidEnabled: true }, { enabled: true, plan: 'pro' },
      { get enabled() { throw new Error('getter must never execute') } },
    ]
    for (const x of invalid) {
      expect(() => validateSmartAvoidancePatch({ smartAvoidance: x }, pro)).not.toThrow()
      expect(validateSmartAvoidancePatch({ smartAvoidance: x }, pro).ok).toBe(false)
    }
  })
  test('Strict V2 parsing permits enabled bool and rejects invalid objects', () => {
    expect(parseAppearanceV2(stored(true))?.smartAvoidance).toEqual({ enabled: true })
    expect(parseAppearanceV2(stored(false))?.smartAvoidance).toEqual({ enabled: false })
    for (const x of [null, [], {}, { enabled: 'true' }, { enabled: true, css: 'x' }, { get enabled() { throw new Error('unsafe') } }])
      expect(parseAppearanceV2({ version: 1, smartAvoidance: x })).toBeNull()
    expect(isValidSmartAvoidanceConfig({ enabled: true })).toBe(true)
    expect(isValidSmartAvoidanceConfig({ enabled: false })).toBe(true)
    expect(isValidSmartAvoidanceConfig({ enabled: 'true' })).toBe(false)
  })
  test('Paid enable persisted; Free downgrade disables without changing stored preference; upgrade restores', () => {
    const enabled = mergeSmartAvoidancePatch({ version: 1, desktop: {}, mobile: {} }, { enabled: true }, pro)
    expect(enabled.smartAvoidance).toEqual({ enabled: true })
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: enabled }, pro)).toEqual({ enabled: true })
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: enabled }, free)).toEqual({ enabled: false })
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: enabled }, pro)).toEqual({ enabled: true })
    const disabled = mergeSmartAvoidancePatch(enabled, { enabled: false }, pro)
    expect(resolveEffectiveSmartAvoidance({ appearanceV2: disabled }, pro)).toEqual({ enabled: false })
  })
  test('No unexpected top-level config fields are accepted', () => {
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { enabled: true }, unsafeCss: 'x' })).toBeNull()
  })
  test('Smart Avoidance save does not erase previous V2 settings, and inverse true-patches preserve it', () => {
    const prior = {
      version: 1 as const, desktop: {}, mobile: {},
      colors: { mode: 'preset' as const, presetId: 'emerald' },
      quickReplies: { items: ['Help'] },
      pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
      alternativeContactButtons: { items: [{ kind: 'email' as const, label: 'Email', value: 'hi@example.com' }] },
    }
    const saved = mergeSmartAvoidancePatch(prior, { enabled: true }, pro)
    expect(saved.colors).toEqual(prior.colors)
    expect(saved.quickReplies).toEqual(prior.quickReplies)
    expect(saved.pageVisibility).toEqual(prior.pageVisibility)
    expect(saved.alternativeContactButtons).toEqual(prior.alternativeContactButtons)
    expect(mergeColorPatch(saved, { theme: { mode: 'preset', presetId: 'emerald' } }).smartAvoidance).toEqual({ enabled: true })
    expect(mergeQuickRepliesPatch(saved, { items: ['Sales'] }, pro).smartAvoidance).toEqual({ enabled: true })
    expect(mergePageVisibilityPatch(saved, { rules: [] }, pro).smartAvoidance).toEqual({ enabled: true })
    expect(mergeAlternativeContactButtonsPatch(saved, { items: [] }, pro).smartAvoidance).toEqual({ enabled: true })
  })
})

describe('Reviewer — bounded deterministic collision geometry', () => {
  test('With no obstacles return zero offset, no movement, finite numbers', () => {
    const result = computeSmartAvoidanceShift(rect(320, 728, 372, 780), [], viewport)
    expect(result).toEqual({ dx: 0, dy: 0 })
    clean(result)
  })
  test('Obstacles elsewhere do not disturb user-selected placement', () => {
    expect(computeSmartAvoidanceShift(rect(320, 728, 372, 780), [rect(0, 0, 100, 100)], viewport))
      .toEqual({ dx: 0, dy: 0 })
  })
  test('A bottom overlay covering launcher causes a bounded move that actually avoids it', () => {
    const original = rect(320, 728, 372, 780)
    const overlay = rect(300, 690, 400, 800)
    const result = computeSmartAvoidanceShift(original, [overlay], viewport, { gap: 12, maxShift: 240 })
    clean(result)
    expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(240)
    expect(Math.hypot(result.dx, result.dy)).toBeGreaterThan(0)
    const moved = rect(original.left + result.dx, original.top + result.dy, original.right + result.dx, original.bottom + result.dy)
    expect(separated(moved, overlay, 12)).toBe(true)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(viewport.width)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.bottom).toBeLessThanOrEqual(viewport.height)
  })
  test('Touching at safety gap counts as clear and creates no movement', () => {
    expect(computeSmartAvoidanceShift(rect(300, 700, 352, 752), [rect(0, 0, 100, 100)], viewport, { gap: 12 }))
      .toEqual({ dx: 0, dy: 0 })
  })
  test('Computed result must be deterministic and independent of obstacle ordering', () => {
    const orig = rect(320, 728, 372, 780)
    const obstacles = [rect(300, 700, 400, 800), rect(20, 100, 100, 150)]
    const a = computeSmartAvoidanceShift(orig, obstacles, viewport)
    const b = computeSmartAvoidanceShift(orig, obstacles.slice().reverse(), viewport)
    expect(a).toEqual(b)
    expect(a).toEqual(computeSmartAvoidanceShift(orig, obstacles, viewport))
  })
  test('No solution within safe bounds: stay in viewport and never use NaN or Infinity', () => {
    const orig = rect(320, 728, 372, 780)
    const result = computeSmartAvoidanceShift(orig, [rect(0, 0, 400, 800)], viewport, { gap: 12, maxShift: 240 })
    expect(result).toEqual({ dx: 0, dy: 0 })
  })
  test('Invalid obstacle rectangles are ignored, not allowed to produce invalid CSS', () => {
    const orig = rect(320, 728, 372, 780)
    const bad = rect(NaN, 0, 100, 100)
    expect(computeSmartAvoidanceShift(orig, [bad], viewport)).toEqual({ dx: 0, dy: 0 })
  })
})
