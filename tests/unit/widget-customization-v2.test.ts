/// <reference types="bun-types" />
/**
 * Widget customization V2 foundation — unit tests (corrected).
 *
 * Tests the pure TS foundation modules (no DB):
 *   - src/lib/payments/widget-entitlements.ts (entitlement model — fail-closed + frozen)
 *   - src/lib/widget/appearance-v2.ts (versioned appearance model — strict parsing)
 *   - src/lib/widget/appearance-resolver.ts (stored normalization — NOT effective)
 */

import { test, expect, describe } from 'bun:test'
import {
  getEntitlements,
  isLegacyCustomizationUnlocked,
} from '../../src/lib/payments/widget-entitlements'
import {
  parseAppearanceV2,
  DEFAULT_APPEARANCE_V2,
  APPEARANCE_V2_VERSION,
  hasAppearanceV2,
} from '../../src/lib/widget/appearance-v2'
import {
  normalizeStoredAppearance,
  type StoredAppearance,
} from '../../src/lib/widget/appearance-resolver'

// ─── Entitlement model — fail-closed + prototype-safe ────────────────────

describe('Widget entitlements — Free vs Pro/Max/Self-hosted', () => {
  test('Free has limited entitlements', () => {
    const e = getEntitlements('free')
    expect(e).not.toBeNull()
    expect(e!.presetPositioning).toBe(true)
    expect(e!.precisePositioning).toBe(false)
    expect(e!.customColors).toBe(false)
    expect(e!.launcherSelection).toBe('limited')
    expect(e!.messagePreview).toBe(false)
    expect(e!.quickReplies).toBe(2)
    expect(e!.legacyCustomizationUnlocked).toBe(false)
  })

  test('Pro has full entitlements', () => {
    const e = getEntitlements('pro')
    expect(e!.precisePositioning).toBe(true)
    expect(e!.customColors).toBe(true)
    expect(e!.launcherSelection).toBe('all')
    expect(e!.messagePreview).toBe(true)
    expect(e!.quickReplies).toBe(10)
    expect(e!.legacyCustomizationUnlocked).toBe(true)
  })

  test('Max == Pro', () => { expect(getEntitlements('max')).toEqual(getEntitlements('pro')) })
  test('Self-hosted == Pro', () => { expect(getEntitlements('self-hosted')).toEqual(getEntitlements('pro')) })
})

describe('Widget entitlements — fail-closed for unknown/invalid plans (prototype-safe)', () => {
  test('null → null', () => { expect(getEntitlements(null)).toBeNull() })
  test('undefined → null', () => { expect(getEntitlements(undefined)).toBeNull() })
  test('empty string → null', () => { expect(getEntitlements('')).toBeNull() })
  test('unknown plan → null', () => {
    expect(getEntitlements('enterprise')).toBeNull()
    expect(getEntitlements('FREE')).toBeNull()
    expect(getEntitlements('free ')).toBeNull()
  })

  // BLOCKER 1 regression: prototype-pollution / inherited properties must
  // return null, NOT a non-null value.
  test('constructor → null (not an inherited Object property)', () => {
    expect(getEntitlements('constructor')).toBeNull()
  })
  test('toString → null', () => {
    expect(getEntitlements('toString')).toBeNull()
  })
  test('__proto__ → null', () => {
    expect(getEntitlements('__proto__')).toBeNull()
  })
  test('hasOwnProperty → null', () => {
    expect(getEntitlements('hasOwnProperty')).toBeNull()
  })
  test('valueOf → null', () => {
    expect(getEntitlements('valueOf')).toBeNull()
  })
  test('prototype → null', () => {
    expect(getEntitlements('prototype')).toBeNull()
  })
})

describe('Widget entitlements — frozen (immutable)', () => {
  test('Free entitlements are frozen (cannot mutate)', () => {
    const e = getEntitlements('free')!
    expect(Object.isFrozen(e)).toBe(true)
    // Attempting to mutate should NOT change the value (in strict mode it
    // throws; in sloppy mode it silently fails). Either way, the value is
    // unchanged.
    try { (e as Record<string, unknown>).presetPositioning = false } catch { /* frozen */ }
    expect(e.presetPositioning).toBe(true) // unchanged
  })
  test('Pro entitlements are frozen', () => {
    const e = getEntitlements('pro')!
    expect(Object.isFrozen(e)).toBe(true)
    try { (e as Record<string, unknown>).customColors = false } catch { /* frozen */ }
    expect(e.customColors).toBe(true)
  })
})

describe('isLegacyCustomizationUnlocked', () => {
  test('false for unknown/invalid plans', () => {
    expect(isLegacyCustomizationUnlocked(null)).toBe(false)
    expect(isLegacyCustomizationUnlocked('invalid')).toBe(false)
    expect(isLegacyCustomizationUnlocked('constructor')).toBe(false)
    expect(isLegacyCustomizationUnlocked('__proto__')).toBe(false)
  })
  test('false for Free, true for paid', () => {
    expect(isLegacyCustomizationUnlocked('free')).toBe(false)
    expect(isLegacyCustomizationUnlocked('pro')).toBe(true)
    expect(isLegacyCustomizationUnlocked('max')).toBe(true)
    expect(isLegacyCustomizationUnlocked('self-hosted')).toBe(true)
  })
})

// ─── Appearance V2 — strict parsing (rejects unknown keys) ──────────────

describe('Appearance V2 — strict parsing (canonical, no unknown keys)', () => {
  test('null → null', () => { expect(parseAppearanceV2(null)).toBeNull() })
  test('undefined → null', () => { expect(parseAppearanceV2(undefined)).toBeNull() })
  test('valid V2 (version 1, empty desktop/mobile) → canonical', () => {
    const parsed = parseAppearanceV2({ version: 1, desktop: {}, mobile: {} })
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(1)
    expect(parsed!.desktop).toEqual({})
    expect(parsed!.mobile).toEqual({})
  })
  test('valid V2 (version 1, no desktop/mobile) → defaults to empty', () => {
    const parsed = parseAppearanceV2({ version: 1 })
    expect(parsed!.desktop).toEqual({})
    expect(parsed!.mobile).toEqual({})
  })
  test('array → null', () => { expect(parseAppearanceV2([1, 2])).toBeNull() })
  test('string → null', () => { expect(parseAppearanceV2('{"version":1}')).toBeNull() })
  test('missing version → null', () => { expect(parseAppearanceV2({ desktop: {} })).toBeNull() })
  test('unknown version (2) → null', () => { expect(parseAppearanceV2({ version: 2 })).toBeNull() })
  test('version as string → null', () => { expect(parseAppearanceV2({ version: '1' })).toBeNull() })

  // BLOCKER 2 regression: unexpected top-level keys must be rejected.
  test('unexpected top-level key → null', () => {
    expect(parseAppearanceV2({ version: 1, colors: ['#fff'] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, position: 'bottom-start' })).toBeNull()
    expect(parseAppearanceV2({ version: 1, foo: 'bar' })).toBeNull()
  })
  test('unexpected key in desktop → null', () => {
    expect(parseAppearanceV2({ version: 1, desktop: { position: 'bottom-start' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, desktop: { color: '#fff' } })).toBeNull()
  })
  test('unexpected key in mobile → null', () => {
    expect(parseAppearanceV2({ version: 1, mobile: { shape: 'pill' } })).toBeNull()
  })
  test('desktop as array → null', () => {
    expect(parseAppearanceV2({ version: 1, desktop: [] })).toBeNull()
  })
  test('mobile as string → null', () => {
    expect(parseAppearanceV2({ version: 1, mobile: 'foo' })).toBeNull()
  })
  test('desktop as null → valid (absent device config)', () => {
    const parsed = parseAppearanceV2({ version: 1, desktop: null })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop).toEqual({})
  })

  // Canonical output: the returned object is NOT the raw input reference.
  test('returns a canonical object (not the raw input reference)', () => {
    const input = { version: 1, desktop: {}, mobile: {} }
    const parsed = parseAppearanceV2(input)!
    expect(parsed).not.toBe(input) // different reference
    expect(parsed.desktop).not.toBe(input.desktop) // canonical, not raw
  })
})

describe('Appearance V2 — defaults + constants', () => {
  test('APPEARANCE_V2_VERSION is 1', () => { expect(APPEARANCE_V2_VERSION).toBe(1) })
  test('DEFAULT_APPEARANCE_V2 has version 1 + empty desktop/mobile', () => {
    expect(DEFAULT_APPEARANCE_V2.version).toBe(1)
    expect(DEFAULT_APPEARANCE_V2.desktop).toEqual({})
    expect(DEFAULT_APPEARANCE_V2.mobile).toEqual({})
  })
  test('hasAppearanceV2: true for valid, false for malformed', () => {
    expect(hasAppearanceV2({ version: 1 })).toBe(true)
    expect(hasAppearanceV2(null)).toBe(false)
    expect(hasAppearanceV2({ version: 2 })).toBe(false)
    expect(hasAppearanceV2({ version: 1, unknown: true })).toBe(false)
  })
})

// ─── Stored appearance normalization (NOT effective resolution) ──────────

describe('normalizeStoredAppearance — V1 backward compat (stored normalization, NOT effective)', () => {
  const v1Stored: StoredAppearance = {
    accentColor: '#0066FF',
    launcherShape: 'rounded',
    position: 'bottom-start',
    avatarUrl: 'https://example.com/avatar.png',
    logoUrl: null,
    greetingTexts: { fa: 'سلام', en: 'Hi' },
    defaultLocale: 'fa',
  }

  test('V1 stored config (no appearanceV2) → V1 flat fields preserved, appearanceV2=null', () => {
    const result = normalizeStoredAppearance(v1Stored, getEntitlements('pro'))
    expect(result.accentColor).toBe('#0066FF')
    expect(result.launcherShape).toBe('rounded')
    expect(result.appearanceV2).toBeNull()
    expect(result.entitlements).not.toBeNull()
  })

  test('V1 stored config + Free entitlements → stored fields returned as-is (NO enforcement)', () => {
    // This is STORED normalization, NOT effective resolution. It does NOT
    // enforce Free restrictions. The production effective resolver
    // (getEffectiveWidgetConfig) handles entitlement enforcement.
    const result = normalizeStoredAppearance(v1Stored, getEntitlements('free'))
    expect(result.accentColor).toBe('#0066FF') // stored value, NOT enforced
    expect(result.entitlements?.legacyCustomizationUnlocked).toBe(false)
  })

  test('V1 stored config + null entitlements (unknown plan) → stored fields preserved', () => {
    const result = normalizeStoredAppearance(v1Stored, null)
    expect(result.accentColor).toBe('#0066FF')
    expect(result.entitlements).toBeNull()
  })

  test('Stored config with valid appearanceV2 → parsed V2 included', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: { version: 1, desktop: {}, mobile: {} } }
    const result = normalizeStoredAppearance(stored, getEntitlements('pro'))
    expect(result.appearanceV2).not.toBeNull()
    expect(result.appearanceV2!.version).toBe(1)
  })

  test('Stored config with MALFORMED appearanceV2 → appearanceV2=null (fail closed)', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: { version: 999, bad: true } }
    const result = normalizeStoredAppearance(stored, getEntitlements('pro'))
    expect(result.appearanceV2).toBeNull()
    expect(result.accentColor).toBe('#0066FF') // V1 still present
  })

  test('Stored config with appearanceV2 containing unknown keys → null (fail closed)', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: { version: 1, unknown: 'field' } }
    const result = normalizeStoredAppearance(stored, getEntitlements('pro'))
    expect(result.appearanceV2).toBeNull()
  })
})

// ─── Legacy customization boolean — preserved ────────────────────────────

describe('Legacy customization boolean — preserved (Phase 1 backward compat)', () => {
  test('Free: locked; Pro/Max/Self-hosted: unlocked', () => {
    expect(isLegacyCustomizationUnlocked('free')).toBe(false)
    expect(isLegacyCustomizationUnlocked('pro')).toBe(true)
    expect(isLegacyCustomizationUnlocked('max')).toBe(true)
    expect(isLegacyCustomizationUnlocked('self-hosted')).toBe(true)
  })
})
