/// <reference types="bun-types" />
/**
 * PR #18 ONLY — Widget V2 Launcher Styles security, entitlement and
 * cross-feature persistence regression. Independent CI-owned tests.
 */
import { describe, test, expect } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import {
  resolveEffectiveLauncher, isValidLauncherShape, getStoredLauncherShape,
} from '../../src/lib/widget/effective-launcher'
import {
  validateLauncherPatch, mergeLauncherPatch,
} from '../../src/lib/widget/launcher-patch'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const INVALID = getEntitlements('not-a-real-plan')
const original = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-start' as const, offsetX: 53, offsetY: -17 } },
  mobile: { positioning: { anchor: 'bottom-center' as const, offsetX: -32, offsetY: 19 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'pill' as const },
}

describe('launcher entitlements and V1 compatibility', () => {
  test('all three canonical shapes, no unexpected values', () => {
    for (const shape of ['tab', 'rounded', 'pill']) expect(isValidLauncherShape(shape)).toBe(true)
    for (const bad of ['', 'circle', 'PILL', null, 2, [], {}, '__proto__']) expect(isValidLauncherShape(bad)).toBe(false)
  })
  test('Free limited, Pro full, unknown fail closed', () => {
    expect(FREE?.launcherSelection).toBe('limited')
    expect(PRO?.launcherSelection).toBe('all')
    expect(INVALID).toBeNull()
    expect(resolveEffectiveLauncher(original, INVALID).shape).toBe('tab')
  })
  test('V1 never-adopted: paid pill, Free rounded, Free pill locked', () => {
    expect(resolveEffectiveLauncher({ launcherShape: 'pill' }, PRO).shape).toBe('pill')
    expect(resolveEffectiveLauncher({ launcherShape: 'pill' }, FREE).shape).toBe('tab')
    expect(resolveEffectiveLauncher({ launcherShape: 'rounded' }, FREE).shape).toBe('rounded')
    expect(resolveEffectiveLauncher({ launcherShape: 'tab' }, FREE).shape).toBe('tab')
    expect(getStoredLauncherShape({ launcherShape: 'pill' })).toBeNull()
  })
  test('V2 selection wins over V1 without leaking paid shape to Free', () => {
    const input = { launcherShape: 'rounded', appearanceV2: original }
    expect(resolveEffectiveLauncher(input, PRO).shape).toBe('pill')
    expect(resolveEffectiveLauncher(input, FREE).shape).toBe('tab')
  })
  test('bad V2 shape fails safely instead of exposing forbidden styling', () => {
    expect(resolveEffectiveLauncher({ launcherShape: 'tab', appearanceV2: { version: 1, launcher: { shape: 'script' } } }, FREE).shape).toBe('tab')
  })
})

describe('strict launcher PATCH authorization', () => {
  test('Free accepts tab and rounded; explicitly rejects pill', () => {
    for (const shape of ['tab', 'rounded']) expect(validateLauncherPatch({ launcher: { shape } }, FREE).ok).toBe(true)
    expect(validateLauncherPatch({ launcher: { shape: 'pill' } }, FREE)).toEqual({ ok: false, code: 'launcher_shape_not_allowed' })
  })
  test('Pro accepts all shapes, unknown plans never accept patches', () => {
    for (const shape of ['tab', 'rounded', 'pill']) expect(validateLauncherPatch({ launcher: { shape } }, PRO).ok).toBe(true)
    expect(validateLauncherPatch({ launcher: { shape: 'tab' } }, INVALID).ok).toBe(false)
  })
  test('rejects malformed and extra/contradictory keys', () => {
    for (const payload of [null, [], 'pill', {}, { shape: null }, { shape: 'Pill' }, { shape: 'pill', paidShape: 'pill' }, { shape: 'rounded', extra: true }]) {
      expect(validateLauncherPatch({ launcher: payload }, PRO).ok).toBe(false)
    }
  })
  test('only canonical launcher patch keys may mutate the active shape', () => {
    expect(validateLauncherPatch({ launcher: { shape: 'pill' } }, PRO)).toEqual({ ok: true, data: { shape: 'pill' } })
  })
})

describe('true-patch invariants across V2 features', () => {
  test('launcher edit must preserve existing custom/preset colors and both device positions', () => {
    const out = mergeLauncherPatch(original, { shape: 'rounded' }, PRO)
    expect(out.colors).toEqual(original.colors)
    expect(out.desktop).toEqual(original.desktop)
    expect(out.mobile).toEqual(original.mobile)
    expect(out.launcher?.shape).toBe('rounded')
    expect(parseAppearanceV2(out)).not.toBeNull()
  })
  test('even an idempotent launcher save must preserve colors', () => {
    const out = mergeLauncherPatch(original, { shape: 'pill' }, PRO)
    expect(out.colors).toEqual(original.colors)
  })
  test('subsequent color updates must NOT remove launcher', () => {
    const out = mergeColorPatch(original, { theme: { mode: 'preset', presetId: 'sunset' } })
    expect(out.launcher).toEqual(original.launcher)
    expect(out.desktop).toEqual(original.desktop)
  })
  test('subsequent positioning updates must NOT remove launcher or colors', () => {
    const out = mergePositioningPatch(original, { desktop: { anchor: 'bottom-end', hasFields: true } }, 'bottom-end')
    expect(out.launcher).toEqual(original.launcher)
    expect(out.colors).toEqual(original.colors)
    expect(out.mobile).toEqual(original.mobile)
  })
  test('combined patch order must not destroy a neighboring V2 feature', () => {
    const pos = mergePositioningPatch(original, { mobile: { anchor: 'bottom-start', hasFields: true } }, 'bottom-end')
    const color = mergeColorPatch(pos, { theme: { mode: 'preset', presetId: 'sunset' } })
    const launch = mergeLauncherPatch(color, { shape: 'rounded' }, PRO)
    expect(launch.colors?.presetId).toBe('sunset')
    expect(launch.desktop).toEqual(original.desktop)
    expect(launch.mobile?.positioning?.anchor).toBe('bottom-start')
    expect(launch.launcher?.shape).toBe('rounded')
  })
})

describe('paid launcher downgrade/upgrade restoration', () => {
  test('Pro pill -> Free rounded preserves paid choice without rendering it', () => {
    const out = mergeLauncherPatch(original, { shape: 'rounded' }, FREE)
    expect(out.launcher).toEqual({ shape: 'rounded', paidShape: 'pill' })
    expect(resolveEffectiveLauncher({ appearanceV2: out }, FREE).shape).toBe('rounded')
  })
  test('upgrade to Pro restores preserved pill, not Free rounded', () => {
    const downgraded = mergeLauncherPatch(original, { shape: 'rounded' }, FREE)
    expect(resolveEffectiveLauncher({ appearanceV2: downgraded }, PRO).shape).toBe('pill')
  })
  test('Free saves tab and switches presets without erasing paid selection', () => {
    const first = mergeLauncherPatch(original, { shape: 'rounded' }, FREE)
    const second = mergeLauncherPatch(first, { shape: 'tab' }, FREE)
    expect(second.launcher?.paidShape).toBe('pill')
    expect(resolveEffectiveLauncher({ appearanceV2: second }, PRO).shape).toBe('pill')
  })
  test('Pro explicitly choosing a different shape replaces old paid preference', () => {
    const free = mergeLauncherPatch(original, { shape: 'rounded' }, FREE)
    const changed = mergeLauncherPatch(free, { shape: 'tab' }, PRO)
    expect(resolveEffectiveLauncher({ appearanceV2: changed }, PRO).shape).toBe('tab')
  })
})

describe('appearance parsing boundaries', () => {
  test('new launcher coexists with positioning and color theme in one V2 object', () => {
    expect(parseAppearanceV2(original)).toEqual(original)
  })
  test('rejects invalid or exotic launcher shapes without throwing', () => {
    const cases: unknown[] = [
      { version: 1, launcher: { shape: 'rounded', other: 1 } },
      { version: 1, launcher: { shape: 'bad' } },
      { version: 1, launcher: [] },
      { version: 1, launcher: { shape: 'tab', paidShape: 'bad' } },
      { version: 1, launcher: { get shape() { throw new Error('not safe') } } },
    ]
    for (const item of cases) expect(parseAppearanceV2(item)).toBeNull()
  })
  test('paidShape must denote a paid-only shape, not an arbitrary Free shape', () => {
    expect(parseAppearanceV2({ version: 1, launcher: { shape: 'rounded', paidShape: 'tab' } })).toBeNull()
  })
})
