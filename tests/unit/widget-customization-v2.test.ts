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
  test('number → null (malformed)', () => { expect(parseAppearanceV2(1)).toBeNull() })
  test('string → null (malformed)', () => { expect(parseAppearanceV2('{"version":1}')).toBeNull() })
  test('boolean → null', () => { expect(parseAppearanceV2(true)).toBeNull() })
  test('missing version → null', () => { expect(parseAppearanceV2({ desktop: {} })).toBeNull() })
  test('unknown version (2) → null', () => { expect(parseAppearanceV2({ version: 2 })).toBeNull() })
  test('version as string → null', () => { expect(parseAppearanceV2({ version: '1' })).toBeNull() })
  test('fractional version → null (non-integer)', () => { expect(parseAppearanceV2({ version: 1.5 })).toBeNull() })

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

  // ── Strict parser: reject non-plain objects ──────────────────────────
  test('Date object → null (non-plain)', () => {
    expect(parseAppearanceV2(new Date())).toBeNull()
  })
  test('Map → null (non-plain)', () => {
    expect(parseAppearanceV2(new Map())).toBeNull()
  })
  test('Set → null (non-plain)', () => {
    expect(parseAppearanceV2(new Set())).toBeNull()
  })
  test('class instance → null (non-plain)', () => {
    class FakeConfig { version = 1; desktop = {}; mobile = {} }
    expect(parseAppearanceV2(new FakeConfig())).toBeNull()
  })
  test('Date as desktop value → null (non-plain device)', () => {
    expect(parseAppearanceV2({ version: 1, desktop: new Date() })).toBeNull()
  })

  // ── Strict parser: reject inherited version ──────────────────────────
  test('inherited version via prototype → null (must be own property)', () => {
    const proto = { version: 1 }
    const child = Object.create(proto)
    child.desktop = {}
    // child.version is inherited (not own) → must reject
    expect(parseAppearanceV2(child)).toBeNull()
  })

  // ── Strict parser: Object.create(null) is a valid plain object ───────
  test('Object.create(null) with own version → valid (null prototype is OK)', () => {
    const obj = Object.create(null)
    obj.version = 1
    obj.desktop = {}
    obj.mobile = {}
    const parsed = parseAppearanceV2(obj)
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(1)
  })

  // ── Strict parser: getter that throws does NOT escape ────────────────
  test('getter that throws on version → null (accessor rejected, does not escape)', () => {
    const obj = {}
    Object.defineProperty(obj, 'version', {
      get() { throw new Error('boom') },
      enumerable: true,
    })
    // The parser must reject accessor properties + never throw.
    expect(() => parseAppearanceV2(obj)).not.toThrow()
    expect(parseAppearanceV2(obj)).toBeNull()
  })
  test('getter that returns a valid value on version → null (accessor rejected)', () => {
    const obj = {}
    Object.defineProperty(obj, 'version', {
      get() { return 1 },
      enumerable: true,
    })
    // Even though the getter returns a valid value, accessor properties
    // must be rejected — only data properties are accepted.
    expect(parseAppearanceV2(obj)).toBeNull()
  })
  test('getter on desktop → null (accessor rejected)', () => {
    const obj = { version: 1 }
    Object.defineProperty(obj, 'desktop', {
      get() { throw new Error('boom') },
      enumerable: true,
    })
    expect(() => parseAppearanceV2(obj)).not.toThrow()
    expect(parseAppearanceV2(obj)).toBeNull()
  })

  // ── Strict parser: reject non-enumerable own properties ─────────────
  test('non-enumerable own property at top-level → null', () => {
    const obj = { version: 1 }
    Object.defineProperty(obj, 'hidden', {
      value: 'secret',
      enumerable: false,
    })
    // Reflect.ownKeys catches non-enumerable properties → 'hidden' is
    // unexpected → reject.
    expect(parseAppearanceV2(obj)).toBeNull()
  })
  test('non-enumerable own property in desktop → null', () => {
    const obj = { version: 1, desktop: {} }
    Object.defineProperty(obj.desktop, 'hidden', {
      value: 'secret',
      enumerable: false,
    })
    expect(parseAppearanceV2(obj)).toBeNull()
  })

  // ── Strict parser: reject Symbol own properties ─────────────────────
  test('Symbol own property at top-level → null', () => {
    const obj = { version: 1 }
    const sym = Symbol('test')
    ;(obj as Record<string | symbol, unknown>)[sym] = 'value'
    // Reflect.ownKeys catches Symbol keys → unexpected → reject.
    expect(parseAppearanceV2(obj)).toBeNull()
  })
  test('Symbol own property in desktop → null', () => {
    const desktop = {}
    const sym = Symbol('test')
    ;(desktop as Record<string | symbol, unknown>)[sym] = 'value'
    const obj = { version: 1, desktop }
    expect(parseAppearanceV2(obj)).toBeNull()
  })

  // ── Strict parser: accessor for desktop/mobile → null ───────────────
  test('accessor property for desktop (getter returns valid object) → null', () => {
    const obj = { version: 1 }
    Object.defineProperty(obj, 'desktop', {
      get() { return {} },
      enumerable: true,
    })
    // Even though the getter returns a valid empty object, accessor
    // properties must be rejected — only data properties accepted.
    expect(parseAppearanceV2(obj)).toBeNull()
  })
  test('accessor property for mobile → null', () => {
    const obj = { version: 1 }
    Object.defineProperty(obj, 'mobile', {
      get() { return {} },
      enumerable: true,
    })
    expect(parseAppearanceV2(obj)).toBeNull()
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

  // ── Restored lost regression coverage ────────────────────────────────

  test('Stored config with appearanceV2 as a string → null (fail closed)', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: 'not-json-object' }
    const result = normalizeStoredAppearance(stored, getEntitlements('pro'))
    expect(result.appearanceV2).toBeNull()
    expect(result.accentColor).toBe('#0066FF') // V1 still present
  })

  test('Full V1 flat-field preservation (all fields checked individually)', () => {
    const fullStored: StoredAppearance = {
      accentColor: '#FF0000',
      launcherShape: 'pill',
      position: 'bottom-start',
      avatarUrl: 'https://example.com/a.png',
      logoUrl: 'https://example.com/l.png',
      greetingTexts: { fa: 'سلام', en: 'Hello' },
      defaultLocale: 'en',
    }
    const result = normalizeStoredAppearance(fullStored, getEntitlements('pro'))
    expect(result.accentColor).toBe('#FF0000')
    expect(result.launcherShape).toBe('pill')
    expect(result.position).toBe('bottom-start')
    expect(result.avatarUrl).toBe('https://example.com/a.png')
    expect(result.logoUrl).toBe('https://example.com/l.png')
    expect(result.greetingTexts).toEqual({ fa: 'سلام', en: 'Hello' })
    expect(result.defaultLocale).toBe('en')
    expect(result.appearanceV2).toBeNull()
  })
})

// ─── Entitlement distinctions (restored detailed comparisons) ───────────

describe('Entitlement distinctions — Free vs Pro detailed comparison', () => {
  test('Free vs Pro have distinct capabilities across all key fields', () => {
    const free = getEntitlements('free')!
    const pro = getEntitlements('pro')!
    // Every capability that differs between Free and Pro:
    expect(free.precisePositioning).not.toBe(pro.precisePositioning)
    expect(free.customColors).not.toBe(pro.customColors)
    expect(free.launcherSelection).not.toBe(pro.launcherSelection)
    expect(free.messagePreview).not.toBe(pro.messagePreview)
    expect(free.attentionAnimations).not.toBe(pro.attentionAnimations)
    expect(free.quickReplies).not.toBe(pro.quickReplies)
    expect(free.preChatForm).not.toBe(pro.preChatForm)
    expect(free.pageVisibility).not.toBe(pro.pageVisibility)
    expect(free.alternativeContactButtons).not.toBe(pro.alternativeContactButtons)
    expect(free.smartAvoidance).not.toBe(pro.smartAvoidance)
    expect(free.contextChat).not.toBe(pro.contextChat)
    expect(free.brandingRemoval).not.toBe(pro.brandingRemoval)
    expect(free.legacyCustomizationUnlocked).not.toBe(pro.legacyCustomizationUnlocked)
  })

  test('The entitlement model is additive — does NOT change the PATCH gate behavior', () => {
    // The existing PATCH gate uses !plan.customization. The entitlement
    // model's isLegacyCustomizationUnlocked mirrors this for backward compat.
    // Phase 1 does NOT wire the entitlement model into the PATCH gate —
    // the gate stays on the legacy boolean until later phases implement
    // per-capability checks.
    const free = getEntitlements('free')!
    const pro = getEntitlements('pro')!
    expect(free.legacyCustomizationUnlocked).toBe(false) // mirrors customization:false
    expect(pro.legacyCustomizationUnlocked).toBe(true) // mirrors customization:true
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
