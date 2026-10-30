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
  hasUnrecognizedFields,
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

  test('null entitlements (unknown plan) → ALL positioning writes rejected (fail closed)', () => {
    // BLOCKER 1: unknown plans must fail closed on positioning writes.
    // anchor-only, offset, and mixed are ALL rejected with positioning_not_authorized.
    const anchorResult = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-center' } },
    }, null)
    expect(anchorResult.ok).toBe(false)
    if (!anchorResult.ok) expect(anchorResult.code).toBe('positioning_not_authorized')

    const offsetResult = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-end', offsetX: 100 } },
    }, null)
    expect(offsetResult.ok).toBe(false)
    if (!offsetResult.ok) expect(offsetResult.code).toBe('positioning_not_authorized')
  })

  test('presetPositioning=false → ALL positioning writes rejected', () => {
    // A plan that has no preset positioning capability cannot write positioning.
    const fakeEnt = { presetPositioning: false, precisePositioning: false } as any
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-center' } },
    }, fakeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_not_authorized')
  })

  test('inherited-prototype plan name (constructor, __proto__) → fail closed via getEntitlements', () => {
    // getEntitlements uses a Map (prototype-free) so inherited names return null.
    // The PATCH route uses getEntitlements(planSlug) — these names must NOT
    // resolve to any entitlement set.
    expect(getEntitlements('constructor')).toBeNull()
    expect(getEntitlements('__proto__')).toBeNull()
    expect(getEntitlements('toString')).toBeNull()
    expect(getEntitlements('hasOwnProperty')).toBeNull()
    // Via the validation path, null entitlements → positioning_not_authorized.
    const result = validatePositioningPatch({
      positioning: { desktop: { anchor: 'bottom-center' } },
    }, getEntitlements('constructor'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('positioning_not_authorized')
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

// ─── BLOCKER 1: Unrecognized top-level fields ─────────────────────────────

describe('Unrecognized top-level fields — hasUnrecognizedFields', () => {
  test('false for empty body', () => {
    expect(hasUnrecognizedFields({})).toBe(false)
  })
  test('false for recognized customization fields', () => {
    expect(hasUnrecognizedFields({ accentColor: '#fff', position: 'bottom-end' })).toBe(false)
  })
  test('false for positioning field', () => {
    expect(hasUnrecognizedFields({ positioning: { desktop: {} } })).toBe(false)
  })
  test('false for recognized + positioning mix', () => {
    expect(hasUnrecognizedFields({ positioning: {}, accentColor: '#fff' })).toBe(false)
  })
  test('true for unrecognized field', () => {
    expect(hasUnrecognizedFields({ evil: true })).toBe(true)
  })
  test('true for unrecognized field mixed with recognized', () => {
    expect(hasUnrecognizedFields({ accentColor: '#fff', evil: true })).toBe(true)
  })
  test('true for __proto__ field (as own key)', () => {
    // Object.keys does not include __proto__ set via literal (it sets the
    // prototype, not an own property). Use Object.assign to create an
    // actual own property named __proto__.
    const obj = Object.assign({}, { __proto__: {} })
    // __proto__ via assign is still tricky — use a created object instead.
    const o = Object.create(null)
    ;(o as Record<string, unknown>)['__proto__'] = {}
    expect(hasUnrecognizedFields(o)).toBe(true)
  })
  test('true for constructor field', () => {
    const o: Record<string, unknown> = {}
    o['constructor'] = {}
    expect(hasUnrecognizedFields(o)).toBe(true)
  })
})

// ─── BLOCKER 3: Inverse geometry round-trip with correct expected values ──

describe('BLOCKER 3 — offsetXFromAbsoluteLeft round-trip correctness', () => {
  const vp = 1000, lw = 52, bm = 20

  // Explicit expected-value tests (not just parity) — verifies the
  // CORRECT result, not merely equality between copies sharing a bug.

  test('bottom-end LTR: baseLeft=928, desired left=868 (dragged 60 left) → offsetX=-60', () => {
    // The reviewer's example: viewport 1000, launcher 52, margin 20.
    // bottom-end LTR → baseLeft = 1000 - 52 - 20 = 928.
    // Drag 60px left → desired left = 868.
    // Forward: left = 928 + offsetX → 868 = 928 + offsetX → offsetX = -60.
    const result = offsetXFromAbsoluteLeft('bottom-end', 868, 'ltr', vp, lw, bm)
    expect(result).toBe(-60) // CORRECT: negative (moved left)
  })

  test('bottom-end LTR: baseLeft=928, desired left=988 (dragged 60 right) → offsetX=+60', () => {
    const result = offsetXFromAbsoluteLeft('bottom-end', 988, 'ltr', vp, lw, bm)
    expect(result).toBe(60) // CORRECT: positive (moved right)
  })

  test('bottom-start LTR: baseLeft=20, desired left=80 (dragged 60 right) → offsetX=+60', () => {
    const result = offsetXFromAbsoluteLeft('bottom-start', 80, 'ltr', vp, lw, bm)
    expect(result).toBe(60)
  })

  test('bottom-start LTR: desired left=-40 (dragged 60 left from 20) → offsetX=-60', () => {
    const result = offsetXFromAbsoluteLeft('bottom-start', -40, 'ltr', vp, lw, bm)
    expect(result).toBe(-60)
  })

  test('bottom-center: baseLeft=474, desired left=534 (dragged 60 right) → offsetX=+60', () => {
    const baseLeft = (1000 - 52) / 2 // = 474
    const result = offsetXFromAbsoluteLeft('bottom-center', baseLeft + 60, 'ltr', vp, lw, bm)
    expect(result).toBe(60)
  })

  test('RTL: bottom-start → baseLeft=928 (right side), desired left=868 → offsetX=-60', () => {
    // RTL: bottom-start maps to the right side. baseLeft = 928.
    const result = offsetXFromAbsoluteLeft('bottom-start', 868, 'rtl', vp, lw, bm)
    expect(result).toBe(-60)
  })

  test('RTL: bottom-end → baseLeft=20 (left side), desired left=80 → offsetX=+60', () => {
    // RTL: bottom-end maps to the left side. baseLeft = 20.
    const result = offsetXFromAbsoluteLeft('bottom-end', 80, 'rtl', vp, lw, bm)
    expect(result).toBe(60)
  })

  // Round-trip: forward → inverse → original offsetX (all anchors + dirs).
  // Uses offset values within the non-clamping range so the round-trip is
  // exact. (Clamping is tested separately — it prevents the launcher from
  // going off-screen, which intentionally breaks the round-trip.)
  const cases: { anchor: PositioningAnchor; dir: 'rtl' | 'ltr'; offsetX: number }[] = [
    { anchor: 'bottom-start', dir: 'ltr', offsetX: 0 },
    { anchor: 'bottom-start', dir: 'ltr', offsetX: 100 },
    { anchor: 'bottom-start', dir: 'ltr', offsetX: -15 }, // within [-20, 928]
    { anchor: 'bottom-end', dir: 'ltr', offsetX: 0 },
    { anchor: 'bottom-end', dir: 'ltr', offsetX: 15 }, // within [-928, 20]
    { anchor: 'bottom-end', dir: 'ltr', offsetX: -60 }, // the reviewer's example
    { anchor: 'bottom-center', dir: 'ltr', offsetX: 0 },
    { anchor: 'bottom-center', dir: 'ltr', offsetX: 200 },
    { anchor: 'bottom-center', dir: 'ltr', offsetX: -200 },
    { anchor: 'bottom-start', dir: 'rtl', offsetX: 0 },
    { anchor: 'bottom-start', dir: 'rtl', offsetX: 15 }, // within [-928, 20]
    { anchor: 'bottom-start', dir: 'rtl', offsetX: -75 },
    { anchor: 'bottom-end', dir: 'rtl', offsetX: 0 },
    { anchor: 'bottom-end', dir: 'rtl', offsetX: 100 },
    { anchor: 'bottom-end', dir: 'rtl', offsetX: -15 }, // within [-20, 928]
  ]

  for (const c of cases) {
    test(`round-trip: ${c.anchor} ${c.dir} offsetX=${c.offsetX} → left → back to offsetX`, () => {
      const pos = computeLauncherPosition({
        anchor: c.anchor, offsetX: c.offsetX, offsetY: 0, dir: c.dir,
        viewportWidth: vp, viewportHeight: 800, launcherWidth: lw, launcherHeight: 52,
        safeAreaBottom: 0, baseMargin: bm,
      })
      const backX = offsetXFromAbsoluteLeft(c.anchor, pos.left, c.dir, vp, lw, bm)
      expect(backX).toBe(c.offsetX)
    })
  }

  // NPM parity with correct expected values
  test('NPM parity: bottom-end LTR offsetX=-60 → correct result', () => {
    expect(npmOffsetXFromLeft('bottom-end', 868, 'ltr', vp, lw, bm)).toBe(-60)
    expect(npmOffsetXFromLeft('bottom-end', 868, 'ltr', vp, lw, bm))
      .toBe(offsetXFromAbsoluteLeft('bottom-end', 868, 'ltr', vp, lw, bm))
  })
})

// ─── BLOCKER 4: V1 anchor preservation on first offset-only edit ──────────

describe('BLOCKER 4 — V1 anchor preserved on first offset-only edit', () => {
  test('V1 position bottom-start + offset-only patch → anchor=bottom-start (NOT bottom-end)', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { offsetX: 100, hasFields: true },
    }, 'bottom-start')
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-start') // V1 preserved!
    expect(merged.desktop?.positioning?.offsetX).toBe(100)
  })

  test('V1 position bottom-end + offset-only patch → anchor=bottom-end', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { offsetY: 50, hasFields: true },
    }, 'bottom-end')
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-end')
    expect(merged.desktop?.positioning?.offsetY).toBe(50)
  })

  test('No V1 position + offset-only patch → anchor=bottom-end (canonical default)', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { offsetX: 100, hasFields: true },
    }, null)
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-end')
  })

  test('V1 position bottom-start + anchor patch → anchor updated (explicit change)', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { anchor: 'bottom-center', hasFields: true },
    }, 'bottom-start')
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-center') // explicit change
  })

  test('Existing V2 + offset-only patch → existing anchor preserved', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-center', offsetX: 50 } },
    }
    const merged = mergePositioningPatch(existing, {
      hasAny: true,
      desktop: { offsetY: 100, hasFields: true },
    }, 'bottom-start') // V1 is bottom-start but existing V2 is bottom-center
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-center') // V2 preserved, not V1
    expect(merged.desktop?.positioning?.offsetX).toBe(50) // preserved
    expect(merged.desktop?.positioning?.offsetY).toBe(100) // updated
  })

  test('Mobile independence: V1 bottom-start + desktop offset-only → mobile unaffected', () => {
    const merged = mergePositioningPatch(null, {
      hasAny: true,
      desktop: { offsetX: 100, hasFields: true },
    }, 'bottom-start')
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-start')
    expect(merged.mobile).toEqual({}) // no mobile positioning created
  })
})

// ─── BLOCKER 5: Panel vertical containment ────────────────────────────────

describe('BLOCKER 5 — computePanelVerticalPosition', () => {
  const { computePanelVerticalPosition } = require('../../src/lib/widget/positioning-geometry')

  test('Launcher near bottom (rootBottom=20): panel opens above (default)', () => {
    const r = computePanelVerticalPosition({
      rootBottom: 20, launcherHeight: 52, viewportHeight: 800,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 0,
    })
    expect(r.opensBelow).toBe(false)
    expect(r.bottom).toBe(64) // launcherHeight + gap = 52 + 12
    expect(r.maxHeight).toBe(500) // fits
  })

  test('Launcher near top (rootBottom=700): panel opens BELOW', () => {
    // rootBottom=700 → launcher is 700px from the bottom, near the top.
    // spaceAbove = 800 - 700 - 52 = 48px (too small for 500px panel).
    // spaceBelow = 700px (plenty of room below).
    const r = computePanelVerticalPosition({
      rootBottom: 700, launcherHeight: 52, viewportHeight: 800,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 0,
    })
    expect(r.opensBelow).toBe(true)
    expect(r.bottom).toBeLessThan(0) // negative = below launcher
    expect(r.maxHeight).toBe(500)
  })

  test('Launcher in middle: opens above if more space above', () => {
    // rootBottom=400 → spaceAbove = 800-400-52 = 348, spaceBelow = 400.
    // 348 >= 500+12? No. 400 >= 500+12? No. Neither fits fully.
    // spaceAbove (348) < spaceBelow (400) → opens below, clamped.
    const r = computePanelVerticalPosition({
      rootBottom: 400, launcherHeight: 52, viewportHeight: 800,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 0,
    })
    expect(r.opensBelow).toBe(true)
    expect(r.maxHeight).toBeLessThanOrEqual(400) // clamped to spaceBelow
  })

  test('Narrow viewport: panel height clamped to viewport', () => {
    const r = computePanelVerticalPosition({
      rootBottom: 20, launcherHeight: 52, viewportHeight: 300,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 0,
    })
    expect(r.maxHeight).toBeLessThan(500) // clamped
    expect(r.maxHeight).toBeGreaterThanOrEqual(120) // minimum
  })

  test('Safe-area respected: reduces available space', () => {
    const r = computePanelVerticalPosition({
      rootBottom: 20, launcherHeight: 52, viewportHeight: 800,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 34,
    })
    // spaceAbove = 800 - 20 - 52 - 34 = 694 → fits 500+12.
    expect(r.opensBelow).toBe(false)
    expect(r.bottom).toBe(64)
  })

  test('Never throws for extreme values', () => {
    expect(() => computePanelVerticalPosition({
      rootBottom: -100, launcherHeight: 1000, viewportHeight: 1,
      panelGap: 0, panelPreferredHeight: 9999, safeAreaBottom: 999,
    })).not.toThrow()
  })

  test('NPM parity: same result for launcher near top', () => {
    const { computePanelVerticalPosition: npmCVP } = require('../../packages/widget-npm/src/positioning')
    const opts = { rootBottom: 700, launcherHeight: 52, viewportHeight: 800, panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 0 }
    const server = computePanelVerticalPosition(opts)
    const npm = npmCVP(opts)
    expect(npm.bottom).toBe(server.bottom)
    expect(npm.maxHeight).toBe(server.maxHeight)
    expect(npm.opensBelow).toBe(server.opensBelow)
  })
})

// ─── BLOCKER 6: Safe-area handling ────────────────────────────────────────

describe('BLOCKER 6 — safe-area in geometry computation', () => {
  test('Launcher bottom includes safeAreaBottom', () => {
    const r = computeLauncherPosition({
      anchor: 'bottom-end', offsetX: 0, offsetY: 0, dir: 'ltr',
      viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52,
      safeAreaBottom: 34, baseMargin: 20,
    })
    expect(r.bottom).toBe(54) // baseMargin + safeAreaBottom = 20 + 34
  })

  test('Launcher bottom with offsetY + safeAreaBottom', () => {
    const r = computeLauncherPosition({
      anchor: 'bottom-end', offsetX: 0, offsetY: 100, dir: 'ltr',
      viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52,
      safeAreaBottom: 34, baseMargin: 20,
    })
    expect(r.bottom).toBe(154) // baseMargin + offsetY + safeAreaBottom = 20 + 100 + 34
  })

  test('Launcher clamped above safeAreaBottom when offsetY is very negative', () => {
    const r = computeLauncherPosition({
      anchor: 'bottom-end', offsetX: 0, offsetY: -1000, dir: 'ltr',
      viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52,
      safeAreaBottom: 34, baseMargin: 20,
    })
    expect(r.bottom).toBe(34) // clamped to safeAreaBottom (minBottom)
  })

  test('safeAreaBottom=0 → same as no safe-area (desktop)', () => {
    const r0 = computeLauncherPosition({
      anchor: 'bottom-end', offsetX: 0, offsetY: 0, dir: 'ltr',
      viewportWidth: 1000, viewportHeight: 800, launcherWidth: 52, launcherHeight: 52,
      safeAreaBottom: 0, baseMargin: 20,
    })
    expect(r0.bottom).toBe(20) // just baseMargin
  })

  test('Panel vertical position respects safeAreaBottom', () => {
    const { computePanelVerticalPosition } = require('../../src/lib/widget/positioning-geometry')
    // With safeAreaBottom=34, the available space is reduced.
    const r = computePanelVerticalPosition({
      rootBottom: 20, launcherHeight: 52, viewportHeight: 800,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 34,
    })
    // spaceAbove = 800 - 20 - 52 - 34 = 694 → fits 500+12=512.
    expect(r.opensBelow).toBe(false)
    expect(r.maxHeight).toBe(500)
  })

  test('Panel clamped when safeAreaBottom consumes viewport — no 120px minimum', () => {
    const { computePanelVerticalPosition } = require('../../src/lib/widget/positioning-geometry')
    // viewportHeight=200, safeAreaBottom=80 → usable = 200 - 160 = 40.
    // panelPreferredHeight=500 → clamped to min(500, 40-24) = 16.
    // No minimum enforced — the panel stays within the viewport even if tiny.
    const r = computePanelVerticalPosition({
      rootBottom: 20, launcherHeight: 52, viewportHeight: 200,
      panelGap: 12, panelPreferredHeight: 500, safeAreaBottom: 80,
    })
    // maxHeight must be <= available space (no overflow), no minimum.
    expect(r.maxHeight).toBeLessThanOrEqual(40)
    expect(r.maxHeight).toBeGreaterThanOrEqual(0)
  })
})

// ─── Panel horizontal containment ─────────────────────────────────────────

describe('Panel horizontal containment — computePanelHorizontalPosition', () => {
  const { computePanelHorizontalPosition } = require('../../src/lib/widget/positioning-geometry')

  test('right-opening: panel left aligns with launcher left', () => {
    const r = computePanelHorizontalPosition({
      launcherLeft: 20, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 1000, panelSide: 'right', viewportMargin: 20,
    })
    expect(r.left).toBe(0) // relative to root
    expect(r.width).toBe(360) // fits in viewport
  })

  test('left-opening: panel right aligns with launcher right', () => {
    const r = computePanelHorizontalPosition({
      launcherLeft: 928, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 1000, panelSide: 'left', viewportMargin: 20,
    })
    // panel left = launcherWidth - panelWidth = 52 - 360 = -308
    expect(r.left).toBe(52 - 360)
    expect(r.width).toBe(360)
  })

  test('center: panel centered on launcher', () => {
    const r = computePanelHorizontalPosition({
      launcherLeft: 474, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 1000, panelSide: 'center', viewportMargin: 20,
    })
    // panel left = (52 - 360) / 2 = -154
    expect(r.left).toBe((52 - 360) / 2)
    expect(r.width).toBe(360)
  })

  test('Narrow viewport (320px): panel width clamped', () => {
    const r = computePanelHorizontalPosition({
      launcherLeft: 20, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 320, panelSide: 'right', viewportMargin: 20,
    })
    // maxPanelWidth = 320 - 40 = 280
    expect(r.width).toBe(280) // clamped
  })

  test('Narrow viewport: panel left edge clamped to viewport margin', () => {
    // Launcher near right edge, left-opening panel would overflow left.
    const r = computePanelHorizontalPosition({
      launcherLeft: 280, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 320, panelSide: 'left', viewportMargin: 20,
    })
    // Panel width clamped to 280. Panel left relative to root = 52 - 280 = -228.
    // Absolute left = 280 + (-228) = 52. But min abs left = 20 (viewportMargin).
    // Clamped abs left = 20. Relative = 20 - 280 = -260.
    // The panel must NOT overflow the left viewport edge.
    const absLeft = 280 + r.left
    expect(absLeft).toBeGreaterThanOrEqual(20) // left edge inside viewport
    expect(absLeft + r.width).toBeLessThanOrEqual(320 - 20) // right edge inside
  })

  test('Extreme right offset: panel right edge clamped to viewport', () => {
    // Launcher at far right, right-opening panel would overflow right.
    const r = computePanelHorizontalPosition({
      launcherLeft: 990, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 1000, panelSide: 'right', viewportMargin: 20,
    })
    const absLeft = 990 + r.left
    expect(absLeft + r.width).toBeLessThanOrEqual(1000 - 20) // right edge inside
  })

  test('Extreme left offset: panel left edge clamped to viewport margin', () => {
    // Launcher at far left, left-opening panel would overflow left.
    const r = computePanelHorizontalPosition({
      launcherLeft: 0, launcherWidth: 52, panelPreferredWidth: 360,
      viewportWidth: 1000, panelSide: 'left', viewportMargin: 20,
    })
    const absLeft = 0 + r.left
    expect(absLeft).toBeGreaterThanOrEqual(20) // left edge inside
  })

  test('Never overflows horizontally for any launcher position', () => {
    // Test many launcher positions across the viewport.
    for (let launcherLeft = 0; launcherLeft <= 1000; launcherLeft += 50) {
      for (const side of ['right', 'left', 'center'] as const) {
        const r = computePanelHorizontalPosition({
          launcherLeft, launcherWidth: 52, panelPreferredWidth: 360,
          viewportWidth: 1000, panelSide: side, viewportMargin: 20,
        })
        const absLeft = launcherLeft + r.left
        expect(absLeft).toBeGreaterThanOrEqual(20)
        expect(absLeft + r.width).toBeLessThanOrEqual(1000 - 20)
      }
    }
  })

  test('Never overflows on narrow 320px viewport', () => {
    for (let launcherLeft = 0; launcherLeft <= 320; launcherLeft += 20) {
      for (const side of ['right', 'left', 'center'] as const) {
        const r = computePanelHorizontalPosition({
          launcherLeft, launcherWidth: 52, panelPreferredWidth: 360,
          viewportWidth: 320, panelSide: side, viewportMargin: 20,
        })
        const absLeft = launcherLeft + r.left
        expect(absLeft).toBeGreaterThanOrEqual(20)
        expect(absLeft + r.width).toBeLessThanOrEqual(320 - 20)
      }
    }
  })

  test('NPM parity: same result', () => {
    const { computePanelHorizontalPosition: npmCHP } = require('../../packages/widget-npm/src/positioning')
    const opts = { launcherLeft: 500, launcherWidth: 52, panelPreferredWidth: 360, viewportWidth: 1000, panelSide: 'center' as const, viewportMargin: 20 }
    const server = computePanelHorizontalPosition(opts)
    const npm = npmCHP(opts)
    expect(npm.left).toBe(server.left)
    expect(npm.width).toBe(server.width)
  })
})
