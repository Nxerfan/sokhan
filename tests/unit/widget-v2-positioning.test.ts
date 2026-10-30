/// <reference types="bun-types" />
/**
 * Widget V2 Positioning — unit tests.
 *
 * Tests the pure TS positioning modules (no DB, no browser):
 *   - src/lib/widget/positioning-geometry.ts (geometry computation)
 *   - src/lib/widget/appearance-v2.ts (strict parser with positioning fields)
 *   - src/lib/widget/effective-positioning.ts (effective resolver + entitlements)
 *   - src/lib/widget/positioning-patch.ts (PATCH validation + merge)
 *   - packages/widget-npm/src/positioning.ts (NPM package copy — parity)
 */

import { test, expect, describe } from 'bun:test'
import {
  computeLauncherPosition,
  offsetXFromAbsoluteLeft,
  isValidOffset,
  isValidAnchor,
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
  DEFAULT_POSITIONING,
  DEFAULT_BASE_MARGIN,
  type PositioningAnchor,
} from '../../src/lib/widget/positioning-geometry'
import {
  computeLauncherPosition as npmComputePosition,
  offsetXFromAbsoluteLeft as npmOffsetXFromLeft,
  isValidOffset as npmIsValidOffset,
  isValidAnchor as npmIsValidAnchor,
} from '../../packages/widget-npm/src/positioning'
import {
  parseAppearanceV2,
  APPEARANCE_V2_VERSION,
  type AppearanceV2,
} from '../../src/lib/widget/appearance-v2'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import {
  resolveEffectivePositioning,
  resolveAllEffectivePositioning,
  getStoredPositioning,
  deriveLegacyPosition,
  type StoredPositioningInput,
} from '../../src/lib/widget/effective-positioning'
import {
  validatePositioningPatch,
  mergePositioningPatch,
  hasOtherCustomizationFields,
  hasPositioningField,
} from '../../src/lib/widget/positioning-patch'

// ─── Geometry computation ─────────────────────────────────────────────────

describe('Geometry — computeLauncherPosition', () => {
  const baseOpts = {
    offsetX: 0,
    offsetY: 0,
    dir: 'ltr' as const,
    viewportWidth: 1000,
    viewportHeight: 800,
    launcherWidth: 52,
    launcherHeight: 52,
    safeAreaBottom: 0,
    baseMargin: DEFAULT_BASE_MARGIN,
  }

  test('bottom-start LTR → launcher at bottom-left', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-start' })
    expect(r.left).toBe(20) // baseMargin
    expect(r.bottom).toBe(20) // baseMargin
    expect(r.panelSide).toBe('right') // launcher on left → panel opens right
  })

  test('bottom-end LTR → launcher at bottom-right', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end' })
    expect(r.left).toBe(1000 - 52 - 20) // viewportWidth - launcherWidth - baseMargin
    expect(r.bottom).toBe(20)
    expect(r.panelSide).toBe('left') // launcher on right → panel opens left
  })

  test('bottom-center → launcher centered horizontally', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-center' })
    expect(r.left).toBe((1000 - 52) / 2) // (viewportWidth - launcherWidth) / 2
    expect(r.bottom).toBe(20)
    expect(r.panelSide).toBe('center')
  })

  test('RTL: bottom-start → launcher at bottom-right', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-start', dir: 'rtl' })
    expect(r.left).toBe(1000 - 52 - 20) // right side
    expect(r.panelSide).toBe('left')
  })

  test('RTL: bottom-end → launcher at bottom-left', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', dir: 'rtl' })
    expect(r.left).toBe(20) // left side
    expect(r.panelSide).toBe('right')
  })

  test('RTL: bottom-center → same as LTR (centered)', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-center', dir: 'rtl' })
    expect(r.left).toBe((1000 - 52) / 2)
    expect(r.panelSide).toBe('center')
  })

  test('offsetX positive → moves right (physical)', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-start', offsetX: 100 })
    expect(r.left).toBe(120) // baseMargin + 100
  })

  test('offsetX negative → moves left (physical)', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetX: -100 })
    expect(r.left).toBe(1000 - 52 - 20 - 100) // baseLeft - 100
  })

  test('offsetY positive → moves up', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetY: 50 })
    expect(r.bottom).toBe(70) // baseMargin + 50
  })

  test('offsetY negative → moves down', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetY: -10 })
    expect(r.bottom).toBe(10) // baseMargin - 10
  })

  test('Clamp: offsetX pushes launcher off-screen right → clamped', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetX: 1000 })
    expect(r.left).toBe(1000 - 52) // maxLeft = viewportWidth - launcherWidth
  })

  test('Clamp: offsetX pushes launcher off-screen left → clamped to 0', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-start', offsetX: -1000 })
    expect(r.left).toBe(0)
  })

  test('Clamp: offsetY pushes launcher above viewport → clamped', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetY: 1000 })
    expect(r.bottom).toBe(800 - 52) // maxBottom = viewportHeight - launcherHeight
  })

  test('Clamp: offsetY pushes launcher below safe area → clamped to safeAreaBottom', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', offsetY: -1000, safeAreaBottom: 34 })
    expect(r.bottom).toBe(34) // minBottom = safeAreaBottom
  })

  test('Narrow viewport: launcher wider than viewport → clamped to 0', () => {
    const r = computeLauncherPosition({
      ...baseOpts,
      anchor: 'bottom-center',
      viewportWidth: 30,
      launcherWidth: 52,
    })
    expect(r.left).toBe(0) // maxLeft = max(0, 30-52) = 0
  })

  test('Safe-area respected: bottom includes safeAreaBottom', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end', safeAreaBottom: 34 })
    expect(r.bottom).toBe(20 + 34) // baseMargin + safeAreaBottom
  })

  test('panelSide: launcher in left half → panel opens right', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-start', offsetX: 100 })
    expect(r.panelSide).toBe('right')
  })

  test('panelSide: launcher in right half → panel opens left', () => {
    const r = computeLauncherPosition({ ...baseOpts, anchor: 'bottom-end' })
    expect(r.panelSide).toBe('left')
  })

  test('Never throws for any finite input', () => {
    expect(() => computeLauncherPosition({
      ...baseOpts,
      anchor: 'bottom-center',
      offsetX: -2000,
      offsetY: 2000,
      viewportWidth: 1,
      viewportHeight: 1,
    })).not.toThrow()
  })
})

// ─── offsetXFromAbsoluteLeft (inverse for drag) ───────────────────────────

describe('Geometry — offsetXFromAbsoluteLeft (drag back-compute)', () => {
  const baseParams = {
    dir: 'ltr' as const,
    viewportWidth: 1000,
    launcherWidth: 52,
    baseMargin: DEFAULT_BASE_MARGIN,
  }

  test('bottom-start: absoluteLeft = baseMargin → offsetX = 0', () => {
    expect(offsetXFromAbsoluteLeft('bottom-start', 20, baseParams.dir, baseParams.viewportWidth, baseParams.launcherWidth, baseParams.baseMargin)).toBe(0)
  })

  test('bottom-start: absoluteLeft = 120 → offsetX = 100', () => {
    expect(offsetXFromAbsoluteLeft('bottom-start', 120, baseParams.dir, baseParams.viewportWidth, baseParams.launcherWidth, baseParams.baseMargin)).toBe(100)
  })

  test('bottom-end: absoluteLeft = (vw - lw - bm) → offsetX = 0', () => {
    const baseLeft = 1000 - 52 - 20
    expect(offsetXFromAbsoluteLeft('bottom-end', baseLeft, baseParams.dir, baseParams.viewportWidth, baseParams.launcherWidth, baseParams.baseMargin)).toBe(0)
  })

  test('bottom-center: absoluteLeft = (vw - lw)/2 → offsetX = 0', () => {
    const baseLeft = (1000 - 52) / 2
    expect(offsetXFromAbsoluteLeft('bottom-center', baseLeft, baseParams.dir, baseParams.viewportWidth, baseParams.launcherWidth, baseParams.baseMargin)).toBe(0)
  })

  test('Round-trip: compute → offsetXFromLeft → original offsetX', () => {
    const opts = { anchor: 'bottom-start' as PositioningAnchor, offsetX: 150, offsetY: 0, dir: 'ltr' as const, viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52, safeAreaBottom: 0, baseMargin: 20 }
    const pos = computeLauncherPosition(opts)
    const backX = offsetXFromAbsoluteLeft(opts.anchor, pos.left, opts.dir, opts.viewportWidth, opts.launcherWidth, opts.baseMargin)
    expect(backX).toBe(150)
  })
})

// ─── Validation helpers ───────────────────────────────────────────────────

describe('Validation — isValidOffset', () => {
  test('valid integers within bounds', () => {
    expect(isValidOffset(0)).toBe(true)
    expect(isValidOffset(100)).toBe(true)
    expect(isValidOffset(-100)).toBe(true)
    expect(isValidOffset(OFFSET_MIN)).toBe(true)
    expect(isValidOffset(OFFSET_MAX)).toBe(true)
  })

  test('rejects NaN', () => { expect(isValidOffset(NaN)).toBe(false) })
  test('rejects Infinity', () => { expect(isValidOffset(Infinity)).toBe(false) })
  test('rejects -Infinity', () => { expect(isValidOffset(-Infinity)).toBe(false) })
  test('rejects fractions', () => { expect(isValidOffset(1.5)).toBe(false) })
  test('rejects strings', () => { expect(isValidOffset('100')).toBe(false) })
  test('rejects booleans', () => { expect(isValidOffset(true)).toBe(false) })
  test('rejects objects', () => { expect(isValidOffset({})).toBe(false) })
  test('rejects null', () => { expect(isValidOffset(null)).toBe(false) })
  test('rejects undefined', () => { expect(isValidOffset(undefined)).toBe(false) })
  test('rejects out of bounds (too large)', () => { expect(isValidOffset(OFFSET_MAX + 1)).toBe(false) })
  test('rejects out of bounds (too small)', () => { expect(isValidOffset(OFFSET_MIN - 1)).toBe(false) })
})

describe('Validation — isValidAnchor', () => {
  test('valid anchors', () => {
    for (const a of POSITIONING_ANCHORS) {
      expect(isValidAnchor(a)).toBe(true)
    }
  })

  test('rejects invalid strings', () => {
    expect(isValidAnchor('bottom-left')).toBe(false)
    expect(isValidAnchor('top-start')).toBe(false)
    expect(isValidAnchor('')).toBe(false)
  })

  test('rejects non-strings', () => {
    expect(isValidAnchor(123)).toBe(false)
    expect(isValidAnchor(null)).toBe(false)
    expect(isValidAnchor(undefined)).toBe(false)
    expect(isValidAnchor({})).toBe(false)
  })
})

// ─── NPM package parity ───────────────────────────────────────────────────

describe('NPM package parity — server vs NPM geometry', () => {
  const testCases: Parameters<typeof computeLauncherPosition>[0][] = [
    { anchor: 'bottom-start', offsetX: 0, offsetY: 0, dir: 'ltr', viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52, safeAreaBottom: 0, baseMargin: 20 },
    { anchor: 'bottom-end', offsetX: 100, offsetY: -50, dir: 'rtl', viewportWidth: 375, viewportHeight: 667, launcherWidth: 60, launcherHeight: 52, safeAreaBottom: 34, baseMargin: 20 },
    { anchor: 'bottom-center', offsetX: -200, offsetY: 2000, dir: 'ltr', viewportWidth: 100, viewportHeight: 100, launcherWidth: 52, launcherHeight: 52, safeAreaBottom: 0, baseMargin: 20 },
    { anchor: 'bottom-start', offsetX: -2000, offsetY: 0, dir: 'rtl', viewportWidth: 320, viewportHeight: 568, launcherWidth: 64, launcherHeight: 48, safeAreaBottom: 0, baseMargin: 20 },
  ]

  for (let i = 0; i < testCases.length; i++) {
    test(`parity case ${i}: server === NPM output`, () => {
      const serverResult = computeLauncherPosition(testCases[i])
      const npmResult = npmComputePosition(testCases[i])
      expect(npmResult.left).toBe(serverResult.left)
      expect(npmResult.bottom).toBe(serverResult.bottom)
      expect(npmResult.panelSide).toBe(serverResult.panelSide)
    })
  }

  test('isValidOffset parity', () => {
    expect(npmIsValidOffset(100)).toBe(isValidOffset(100))
    expect(npmIsValidOffset(NaN)).toBe(isValidOffset(NaN))
    expect(npmIsValidOffset(1.5)).toBe(isValidOffset(1.5))
  })

  test('isValidAnchor parity', () => {
    expect(npmIsValidAnchor('bottom-center')).toBe(isValidAnchor('bottom-center'))
    expect(npmIsValidAnchor('invalid')).toBe(isValidAnchor('invalid'))
  })

  test('offsetXFromAbsoluteLeft parity', () => {
    const params = { dir: 'ltr' as const, viewportWidth: 1000, launcherWidth: 52, baseMargin: 20 }
    expect(npmOffsetXFromLeft('bottom-start', 120, params.dir, params.viewportWidth, params.launcherWidth, params.baseMargin))
      .toBe(offsetXFromAbsoluteLeft('bottom-start', 120, params.dir, params.viewportWidth, params.launcherWidth, params.baseMargin))
  })
})

// ─── V2 parser — positioning fields ───────────────────────────────────────

describe('Appearance V2 parser — positioning fields', () => {
  test('valid: version 1 + desktop positioning with anchor', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-center' } },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-center')
  })

  test('valid: both desktop + mobile positioning', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-start', offsetX: 100, offsetY: -50 } },
      mobile: { positioning: { anchor: 'bottom-center' } },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-start')
    expect(parsed!.desktop?.positioning?.offsetX).toBe(100)
    expect(parsed!.desktop?.positioning?.offsetY).toBe(-50)
    expect(parsed!.mobile?.positioning?.anchor).toBe('bottom-center')
  })

  test('valid: no positioning (empty device appearance)', () => {
    const parsed = parseAppearanceV2({ version: 1, desktop: {}, mobile: {} })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop?.positioning).toBeUndefined()
  })

  test('valid: only desktop positioning, mobile absent', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end' } },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-end')
    expect(parsed!.mobile).toEqual({})
  })

  test('rejects: invalid anchor', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'top-left' } },
    })).toBeNull()
  })

  test('rejects: missing anchor in positioning', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { offsetX: 100 } },
    })).toBeNull()
  })

  test('rejects: offsetX as string', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: '100' } },
    })).toBeNull()
  })

  test('rejects: offsetX as NaN', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: NaN } },
    })).toBeNull()
  })

  test('rejects: offsetX as Infinity', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: Infinity } },
    })).toBeNull()
  })

  test('rejects: offsetX as fraction', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 1.5 } },
    })).toBeNull()
  })

  test('rejects: offsetX out of bounds (> 2000)', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 2001 } },
    })).toBeNull()
  })

  test('rejects: offsetX out of bounds (< -2000)', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: -2001 } },
    })).toBeNull()
  })

  test('rejects: unexpected key in positioning', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', z: 999 } },
    })).toBeNull()
  })

  test('rejects: unexpected key in device appearance', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end' }, color: '#fff' },
    })).toBeNull()
  })

  test('rejects: positioning not an object', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: 'bottom-end' },
    })).toBeNull()
  })

  test('rejects: positioning as array', () => {
    expect(parseAppearanceV2({
      version: 1,
      desktop: { positioning: [] },
    })).toBeNull()
  })

  test('rejects: Symbol key in positioning', () => {
    const sym = Symbol('test')
    const obj = { version: 1, desktop: { positioning: { anchor: 'bottom-end' } } }
    ;(obj.desktop as Record<string, unknown>).positioning = { anchor: 'bottom-end', [sym]: 'evil' }
    expect(parseAppearanceV2(obj)).toBeNull()
  })

  test('returns canonical object (not raw input reference)', () => {
    const input = { version: 1, desktop: { positioning: { anchor: 'bottom-end' } } }
    const parsed = parseAppearanceV2(input)
    expect(parsed).not.toBe(input)
    expect(parsed!.desktop).not.toBe(input.desktop)
    expect(parsed!.desktop?.positioning).not.toBe(input.desktop?.positioning)
  })

  test('Proxy with throwing get trap → null (does not throw)', () => {
    const evil = new Proxy({ anchor: 'bottom-end' }, {
      get() { throw new Error('boom') },
    })
    expect(() => parseAppearanceV2({
      version: 1,
      desktop: { positioning: evil },
    })).not.toThrow()
    // The Proxy will fail the plain-object check or descriptor reading → null
    // (depends on how the Proxy is constructed, but it must NEVER throw)
  })

  test('revoked Proxy → null (does not throw)', () => {
    const obj: Record<string, unknown> = { anchor: 'bottom-end' }
    const proxy = Proxy.revocable(obj, {})
    proxy.revoke()
    expect(() => parseAppearanceV2({
      version: 1,
      desktop: { positioning: proxy.proxy },
    })).not.toThrow()
  })
})

// ─── Effective positioning resolver ───────────────────────────────────────

describe('Effective positioning resolver — entitlement enforcement', () => {
  const freeEnt = getEntitlements('free')
  const proEnt = getEntitlements('pro')

  test('Free: V2 positioning with offsets → offsets NOT applied (anchor only)', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-center', offsetX: 100, offsetY: 50 } },
      },
    }
    const eff = resolveEffectivePositioning(stored, freeEnt, 'desktop')
    expect(eff.anchor).toBe('bottom-center')
    expect(eff.offsetX).toBe(0) // Free: offsets NOT applied
    expect(eff.offsetY).toBe(0)
  })

  test('Pro: V2 positioning with offsets → offsets applied', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-center', offsetX: 100, offsetY: 50 } },
      },
    }
    const eff = resolveEffectivePositioning(stored, proEnt, 'desktop')
    expect(eff.anchor).toBe('bottom-center')
    expect(eff.offsetX).toBe(100)
    expect(eff.offsetY).toBe(50)
  })

  test('Free: V2 positioning anchor only → anchor applied', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-start' } },
      },
    }
    const eff = resolveEffectivePositioning(stored, freeEnt, 'desktop')
    expect(eff.anchor).toBe('bottom-start')
    expect(eff.offsetX).toBe(0)
    expect(eff.offsetY).toBe(0)
  })

  test('No V2 → fall back to V1 position', () => {
    const stored: StoredPositioningInput = { position: 'bottom-start', appearanceV2: null }
    const eff = resolveEffectivePositioning(stored, freeEnt, 'desktop')
    expect(eff.anchor).toBe('bottom-start')
    expect(eff.offsetX).toBe(0)
    expect(eff.offsetY).toBe(0)
  })

  test('Unknown V1 position → fail closed to default', () => {
    const stored: StoredPositioningInput = { position: 'top-left', appearanceV2: null }
    const eff = resolveEffectivePositioning(stored, freeEnt, 'desktop')
    expect(eff.anchor).toBe(DEFAULT_POSITIONING.anchor)
  })

  test('Unknown plan (null entitlements) → fail closed to default', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-start',
      appearanceV2: { version: 1, desktop: { positioning: { anchor: 'bottom-center', offsetX: 100 } } },
    }
    const eff = resolveEffectivePositioning(stored, null, 'desktop')
    expect(eff.anchor).toBe(DEFAULT_POSITIONING.anchor)
    expect(eff.offsetX).toBe(0)
    expect(eff.offsetY).toBe(0)
  })

  test('Malformed V2 → fall back to V1', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: { version: 999 }, // unknown version
    }
    const eff = resolveEffectivePositioning(stored, proEnt, 'desktop')
    expect(eff.anchor).toBe('bottom-end')
  })

  test('Desktop/mobile independence: only desktop has V2', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-start',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-center', offsetX: 50 } },
      },
    }
    const desktop = resolveEffectivePositioning(stored, proEnt, 'desktop')
    const mobile = resolveEffectivePositioning(stored, proEnt, 'mobile')
    expect(desktop.anchor).toBe('bottom-center')
    expect(desktop.offsetX).toBe(50)
    expect(mobile.anchor).toBe('bottom-start') // falls back to V1
    expect(mobile.offsetX).toBe(0)
  })

  test('resolveAllEffectivePositioning: both devices resolved', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-center' } },
        mobile: { positioning: { anchor: 'bottom-start' } },
      },
    }
    const all = resolveAllEffectivePositioning(stored, freeEnt)
    expect(all.desktop.anchor).toBe('bottom-center')
    expect(all.mobile.anchor).toBe('bottom-start')
  })

  test('Downgrade/upgrade: Free ignores stored paid offsets (preserved in storage)', () => {
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-end', offsetX: 200, offsetY: 100 } },
      },
    }
    // Free: offsets NOT applied
    const freeEff = resolveEffectivePositioning(stored, freeEnt, 'desktop')
    expect(freeEff.offsetX).toBe(0)
    expect(freeEff.offsetY).toBe(0)
    // But stored offsets are still there
    const storedPos = getStoredPositioning(stored, 'desktop')
    expect(storedPos?.offsetX).toBe(200)
    expect(storedPos?.offsetY).toBe(100)
    // Upgrade to Pro: offsets restored
    const proEff = resolveEffectivePositioning(stored, proEnt, 'desktop')
    expect(proEff.offsetX).toBe(200)
    expect(proEff.offsetY).toBe(100)
  })

  test('Downgrade/upgrade: Free edits anchor without destroying paid offsets', () => {
    // Simulate: Pro stored offsets, then Free edits anchor only.
    // The stored V2 should have the new anchor + the preserved offsets.
    const stored: StoredPositioningInput = {
      position: 'bottom-end',
      appearanceV2: {
        version: 1,
        desktop: { positioning: { anchor: 'bottom-center', offsetX: 200, offsetY: 100 } },
      },
    }
    // Free edits anchor to bottom-start (via mergePositioningPatch)
    const merged = mergePositioningPatch(stored.appearanceV2, {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    })
    const newStored: StoredPositioningInput = {
      position: stored.position,
      appearanceV2: merged,
    }
    // Free effective: new anchor, no offsets
    const freeEff = resolveEffectivePositioning(newStored, freeEnt, 'desktop')
    expect(freeEff.anchor).toBe('bottom-start')
    expect(freeEff.offsetX).toBe(0)
    // But stored offsets preserved
    const storedPos = getStoredPositioning(newStored, 'desktop')
    expect(storedPos?.offsetX).toBe(200) // preserved!
    expect(storedPos?.offsetY).toBe(100) // preserved!
    // Upgrade to Pro: new anchor + restored offsets
    const proEff = resolveEffectivePositioning(newStored, proEnt, 'desktop')
    expect(proEff.anchor).toBe('bottom-start')
    expect(proEff.offsetX).toBe(200)
    expect(proEff.offsetY).toBe(100)
  })
})

// ─── Legacy V1 position derivation ────────────────────────────────────────

describe('deriveLegacyPosition — V1 compatibility', () => {
  test('bottom-start → bottom-start', () => {
    expect(deriveLegacyPosition({ anchor: 'bottom-start', offsetX: 0, offsetY: 0 })).toBe('bottom-start')
  })
  test('bottom-end → bottom-end', () => {
    expect(deriveLegacyPosition({ anchor: 'bottom-end', offsetX: 0, offsetY: 0 })).toBe('bottom-end')
  })
  test('bottom-center → bottom-end (V1 has no center)', () => {
    expect(deriveLegacyPosition({ anchor: 'bottom-center', offsetX: 0, offsetY: 0 })).toBe('bottom-end')
  })
})

// ─── Positioning PATCH validation ──────────────────────────────────────────

describe('Positioning PATCH validation', () => {
  const freeEnt = getEntitlements('free')
  const proEnt = getEntitlements('pro')

  test('Free: valid anchor-only patch → ok', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-center' } },
    }, freeEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.desktop?.anchor).toBe('bottom-center')
      expect(result.data.desktop?.offsetX).toBeUndefined()
    }
  })

  test('Free: anchor for both devices → ok', () => {
    const result = validatePositioningPatch({
      positioning: {
        desktop: { anchor: 'bottom-start' },
        mobile: { anchor: 'bottom-center' },
      },
    }, freeEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.desktop?.anchor).toBe('bottom-start')
      expect(result.data.mobile?.anchor).toBe('bottom-center')
    }
  })

  test('Free: offsetX → rejected (positioning_offset_not_allowed)', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 100 } },
    }, freeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_not_allowed')
  })

  test('Free: offsetY → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetY: 50 } },
    }, freeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_not_allowed')
  })

  test('Pro: anchor + offsets → ok', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 100, offsetY: -50 } },
    }, proEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.desktop?.offsetX).toBe(100)
      expect(result.data.desktop?.offsetY).toBe(-50)
    }
  })

  test('Pro: offsetX out of bounds → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 2001 } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_out_of_bounds')
  })

  test('Pro: offsetX as NaN → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: NaN } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_invalid')
  })

  test('Pro: offsetX as string → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: '100' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_invalid')
  })

  test('Pro: offsetX as fraction → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 1.5 } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_invalid')
  })

  test('Invalid anchor → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'top-left' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_anchor_invalid')
  })

  test('Missing anchor (only offsets) → ok for Pro (anchor unchanged)', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { offsetX: 100 } },
    }, proEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.desktop?.anchor).toBeUndefined()
      expect(result.data.desktop?.offsetX).toBe(100)
    }
  })

  test('Unexpected key in positioning → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end' }, evil: true },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_unexpected_key')
  })

  test('Unexpected key in device patch → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', color: '#fff' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_unexpected_key')
  })

  test('No positioning fields → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: {} },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_no_fields')
  })

  test('positioning not an object → rejected', () => {
    const result = validatePositioningPatch({
      positioning: 'bottom-end',
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_not_object')
  })

  test('device not an object → rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: 'bottom-end' },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_device_not_object')
  })

  test('null entitlements (unknown plan) → offsets rejected', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 100 } },
    }, null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_offset_not_allowed')
  })

  test('null entitlements: anchor-only → ok (presets allowed even for unknown plans)', () => {
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-center' } },
    }, null)
    expect(result.ok).toBe(true)
  })
})

// ─── Positioning PATCH merge (true-patch + downgrade preservation) ────────

describe('Positioning PATCH merge — true-patch + preservation', () => {
  test('Editing desktop does NOT reset mobile', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 100 } },
      mobile: { positioning: { anchor: 'bottom-center' } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    })
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-start') // updated
    expect(merged.desktop?.positioning?.offsetX).toBe(100) // preserved!
    expect(merged.mobile?.positioning?.anchor).toBe('bottom-center') // unchanged
  })

  test('Editing mobile does NOT reset desktop', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end' } },
      mobile: { positioning: { anchor: 'bottom-start' } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      mobile: { anchor: 'bottom-center', hasFields: true },
    })
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-end') // unchanged
    expect(merged.mobile?.positioning?.anchor).toBe('bottom-center') // updated
  })

  test('Editing anchor does NOT reset offsets (same device)', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 200, offsetY: 100 } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    })
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-start') // updated
    expect(merged.desktop?.positioning?.offsetX).toBe(200) // preserved!
    expect(merged.desktop?.positioning?.offsetY).toBe(100) // preserved!
  })

  test('Editing offsetX does NOT reset anchor or offsetY', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 100, offsetY: 50 } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { offsetX: 200, hasFields: true },
    })
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-end') // unchanged
    expect(merged.desktop?.positioning?.offsetX).toBe(200) // updated
    expect(merged.desktop?.positioning?.offsetY).toBe(50) // preserved!
  })

  test('No existing V2 → creates fresh with defaults', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { anchor: 'bottom-center', hasFields: true },
    })
    expect(merged.version).toBe(1)
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-center')
    expect(merged.mobile).toEqual({}) // empty (no mobile patch)
  })

  test('Free edits anchor → paid offsets preserved in merged result', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 200, offsetY: 100 } },
    }
    // Free edits anchor only (no offsets in the patch)
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    })
    // The merged result preserves the paid offsets
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-start')
    expect(merged.desktop?.positioning?.offsetX).toBe(200) // preserved!
    expect(merged.desktop?.positioning?.offsetY).toBe(100) // preserved!
  })

  test('Malformed existing V2 → start fresh', () => {
    const merged = mergePositioningPatch({ version: 999 }, {
      hasAny: true,
      desktop: { anchor: 'bottom-center', hasFields: true },
    })
    expect(merged.version).toBe(1)
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-center')
  })

  test('Returns canonical object (not the input reference)', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end' } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    })
    expect(merged).not.toBe(existing)
    expect(merged.desktop).not.toBe(existing.desktop)
  })
})

// ─── Field detection helpers ──────────────────────────────────────────────

describe('Field detection — hasOtherCustomizationFields + hasPositioningField', () => {
  test('hasPositioningField: true when positioning present', () => {
    expect(hasPositioningField({ positioning: { desktop: {} } })).toBe(true)
  })
  test('hasPositioningField: false when positioning absent', () => {
    expect(hasPositioningField({ accentColor: '#fff' })).toBe(false)
  })
  test('hasOtherCustomizationFields: true for accentColor', () => {
    expect(hasOtherCustomizationFields({ accentColor: '#fff' })).toBe(true)
  })
  test('hasOtherCustomizationFields: true for position', () => {
    expect(hasOtherCustomizationFields({ position: 'bottom-end' })).toBe(true)
  })
  test('hasOtherCustomizationFields: false for positioning only', () => {
    expect(hasOtherCustomizationFields({ positioning: { desktop: {} } })).toBe(false)
  })
  test('hasOtherCustomizationFields: true when both positioning + color', () => {
    expect(hasOtherCustomizationFields({ positioning: {}, accentColor: '#fff' })).toBe(true)
  })
})
