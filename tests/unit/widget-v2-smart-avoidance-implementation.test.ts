/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 10 — Smart Avoidance.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { isValidSmartAvoidanceConfig } from '../../src/lib/widget/smart-avoidance-types'
import {
  validateSmartAvoidancePatch, mergeSmartAvoidancePatch,
} from '../../src/lib/widget/smart-avoidance-patch'
import { resolveEffectiveSmartAvoidance } from '../../src/lib/widget/effective-smart-avoidance'
import {
  computeSmartAvoidanceShift, DEFAULT_GAP, DEFAULT_MAX_SHIFT,
  type AvoidanceRect,
} from '../../src/lib/widget/smart-avoidance-geometry'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'
import { mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'
import { mergeAlternativeContactButtonsPatch } from '../../src/lib/widget/alternative-contact-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

const FREE = getEntitlements('free')!
const PRO = getEntitlements('pro')!
const MAX = getEntitlements('max')!
const SELF = getEntitlements('self-hosted')!
const UNKNOWN = getEntitlements('__unknown__')
const stored = (enabled: boolean) => ({ version: 1 as const, desktop: {}, mobile: {}, smartAvoidance: { enabled } })
const rect = (l: number, t: number, r: number, b: number): AvoidanceRect => ({ left: l, top: t, right: r, bottom: b })
const viewport = { width: 1280, height: 720 }
const launcher = rect(1180, 660, 1232, 712)
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Developer — defaults and constants', () => {
  test('DEFAULT_GAP is 12', () => { expect(DEFAULT_GAP).toBe(12) })
  test('DEFAULT_MAX_SHIFT is 240', () => { expect(DEFAULT_MAX_SHIFT).toBe(240) })
})

describe('Developer — entitlement behavior', () => {
  test('Free false, Pro/Max/Self true, unknown null', () => {
    expect(FREE.smartAvoidance).toBe(false)
    for (const e of [PRO, MAX, SELF]) expect(e.smartAvoidance).toBe(true)
    expect(UNKNOWN).toBeNull()
  })
  test('Stored true + Free → false', () => {
    expect(resolveEffectiveSmartAvoidance(input(stored(true)), FREE)).toEqual({ enabled: false })
  })
  test('Stored true + Pro → true', () => {
    expect(resolveEffectiveSmartAvoidance(input(stored(true)), PRO)).toEqual({ enabled: true })
  })
  test('Stored false + Pro → false', () => {
    expect(resolveEffectiveSmartAvoidance(input(stored(false)), PRO)).toEqual({ enabled: false })
  })
  test('No V2 + Pro → false (default off)', () => {
    expect(resolveEffectiveSmartAvoidance(input(null), PRO)).toEqual({ enabled: false })
  })
  test('Unknown plan → false', () => {
    expect(resolveEffectiveSmartAvoidance(input(stored(true)), UNKNOWN)).toEqual({ enabled: false })
  })
  test('null entitlements → false', () => {
    expect(resolveEffectiveSmartAvoidance(input(stored(true)), null)).toEqual({ enabled: false })
  })
})

describe('Developer — validation', () => {
  test('Free rejected for true and false', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, FREE).ok).toBe(false)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: false } }, FREE).ok).toBe(false)
  })
  test('Pro accepted for true and false', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, PRO).ok).toBe(true)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: false } }, PRO).ok).toBe(true)
  })
  test('Max and Self-hosted accepted', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, MAX).ok).toBe(true)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, SELF).ok).toBe(true)
  })
  test('Unknown plan rejected', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, UNKNOWN).ok).toBe(false)
  })
  test('null entitlements rejected', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, null as never).ok).toBe(false)
  })
  test('rejects non-boolean enabled', () => {
    for (const v of [1, 'true', 0, null]) {
      expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: v } }, PRO).ok).toBe(false)
    }
  })
  test('rejects unexpected keys', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true, plan: 'pro' } }, PRO).ok).toBe(false)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true, css: 'x' } }, PRO).ok).toBe(false)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true, paidEnabled: true } }, PRO).ok).toBe(false)
  })
  test('rejects accessor-backed enabled without executing getter', () => {
    let triggered = false
    const raw = { get enabled() { triggered = true; throw Error('getter') } }
    expect(validateSmartAvoidancePatch({ smartAvoidance: raw }, PRO).ok).toBe(false)
    expect(triggered).toBe(false)
  })
  test('rejects Symbol keys', () => {
    const sym = Symbol('test')
    const raw = { enabled: true, [sym]: 'extra' }
    expect(validateSmartAvoidancePatch({ smartAvoidance: raw }, PRO).ok).toBe(false)
  })
  test('accepts boolean true/false via descriptor', () => {
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: true } }, PRO).ok).toBe(true)
    expect(validateSmartAvoidancePatch({ smartAvoidance: { enabled: false } }, PRO).ok).toBe(true)
  })
})

describe('Developer — isValidSmartAvoidanceConfig', () => {
  test('valid config accepted', () => {
    expect(isValidSmartAvoidanceConfig({ enabled: true })).toBe(true)
    expect(isValidSmartAvoidanceConfig({ enabled: false })).toBe(true)
  })
  test('invalid rejected', () => {
    expect(isValidSmartAvoidanceConfig({ enabled: 'true' })).toBe(false)
    expect(isValidSmartAvoidanceConfig({ enabled: 1 })).toBe(false)
    expect(isValidSmartAvoidanceConfig({})).toBe(false)
    expect(isValidSmartAvoidanceConfig(null)).toBe(false)
  })
  test('accessor-backed rejected without executing getter', () => {
    let triggered = false
    const raw = { get enabled() { triggered = true; throw Error('x') } }
    expect(isValidSmartAvoidanceConfig(raw)).toBe(false)
    expect(triggered).toBe(false)
  })
})

describe('Developer — merge and cross-feature preservation', () => {
  const full = {
    version: 1 as const, desktop: {}, mobile: {},
    colors: { mode: 'preset' as const, presetId: 'emerald' },
    quickReplies: { items: ['Help'] },
    preChatForm: { fields: [{ key: 'name' as const, required: true }] },
    pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
    alternativeContactButtons: { items: [{ kind: 'email' as const, label: 'Email', value: 'hi@example.com' }] },
    smartAvoidance: { enabled: true },
  }
  test('smart avoidance edit preserves all V2 neighbors', () => {
    const r = mergeSmartAvoidancePatch(full, { enabled: false }, PRO)
    expect(r.colors).toEqual(full.colors)
    expect(r.quickReplies).toEqual(full.quickReplies)
    expect(r.preChatForm).toEqual(full.preChatForm)
    expect(r.pageVisibility).toEqual(full.pageVisibility)
    expect(r.alternativeContactButtons).toEqual(full.alternativeContactButtons)
    expect(parseAppearanceV2(r)).not.toBeNull()
  })
  test('all 9 sibling merges preserve smart avoidance', () => {
    const a = mergeSmartAvoidancePatch(full, { enabled: false }, PRO)
    expect(mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } }).smartAvoidance).toEqual({ enabled: false })
    expect(mergeLauncherPatch(a, { shape: 'pill' }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergeAttentionPatch(a, { animation: 'glow' }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergeMessagePreviewPatch(a, { enabled: true }).smartAvoidance).toEqual({ enabled: false })
    expect(mergeQuickRepliesPatch(a, { items: ['Sales'] }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergePreChatFormPatch(a, { fields: [{ key: 'email' as const, required: false }] }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergePageVisibilityPatch(a, { rules: [{ pattern: '/x', match: 'exact' as const, action: 'show' as const }] }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergeAlternativeContactButtonsPatch(a, { items: [{ kind: 'phone' as const, label: 'Call', value: '+1234567890' }] }, PRO).smartAvoidance).toEqual({ enabled: false })
    expect(mergePositioningPatch(a, { hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' } }, 'bottom-center').smartAvoidance).toEqual({ enabled: false })
  })
})

describe('Developer — geometry: no collision → zero', () => {
  test('empty obstacles', () => {
    expect(computeSmartAvoidanceShift(launcher, [], viewport)).toEqual({ dx: 0, dy: 0 })
  })
  test('non-overlapping obstacle', () => {
    expect(computeSmartAvoidanceShift(launcher, [rect(0, 0, 100, 100)], viewport)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('Developer — geometry: collision avoidance', () => {
  test('full-covering obstacle → zero (no solution)', () => {
    expect(computeSmartAvoidanceShift(launcher, [rect(0, 0, 1280, 720)], viewport)).toEqual({ dx: 0, dy: 0 })
  })
  test('bottom banner → launcher moves up', () => {
    const banner = rect(1100, 690, 1280, 720)
    const result = computeSmartAvoidanceShift(launcher, [banner], viewport)
    expect(result.dy).toBeLessThan(0)
    expect(Math.abs(result.dx)).toBeLessThanOrEqual(DEFAULT_MAX_SHIFT)
  })
  test('obstacle-order invariance', () => {
    const obs = [rect(1100, 690, 1280, 720), rect(0, 0, 50, 50)]
    const a = computeSmartAvoidanceShift(launcher, obs, viewport)
    const b = computeSmartAvoidanceShift(launcher, obs.slice().reverse(), viewport)
    expect(a).toEqual(b)
  })
  test('invalid rects (NaN/Infinity) ignored', () => {
    expect(computeSmartAvoidanceShift(launcher, [rect(NaN, 0, 100, 100)], viewport)).toEqual({ dx: 0, dy: 0 })
    expect(computeSmartAvoidanceShift(launcher, [rect(Infinity, 0, 100, 100)], viewport)).toEqual({ dx: 0, dy: 0 })
    expect(computeSmartAvoidanceShift(launcher, [rect(0, 0, 100, NaN)], viewport)).toEqual({ dx: 0, dy: 0 })
  })
  test('moved launcher stays in viewport', () => {
    const banner = rect(1100, 690, 1280, 720)
    const result = computeSmartAvoidanceShift(launcher, [banner], viewport)
    const moved = rect(launcher.left + result.dx, launcher.top + result.dy, launcher.right + result.dx, launcher.bottom + result.dy)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(viewport.width)
    expect(moved.bottom).toBeLessThanOrEqual(viewport.height)
  })
  test('displacement bounded by maxShift', () => {
    const banner = rect(1100, 690, 1280, 720)
    const result = computeSmartAvoidanceShift(launcher, [banner], viewport, { maxShift: 30 })
    expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(30)
  })
  test('clearance gap respected', () => {
    const banner = rect(1100, 690, 1280, 720)
    const result = computeSmartAvoidanceShift(launcher, [banner], viewport, { gap: 20 })
    const moved = rect(launcher.left + result.dx, launcher.top + result.dy, launcher.right + result.dx, launcher.bottom + result.dy)
    // Check gap is respected: no overlap with the banner + 20px gap.
    const overlap = moved.right > banner.left - 20 && moved.left < banner.right + 20 &&
      moved.bottom > banner.top - 20 && moved.top < banner.bottom + 20
    expect(overlap).toBe(false)
  })
  test('maxShift=0 with collision → zero', () => {
    const banner = rect(1100, 690, 1280, 720)
    expect(computeSmartAvoidanceShift(launcher, [banner], viewport, { maxShift: 0 })).toEqual({ dx: 0, dy: 0 })
  })
})

describe('Developer — strict parseAppearanceV2 smartAvoidance', () => {
  test('valid coexists with all V2 fields', () => {
    expect(parseAppearanceV2(stored(true))?.smartAvoidance).toEqual({ enabled: true })
    expect(parseAppearanceV2(stored(false))?.smartAvoidance).toEqual({ enabled: false })
  })
  test('rejects null, arrays, primitives', () => {
    expect(parseAppearanceV2({ version: 1, smartAvoidance: null })).toBeNull()
    expect(parseAppearanceV2({ version: 1, smartAvoidance: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, smartAvoidance: 'true' })).toBeNull()
    expect(parseAppearanceV2({ version: 1, smartAvoidance: 1 })).toBeNull()
  })
  test('rejects non-boolean enabled', () => {
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { enabled: 'true' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { enabled: 1 } })).toBeNull()
  })
  test('rejects unexpected keys', () => {
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { enabled: true, css: 'x' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { enabled: true, plan: 'pro' } })).toBeNull()
  })
  test('rejects getters', () => {
    expect(parseAppearanceV2({ version: 1, smartAvoidance: { get enabled() { throw Error('x') } } })).toBeNull()
  })
  test('absent is valid', () => {
    expect(parseAppearanceV2({ version: 1 })?.smartAvoidance).toBeUndefined()
  })
})
