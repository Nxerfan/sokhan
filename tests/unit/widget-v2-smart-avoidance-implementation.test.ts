/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 10 — Smart Avoidance.
 *
 * Includes the geometry regression suite for the corrected bounded interval
 * solver: short legal moves inside small viewports, destination validation
 * against ALL reachable obstacles (adjacent obstacles), non-monotonic
 * escape corridors, Euclidean diagonal displacement limits, and exact
 * behavior parity across the pure TS module, the slug script runtime, the
 * v1 script runtime, and the NPM widget runtime.
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
import { buildScript as buildSlugScript } from '../../src/app/api/widget/[slug]/script/route'
import { buildScript as buildV1Script } from '../../src/app/api/widget/v1/sukhan.js/route'
import { SukhanWidget } from '../../packages/widget-npm/src/widget'

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

// ─── Geometry regressions: corrected bounded interval solver ───────────────

/** Reviewer-compatible separation predicate (touching at the gap is clear). */
function separated(a: AvoidanceRect, b: AvoidanceRect, gap = 0): boolean {
  return a.right + gap <= b.left || a.left >= b.right + gap ||
    a.bottom + gap <= b.top || a.top >= b.bottom + gap
}

const movedRect = (original: AvoidanceRect, r: { dx: number; dy: number }): AvoidanceRect =>
  rect(original.left + r.dx, original.top + r.dy, original.right + r.dx, original.bottom + r.dy)

describe('Developer — geometry: short legal moves within a small viewport', () => {
  // Every 240px endpoint (8 directions) leaves this 375x500 viewport, but a
  // 72px move is legal — the solver must search the reachable interval, not
  // require the full maxShift endpoint to be in-viewport.
  const smallViewport = { width: 375, height: 500 }
  const original = rect(161, 224, 213, 276)
  const banner = rect(153, 216, 221, 284)

  test('finds the minimal legal move when the full maxShift endpoint leaves the viewport', () => {
    const result = computeSmartAvoidanceShift(original, [banner], smallViewport, { gap: 12, maxShift: 240 })
    expect(result).toEqual({ dx: 0, dy: -72 })
    const moved = movedRect(original, result)
    expect(separated(moved, banner, 12)).toBe(true)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(smallViewport.width)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.bottom).toBeLessThanOrEqual(smallViewport.height)
  })
  test('boundary: maxShift just below the required move → zero (no solution)', () => {
    expect(computeSmartAvoidanceShift(original, [banner], smallViewport, { gap: 12, maxShift: 71 }))
      .toEqual({ dx: 0, dy: 0 })
  })
  test('boundary: maxShift exactly the required move → works', () => {
    expect(computeSmartAvoidanceShift(original, [banner], smallViewport, { gap: 12, maxShift: 72 }))
      .toEqual({ dx: 0, dy: -72 })
  })
  test('fractional browser-style rects: minimal move found, all invariants hold', () => {
    const orig = rect(161.5, 224.25, 213.5, 276.25)
    const b = rect(153.5, 216.25, 221.5, 284.25)
    const result = computeSmartAvoidanceShift(orig, [b], smallViewport, { gap: 12, maxShift: 240 })
    expect(Number.isFinite(result.dx)).toBe(true)
    expect(Number.isFinite(result.dy)).toBe(true)
    expect(Math.hypot(result.dx, result.dy)).toBeGreaterThan(0)
    expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(240)
    const moved = movedRect(orig, result)
    expect(separated(moved, b, 12)).toBe(true)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(smallViewport.width)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.bottom).toBeLessThanOrEqual(smallViewport.height)
  })
})

describe('Developer — geometry: destination validated against ALL obstacles', () => {
  // Reviewer's adjacent-obstacle case: the launcher overlaps the blocking
  // overlay; the adjacent obstacle does NOT overlap initially but a 84px
  // left escape collides with it. The only bounded solution is up 102px.
  const vp = { width: 400, height: 800 }
  const original = rect(320, 728, 372, 780)
  const blocking = rect(300, 690, 400, 800)
  const adjacent = rect(50, 700, 300, 800)

  test('adjacent obstacle forces the up move; result clears BOTH obstacles', () => {
    const result = computeSmartAvoidanceShift(original, [blocking, adjacent], vp, { gap: 12, maxShift: 240 })
    expect(result).toEqual({ dx: 0, dy: -102 })
    const moved = movedRect(original, result)
    expect(separated(moved, blocking, 12)).toBe(true)
    expect(separated(moved, adjacent, 12)).toBe(true)
  })
  test('without the adjacent obstacle the shorter 84px left move is preferred', () => {
    // Sanity: the Defect B fix did not regress the single-obstacle case.
    expect(computeSmartAvoidanceShift(original, [blocking], vp, { gap: 12, maxShift: 240 }))
      .toEqual({ dx: -84, dy: 0 })
  })
  test('default options behave exactly like gap=12 maxShift=240', () => {
    expect(computeSmartAvoidanceShift(original, [adjacent, blocking], vp))
      .toEqual({ dx: 0, dy: -102 })
  })
  test('obstacle order and far-away invalid rects never change the result', () => {
    const a = computeSmartAvoidanceShift(original, [blocking, adjacent], vp)
    const b = computeSmartAvoidanceShift(original, [adjacent, blocking], vp)
    const c = computeSmartAvoidanceShift(original, [adjacent, blocking, rect(-900, -900, -800, -800)], vp)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

describe('Developer — geometry: non-monotonic escape corridor', () => {
  // A full-height wall blocks up/down, a right wall blocks right, and the
  // only escape is a left corridor between two obstacles (clear at
  // 114px..128px, blocked again beyond). Clearance along the direction is
  // NOT monotonic — the solver must return the minimal corridor move, not
  // miss it and not overshoot to a far-side re-clear.
  const vp = { width: 400, height: 300 }
  const L = rect(200, 100, 252, 152)
  const obstacles = [rect(150, 0, 260, 300), rect(0, 80, 60, 180), rect(330, 0, 400, 300)]

  test('picks the minimal corridor move and stays clear of every wall', () => {
    const result = computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 240 })
    expect(result).toEqual({ dx: -114, dy: 0 })
    const moved = movedRect(L, result)
    for (const o of obstacles) expect(separated(moved, o, 12)).toBe(true)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(vp.width)
    expect(moved.bottom).toBeLessThanOrEqual(vp.height)
  })
  test('boundary: maxShift below the corridor distance → zero', () => {
    expect(computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 113 }))
      .toEqual({ dx: 0, dy: 0 })
  })
  test('boundary: maxShift exactly the corridor distance → works', () => {
    expect(computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 114 }))
      .toEqual({ dx: -114, dy: 0 })
  })
})

describe('Developer — geometry: diagonal displacement is bounded Euclidean', () => {
  // Bottom-left corner: up/down/left are blocked by walls and the viewport;
  // the only bounded escape is the up-right diagonal (~112px per axis,
  // ~158.39px Euclidean). The maxShift limit must be enforced as a
  // Euclidean distance on the diagonal, not per-axis.
  const vp = { width: 400, height: 800 }
  const L = rect(0, 748, 52, 800)
  const obstacles = [rect(0, 700, 300, 800), rect(0, 400, 100, 700)]

  test('corner escape is the up-right diagonal with equal components', () => {
    const result = computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 240 })
    expect(result.dx).toBeGreaterThan(0)
    expect(result.dy).toBeLessThan(0)
    expect(Math.abs(result.dx - 112)).toBeLessThan(0.001)
    expect(Math.abs(result.dy + 112)).toBeLessThan(0.001)
    expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(240)
    const moved = movedRect(L, result)
    for (const o of obstacles) expect(separated(moved, o, 12)).toBe(true)
    expect(moved.left).toBeGreaterThanOrEqual(0)
    expect(moved.right).toBeLessThanOrEqual(vp.width)
    expect(moved.top).toBeGreaterThanOrEqual(0)
    expect(moved.bottom).toBeLessThanOrEqual(vp.height)
  })
  test('boundary: maxShift below the diagonal Euclidean distance → zero', () => {
    // 112*sqrt(2) ≈ 158.39 — a per-axis bound of 158 would wrongly succeed.
    expect(computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 158 }))
      .toEqual({ dx: 0, dy: 0 })
  })
  test('boundary: maxShift above the diagonal Euclidean distance → works', () => {
    const result = computeSmartAvoidanceShift(L, obstacles, vp, { gap: 12, maxShift: 159 })
    expect(Math.hypot(result.dx, result.dy)).toBeGreaterThan(0)
    expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(159)
    const moved = movedRect(L, result)
    for (const o of obstacles) expect(separated(moved, o, 12)).toBe(true)
  })
})

// ─── Pure / slug / v1 / NPM geometry parity ────────────────────────────────

type RuntimeShiftFn = (
  launcherRect: { left: number; top: number; right: number; bottom: number },
  obstacleRects: Array<{ left: number; top: number; right: number; bottom: number }>,
  viewport: { width: number; height: number },
  options?: { gap?: number; maxShift?: number },
) => { dx: number; dy: number }

/**
 * Extract the self-contained inline geometry function from a generated
 * runtime script (slug or v1) by brace matching and evaluate it. The
 * function body contains no string literals or comment braces, so plain
 * brace counting is safe.
 */
function extractRuntimeShift(js: string, label: string): RuntimeShiftFn {
  const marker = 'function __skComputeSmartAvoidanceShift('
  const start = js.indexOf(marker)
  if (start < 0) throw new Error(`[ ${label} ] geometry function missing from generated script`)
  let depth = 0
  let i = start
  let seenOpen = false
  for (; i < js.length; i++) {
    if (js[i] === '{') { depth++; seenOpen = true }
    else if (js[i] === '}') {
      depth--
      if (seenOpen && depth === 0) break
    }
  }
  if (!(seenOpen && depth === 0)) throw new Error(`[ ${label} ] unbalanced braces around geometry function`)
  const src = js.slice(start, i + 1)
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src + ')')() as RuntimeShiftFn
}

const slugShift = extractRuntimeShift(
  buildSlugScript('https://app.sukhan.chat', 'demo', false, '/?XTransformPort=3003', false),
  'slug script',
)
const v1Shift = extractRuntimeShift(buildV1Script(null, false), 'v1 script')
// The NPM method is private in TS but present on the prototype at runtime;
// it is a pure function (never uses `this`), so it can be invoked directly.
const npmShift = (SukhanWidget.prototype as unknown as Record<string, RuntimeShiftFn>)
  .__skComputeSmartAvoidanceShift

describe('Developer — geometry parity: pure TS === slug script === v1 script === NPM widget', () => {
  const parityCases: Array<{
    label: string
    launcher: AvoidanceRect
    obstacles: AvoidanceRect[]
    viewport: { width: number; height: number }
    options?: { gap?: number; maxShift?: number }
  }> = [
    { label: 'no obstacles', launcher: rect(320, 728, 372, 780), obstacles: [], viewport: { width: 400, height: 800 } },
    { label: 'no initial collision', launcher: rect(320, 728, 372, 780), obstacles: [rect(0, 0, 100, 100)], viewport: { width: 400, height: 800 } },
    { label: 'touching at gap is clear', launcher: rect(300, 700, 352, 752), obstacles: [rect(0, 0, 100, 100)], viewport: { width: 400, height: 800 }, options: { gap: 12 } },
    { label: 'small viewport short move', launcher: rect(161, 224, 213, 276), obstacles: [rect(153, 216, 221, 284)], viewport: { width: 375, height: 500 }, options: { gap: 12, maxShift: 240 } },
    { label: 'small viewport short move below bound', launcher: rect(161, 224, 213, 276), obstacles: [rect(153, 216, 221, 284)], viewport: { width: 375, height: 500 }, options: { gap: 12, maxShift: 71 } },
    { label: 'adjacent obstacles', launcher: rect(320, 728, 372, 780), obstacles: [rect(300, 690, 400, 800), rect(50, 700, 300, 800)], viewport: { width: 400, height: 800 }, options: { gap: 12, maxShift: 240 } },
    { label: 'adjacent obstacles reversed order + defaults', launcher: rect(320, 728, 372, 780), obstacles: [rect(50, 700, 300, 800), rect(300, 690, 400, 800)], viewport: { width: 400, height: 800 } },
    { label: 'single obstacle prefers left 84', launcher: rect(320, 728, 372, 780), obstacles: [rect(300, 690, 400, 800)], viewport: { width: 400, height: 800 }, options: { gap: 12, maxShift: 240 } },
    { label: 'escape corridor', launcher: rect(200, 100, 252, 152), obstacles: [rect(150, 0, 260, 300), rect(0, 80, 60, 180), rect(330, 0, 400, 300)], viewport: { width: 400, height: 300 }, options: { gap: 12, maxShift: 240 } },
    { label: 'corner diagonal', launcher: rect(0, 748, 52, 800), obstacles: [rect(0, 700, 300, 800), rect(0, 400, 100, 700)], viewport: { width: 400, height: 800 } },
    { label: 'corner diagonal below Euclidean bound', launcher: rect(0, 748, 52, 800), obstacles: [rect(0, 700, 300, 800), rect(0, 400, 100, 700)], viewport: { width: 400, height: 800 }, options: { gap: 12, maxShift: 158 } },
    { label: 'corner diagonal above Euclidean bound', launcher: rect(0, 748, 52, 800), obstacles: [rect(0, 700, 300, 800), rect(0, 400, 100, 700)], viewport: { width: 400, height: 800 }, options: { gap: 12, maxShift: 159 } },
    { label: 'full-cover obstacle has no solution', launcher: rect(320, 728, 372, 780), obstacles: [rect(0, 0, 400, 800)], viewport: { width: 400, height: 800 }, options: { gap: 12, maxShift: 240 } },
    { label: 'invalid obstacle rects ignored', launcher: rect(320, 728, 372, 780), obstacles: [rect(NaN, 0, 100, 100), rect(Infinity, 0, 100, 100)], viewport: { width: 400, height: 800 } },
    { label: 'gap 0 lateral overlap', launcher: rect(10, 10, 62, 62), obstacles: [rect(60, 10, 120, 62)], viewport: { width: 400, height: 300 }, options: { gap: 0 } },
    { label: 'fractional browser-style rects', launcher: rect(161.5, 224.25, 213.5, 276.25), obstacles: [rect(153.5, 216.25, 221.5, 284.25)], viewport: { width: 375, height: 500 }, options: { gap: 12, maxShift: 240 } },
    { label: 'bottom banner default options', launcher: rect(1180, 660, 1232, 712), obstacles: [rect(1100, 690, 1280, 720)], viewport: { width: 1280, height: 720 } },
    { label: 'maxShift zero with collision', launcher: rect(1180, 660, 1232, 712), obstacles: [rect(1100, 690, 1280, 720)], viewport: { width: 1280, height: 720 }, options: { maxShift: 0 } },
  ]

  for (const c of parityCases) {
    test(`parity case "${c.label}"`, () => {
      const expected = computeSmartAvoidanceShift(c.launcher, c.obstacles, c.viewport, c.options)
      expect(slugShift(c.launcher, c.obstacles, c.viewport, c.options), 'slug script geometry must match the pure TS module')
        .toEqual(expected)
      expect(v1Shift(c.launcher, c.obstacles, c.viewport, c.options), 'v1 script geometry must match the pure TS module')
        .toEqual(expected)
      expect(npmShift.call(null, c.launcher, c.obstacles, c.viewport, c.options), 'NPM widget geometry must match the pure TS module')
        .toEqual(expected)
    })
  }

  test('all four implementations are wired (no missing/renamed copies)', () => {
    expect(typeof slugShift).toBe('function')
    expect(typeof v1Shift).toBe('function')
    expect(typeof npmShift).toBe('function')
  })
})

