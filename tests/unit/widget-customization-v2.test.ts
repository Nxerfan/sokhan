/// <reference types="bun-types" />
/**
 * Widget customization V2 foundation — unit tests.
 *
 * Tests the pure TS foundation modules (no DB):
 *   - src/lib/payments/widget-entitlements.ts (entitlement model)
 *   - src/lib/widget/appearance-v2.ts (versioned appearance model)
 *   - src/lib/widget/appearance-resolver.ts (shared resolver)
 *
 * Covers (Phase 1 acceptance criteria):
 *   1. Free vs Pro/Max/Self-hosted entitlement differences.
 *   2. Invalid/unknown plans failing closed.
 *   3. Existing configuration compatibility (V1 flat fields preserved).
 *   4. Malformed appearance input, unknown versions, bounds validation.
 *   5. Correct effective vs stored configuration behavior (resolver).
 *   6. No regression of the legacy customization boolean.
 */

import { test, expect, describe } from 'bun:test'
import {
  getEntitlements,
  isLegacyCustomizationUnlocked,
  type WidgetEntitlements,
} from '../../src/lib/payments/widget-entitlements'
import {
  parseAppearanceV2,
  DEFAULT_APPEARANCE_V2,
  APPEARANCE_V2_VERSION,
  hasAppearanceV2,
  type AppearanceV2,
} from '../../src/lib/widget/appearance-v2'
import { resolveAppearance, type StoredAppearance } from '../../src/lib/widget/appearance-resolver'

// ─── Entitlement model ───────────────────────────────────────────────────

describe('Widget entitlements — Free vs Pro/Max/Self-hosted', () => {
  test('Free has limited entitlements', () => {
    const e = getEntitlements('free')
    expect(e).not.toBeNull()
    expect(e!.presetPositioning).toBe(true)
    expect(e!.precisePositioning).toBe(false)
    expect(e!.presetColors).toBe(true)
    expect(e!.customColors).toBe(false)
    expect(e!.launcherSelection).toBe('limited')
    expect(e!.messagePreview).toBe(false)
    expect(e!.attentionAnimations).toBe('basic')
    expect(e!.quickReplies).toBe(2)
    expect(e!.preChatForm).toBe('basic')
    expect(e!.pageVisibility).toBe('basic')
    expect(e!.alternativeContactButtons).toBe(2)
    expect(e!.smartAvoidance).toBe(false)
    expect(e!.contextChat).toBe(false)
    expect(e!.playground).toBe(true)
    expect(e!.brandingRemoval).toBe(false)
    // Phase 1 backward-compat: Free is still fully locked.
    expect(e!.legacyCustomizationUnlocked).toBe(false)
  })

  test('Pro has full entitlements', () => {
    const e = getEntitlements('pro')
    expect(e).not.toBeNull()
    expect(e!.precisePositioning).toBe(true)
    expect(e!.customColors).toBe(true)
    expect(e!.launcherSelection).toBe('all')
    expect(e!.messagePreview).toBe(true)
    expect(e!.attentionAnimations).toBe('advanced')
    expect(e!.quickReplies).toBe(10)
    expect(e!.preChatForm).toBe('advanced')
    expect(e!.pageVisibility).toBe('advanced')
    expect(e!.alternativeContactButtons).toBe(5)
    expect(e!.smartAvoidance).toBe(true)
    expect(e!.contextChat).toBe(true)
    expect(e!.brandingRemoval).toBe(true)
    expect(e!.legacyCustomizationUnlocked).toBe(true)
  })

  test('Max has same full entitlements as Pro', () => {
    const max = getEntitlements('max')
    const pro = getEntitlements('pro')
    expect(max).toEqual(pro)
  })

  test('Self-hosted has same full entitlements as Pro', () => {
    const sh = getEntitlements('self-hosted')
    const pro = getEntitlements('pro')
    expect(sh).toEqual(pro)
  })

  test('Free vs Pro have distinct capabilities', () => {
    const free = getEntitlements('free')!
    const pro = getEntitlements('pro')!
    expect(free.precisePositioning).not.toBe(pro.precisePositioning)
    expect(free.customColors).not.toBe(pro.customColors)
    expect(free.launcherSelection).not.toBe(pro.launcherSelection)
    expect(free.messagePreview).not.toBe(pro.messagePreview)
    expect(free.quickReplies).not.toBe(pro.quickReplies)
  })
})

describe('Widget entitlements — fail closed for unknown/invalid plans', () => {
  test('null plan slug → null', () => {
    expect(getEntitlements(null)).toBeNull()
  })
  test('undefined plan slug → null', () => {
    expect(getEntitlements(undefined)).toBeNull()
  })
  test('empty string → null', () => {
    expect(getEntitlements('')).toBeNull()
  })
  test('unknown plan slug → null', () => {
    expect(getEntitlements('enterprise')).toBeNull()
    expect(getEntitlements('FREE')).toBeNull() // case-sensitive
    expect(getEntitlements('free ')).toBeNull() // whitespace
    expect(getEntitlements('invalid-plan')).toBeNull()
  })

  test('isLegacyCustomizationUnlocked: false for unknown/invalid plans', () => {
    expect(isLegacyCustomizationUnlocked(null)).toBe(false)
    expect(isLegacyCustomizationUnlocked('invalid')).toBe(false)
    expect(isLegacyCustomizationUnlocked('')).toBe(false)
  })

  test('isLegacyCustomizationUnlocked: false for Free, true for paid', () => {
    expect(isLegacyCustomizationUnlocked('free')).toBe(false)
    expect(isLegacyCustomizationUnlocked('pro')).toBe(true)
    expect(isLegacyCustomizationUnlocked('max')).toBe(true)
    expect(isLegacyCustomizationUnlocked('self-hosted')).toBe(true)
  })
})

// ─── Appearance V2 model ─────────────────────────────────────────────────

describe('Appearance V2 — strict parsing', () => {
  test('null → null (no V2 config; fall back to V1)', () => {
    expect(parseAppearanceV2(null)).toBeNull()
  })
  test('undefined → null', () => {
    expect(parseAppearanceV2(undefined)).toBeNull()
  })
  test('valid V2 config (version 1, empty desktop/mobile) → parsed', () => {
    const parsed = parseAppearanceV2({ version: 1, desktop: {}, mobile: {} })
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(1)
    expect(parsed!.desktop).toEqual({})
    expect(parsed!.mobile).toEqual({})
  })
  test('valid V2 config without desktop/mobile → defaults to empty objects', () => {
    const parsed = parseAppearanceV2({ version: 1 })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop).toEqual({})
    expect(parsed!.mobile).toEqual({})
  })
  test('array → null (malformed)', () => {
    expect(parseAppearanceV2([1, 2])).toBeNull()
  })
  test('string → null (malformed)', () => {
    expect(parseAppearanceV2('{"version":1}')).toBeNull()
  })
  test('number → null (malformed)', () => {
    expect(parseAppearanceV2(1)).toBeNull()
  })
  test('missing version → null', () => {
    expect(parseAppearanceV2({ desktop: {} })).toBeNull()
  })
  test('non-integer version → null', () => {
    expect(parseAppearanceV2({ version: 1.5 })).toBeNull()
  })
  test('unknown version (2) → null', () => {
    expect(parseAppearanceV2({ version: 2 })).toBeNull()
  })
  test('version as string → null', () => {
    expect(parseAppearanceV2({ version: '1' })).toBeNull()
  })
  test('desktop as array → null (malformed)', () => {
    expect(parseAppearanceV2({ version: 1, desktop: [] })).toBeNull()
  })
  test('mobile as string → null (malformed)', () => {
    expect(parseAppearanceV2({ version: 1, mobile: 'foo' })).toBeNull()
  })
  test('desktop as null → valid (absent device config)', () => {
    const parsed = parseAppearanceV2({ version: 1, desktop: null })
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop).toEqual({})
  })
})

describe('Appearance V2 — defaults + constants', () => {
  test('APPEARANCE_V2_VERSION is 1', () => {
    expect(APPEARANCE_V2_VERSION).toBe(1)
  })
  test('DEFAULT_APPEARANCE_V2 has version 1 + empty desktop/mobile', () => {
    expect(DEFAULT_APPEARANCE_V2.version).toBe(1)
    expect(DEFAULT_APPEARANCE_V2.desktop).toEqual({})
    expect(DEFAULT_APPEARANCE_V2.mobile).toEqual({})
  })
  test('hasAppearanceV2: true for valid, false for malformed', () => {
    expect(hasAppearanceV2({ version: 1 })).toBe(true)
    expect(hasAppearanceV2(null)).toBe(false)
    expect(hasAppearanceV2({ version: 2 })).toBe(false)
    expect(hasAppearanceV2('bad')).toBe(false)
  })
})

// ─── Appearance resolver ─────────────────────────────────────────────────

describe('Appearance resolver — V1 backward compat (Phase 1: no behavior change)', () => {
  const v1Stored: StoredAppearance = {
    accentColor: '#0066FF',
    launcherShape: 'rounded',
    position: 'bottom-start',
    avatarUrl: 'https://example.com/avatar.png',
    logoUrl: null,
    greetingTexts: { fa: 'سلام', en: 'Hi' },
    defaultLocale: 'fa',
    // appearanceV2 absent — V1 behavior.
  }

  test('V1 stored config (no appearanceV2) → V1 flat fields preserved, appearanceV2=null', () => {
    const proEnt = getEntitlements('pro')
    const resolved = resolveAppearance(v1Stored, proEnt)
    expect(resolved.accentColor).toBe('#0066FF')
    expect(resolved.launcherShape).toBe('rounded')
    expect(resolved.position).toBe('bottom-start')
    expect(resolved.avatarUrl).toBe('https://example.com/avatar.png')
    expect(resolved.logoUrl).toBeNull()
    expect(resolved.greetingTexts).toEqual({ fa: 'سلام', en: 'Hi' })
    expect(resolved.defaultLocale).toBe('fa')
    expect(resolved.appearanceV2).toBeNull() // no V2 config → null
    expect(resolved.entitlements).toBe(proEnt)
  })

  test('V1 stored config + Free entitlements → V1 flat fields still preserved (no enforcement yet)', () => {
    const freeEnt = getEntitlements('free')
    const resolved = resolveAppearance(v1Stored, freeEnt)
    // Phase 1: no per-capability enforcement — flat fields are returned as-is.
    expect(resolved.accentColor).toBe('#0066FF')
    expect(resolved.entitlements).toBe(freeEnt)
  })

  test('V1 stored config + null entitlements (unknown plan) → V1 flat fields preserved, entitlements=null', () => {
    const resolved = resolveAppearance(v1Stored, null)
    expect(resolved.accentColor).toBe('#0066FF')
    expect(resolved.entitlements).toBeNull()
  })

  test('Stored config with valid appearanceV2 → parsed V2 included alongside V1 flat fields', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: { version: 1, desktop: {}, mobile: {} } }
    const resolved = resolveAppearance(stored, getEntitlements('pro'))
    expect(resolved.accentColor).toBe('#0066FF') // V1 still present
    expect(resolved.appearanceV2).not.toBeNull()
    expect(resolved.appearanceV2!.version).toBe(1)
  })

  test('Stored config with MALFORMED appearanceV2 → appearanceV2=null (fail closed), V1 preserved', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: { version: 999, bad: true } }
    const resolved = resolveAppearance(stored, getEntitlements('pro'))
    expect(resolved.appearanceV2).toBeNull() // malformed → null
    expect(resolved.accentColor).toBe('#0066FF') // V1 still present
  })

  test('Stored config with appearanceV2 as a string → appearanceV2=null (fail closed)', () => {
    const stored: StoredAppearance = { ...v1Stored, appearanceV2: 'not-json-object' }
    const resolved = resolveAppearance(stored, getEntitlements('pro'))
    expect(resolved.appearanceV2).toBeNull()
  })
})

// ─── No regression of legacy customization boolean ───────────────────────

describe('Legacy customization boolean — preserved (Phase 1 backward compat)', () => {
  test('Free: legacyCustomizationUnlocked=false (still locked)', () => {
    expect(isLegacyCustomizationUnlocked('free')).toBe(false)
  })
  test('Pro/Max/Self-hosted: legacyCustomizationUnlocked=true (still unlocked)', () => {
    expect(isLegacyCustomizationUnlocked('pro')).toBe(true)
    expect(isLegacyCustomizationUnlocked('max')).toBe(true)
    expect(isLegacyCustomizationUnlocked('self-hosted')).toBe(true)
  })
  test('The entitlement model is additive — does NOT change the PATCH gate behavior', () => {
    // The existing PATCH gate uses !plan.customization. The entitlement model's
    // isLegacyCustomizationUnlocked mirrors this for backward compat. Phase 1
    // does NOT wire the entitlement model into the PATCH gate — the gate stays
    // on the legacy boolean until later phases implement per-capability checks.
    const free = getEntitlements('free')!
    const pro = getEntitlements('pro')!
    expect(free.legacyCustomizationUnlocked).toBe(false) // mirrors customization:false
    expect(pro.legacyCustomizationUnlocked).toBe(true) // mirrors customization:true
  })
})
