/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 8 — Page Visibility.
 *
 * Covers: plan gating, rule precedence, exact vs prefix matching, pathname
 * boundaries, navigation, mobile/desktop, downgrade/upgrade, malformed input,
 * cross-feature preservation.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validatePageVisibilityPatch, mergePageVisibilityPatch,
} from '../../src/lib/widget/page-visibility-patch'
import { resolveEffectivePageVisibility } from '../../src/lib/widget/effective-page-visibility'
import {
  evaluatePageVisibility,
  isValidPagePattern,
  isMatchTypeAllowed,
  getMaxPageVisibilityRules,
  isAdvancedPageVisibilityPlan,
  BASIC_PAGE_VISIBILITY_MAX_RULES,
  ADVANCED_PAGE_VISIBILITY_MAX_RULES,
  PAGE_RULE_MAX_PATTERN_LENGTH,
  type PageVisibilityRule,
} from '../../src/lib/widget/page-visibility-types'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unknown__')

const rule = (pattern: string, action: 'show' | 'hide', match: 'exact' | 'prefix' = 'exact', device?: 'desktop' | 'mobile'): PageVisibilityRule =>
  ({ pattern, match, action, ...(device ? { device } : {}) })

const full = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 5, offsetY: -5 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -3, offsetY: 3 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const },
  attention: { animation: 'pulse' as const },
  messagePreview: { enabled: true },
  quickReplies: { items: ['Hello'] },
  preChatForm: { fields: [{ key: 'name' as const, required: true }] },
  pageVisibility: { rules: [rule('/contact', 'hide'), rule('/about', 'show', 'prefix')] },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Developer — evaluatePageVisibility', () => {
  test('no rules → show (default)', () => {
    expect(evaluatePageVisibility([], '/any', 'desktop')).toBe('show')
  })

  test('exact match: hide rule hides', () => {
    expect(evaluatePageVisibility([rule('/contact', 'hide')], '/contact', 'desktop')).toBe('hide')
  })

  test('exact match: no match → show', () => {
    expect(evaluatePageVisibility([rule('/contact', 'hide')], '/about', 'desktop')).toBe('show')
  })

  test('prefix match: sub-path matches', () => {
    expect(evaluatePageVisibility([rule('/products', 'hide', 'prefix')], '/products/electronics', 'desktop')).toBe('hide')
  })

  test('prefix match: exact path matches', () => {
    expect(evaluatePageVisibility([rule('/products', 'hide', 'prefix')], '/products', 'desktop')).toBe('hide')
  })

  test('prefix match: trailing slash matches', () => {
    expect(evaluatePageVisibility([rule('/products', 'hide', 'prefix')], '/products/', 'desktop')).toBe('hide')
  })

  test('prefix match: partial segment does NOT match', () => {
    expect(evaluatePageVisibility([rule('/products', 'hide', 'prefix')], '/products-detail', 'desktop')).toBe('show')
  })

  test('hide overrides show when both match', () => {
    const rules = [rule('/page', 'show'), rule('/page', 'hide')]
    expect(evaluatePageVisibility(rules, '/page', 'desktop')).toBe('hide')
  })

  test('show does not override hide', () => {
    const rules = [rule('/page', 'hide'), rule('/page', 'show')]
    expect(evaluatePageVisibility(rules, '/page', 'desktop')).toBe('hide')
  })

  test('device-specific: desktop rule does not affect mobile', () => {
    const rules = [rule('/page', 'hide', 'exact', 'desktop')]
    expect(evaluatePageVisibility(rules, '/page', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/page', 'mobile')).toBe('show')
  })

  test('device-specific: mobile rule does not affect desktop', () => {
    const rules = [rule('/page', 'hide', 'exact', 'mobile')]
    expect(evaluatePageVisibility(rules, '/page', 'mobile')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/page', 'desktop')).toBe('show')
  })

  test('no device = applies to all devices', () => {
    const rules = [rule('/page', 'hide')]
    expect(evaluatePageVisibility(rules, '/page', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/page', 'mobile')).toBe('hide')
  })

  test('multiple rules: first matching hide wins', () => {
    const rules = [rule('/a', 'show'), rule('/b', 'show'), rule('/c', 'hide')]
    expect(evaluatePageVisibility(rules, '/c', 'desktop')).toBe('hide')
  })

  test('multiple rules: show when only show matches', () => {
    const rules = [rule('/a', 'show'), rule('/b', 'hide')]
    expect(evaluatePageVisibility(rules, '/a', 'desktop')).toBe('show')
  })
})

describe('Developer — pattern validation', () => {
  test('valid patterns accepted', () => {
    expect(isValidPagePattern('/')).toBe(true)
    expect(isValidPagePattern('/about')).toBe(true)
    expect(isValidPagePattern('/products/electronics')).toBe(true)
  })

  test('rejects patterns not starting with /', () => {
    expect(isValidPagePattern('about')).toBe(false)
    expect(isValidPagePattern('')).toBe(false)
  })

  test('rejects wildcards', () => {
    expect(isValidPagePattern('/*')).toBe(false)
    expect(isValidPagePattern('/page*')).toBe(false)
    expect(isValidPagePattern('/page?')).toBe(false)
  })

  test('rejects regex-like characters', () => {
    expect(isValidPagePattern('/page(x)')).toBe(false)
    expect(isValidPagePattern('/page\\d')).toBe(false)
  })

  test('rejects control characters', () => {
    expect(isValidPagePattern('/page\n')).toBe(false)
    expect(isValidPagePattern('/page\t')).toBe(false)
  })

  test('rejects non-string types', () => {
    expect(isValidPagePattern(42)).toBe(false)
    expect(isValidPagePattern(null)).toBe(false)
    expect(isValidPagePattern({})).toBe(false)
  })
})

describe('Developer — plan entitlements', () => {
  test('Free basic, paid advanced, unknown null', () => {
    expect(FREE?.pageVisibility).toBe('basic')
    for (const e of [PRO, MAX, SELF]) expect(e?.pageVisibility).toBe('advanced')
    expect(UNKNOWN).toBeNull()
  })

  test('isAdvancedPageVisibilityPlan', () => {
    expect(isAdvancedPageVisibilityPlan('advanced')).toBe(true)
    expect(isAdvancedPageVisibilityPlan('basic')).toBe(false)
    expect(isAdvancedPageVisibilityPlan('none')).toBe(false)
  })

  test('getMaxPageVisibilityRules', () => {
    expect(getMaxPageVisibilityRules('basic')).toBe(3)
    expect(getMaxPageVisibilityRules('advanced')).toBe(10)
  })

  test('isMatchTypeAllowed', () => {
    expect(isMatchTypeAllowed('exact', 'basic')).toBe(true)
    expect(isMatchTypeAllowed('prefix', 'basic')).toBe(false)
    expect(isMatchTypeAllowed('exact', 'advanced')).toBe(true)
    expect(isMatchTypeAllowed('prefix', 'advanced')).toBe(true)
  })

  test('constants', () => {
    expect(BASIC_PAGE_VISIBILITY_MAX_RULES).toBe(3)
    expect(ADVANCED_PAGE_VISIBILITY_MAX_RULES).toBe(10)
    expect(PAGE_RULE_MAX_PATTERN_LENGTH).toBe(500)
  })
})

describe('Developer — validation edge cases', () => {
  test('Free accepts exact rules up to 3', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/a', 'hide'), rule('/b', 'show'), rule('/c', 'hide')] } }, FREE).ok).toBe(true)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/a', 'hide'), rule('/b', 'show'), rule('/c', 'hide'), rule('/d', 'show')] } }, FREE))
      .toEqual({ ok: false, code: 'page_visibility_limit_exceeded' })
  })

  test('Free rejects prefix match', () => {
    const r = validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/products', 'hide', 'prefix')] } }, FREE)
    expect(r).toEqual({ ok: false, code: 'page_visibility_not_allowed' })
  })

  test('Free rejects device-specific rules', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/page', 'hide', 'exact', 'desktop')] } }, FREE).ok).toBe(false)
  })

  test('Pro accepts prefix + device', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/products', 'hide', 'prefix', 'desktop')] } }, PRO).ok).toBe(true)
  })

  test('Pro rejects 11+ rules', () => {
    const rules = Array.from({ length: 11 }, (_, i) => rule(`/r${i}`, 'hide'))
    expect(validatePageVisibilityPatch({ pageVisibility: { rules } }, PRO))
      .toEqual({ ok: false, code: 'page_visibility_limit_exceeded' })
  })

  test('Unknown plan rejected', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [] } }, UNKNOWN).ok).toBe(false)
  })

  test('null entitlements rejected', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [] } }, null).ok).toBe(false)
  })

  test('rejects client-supplied paidRules', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [], paidRules: [rule('/x', 'hide')] } }, PRO).ok).toBe(false)
  })

  test('rejects duplicate rules', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/a', 'hide'), rule('/a', 'hide')] } }, PRO).ok).toBe(false)
  })

  test('rejects malformed patterns', () => {
    for (const pattern of ['', 'no-slash', '/*', '/page?', '/(x)']) {
      expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule(pattern, 'hide')] } }, PRO).ok).toBe(false)
    }
  })

  test('empty rules disables feature', () => {
    for (const e of [FREE, PRO]) {
      expect(validatePageVisibilityPatch({ pageVisibility: { rules: [] } }, e))
        .toEqual({ ok: true, data: { rules: [] } })
    }
  })
})

describe('Developer — resolver + downgrade/upgrade', () => {
  test('Free filters to exact-only rules + truncates to 3', () => {
    const stored = { appearanceV2: { version: 1, pageVisibility: { rules: [
      rule('/a', 'hide'), rule('/b', 'show', 'prefix'), rule('/c', 'hide'), rule('/d', 'show'),
    ] } } }
    const result = resolveEffectivePageVisibility(stored, FREE)
    // /b is filtered (prefix not allowed for Free), leaving /a, /c, /d = 3 (max for Free)
    expect(result.rules.length).toBe(3)
    // No prefix rules in the result
    expect(result.rules.every(r => r.match === 'exact')).toBe(true)
  })

  test('Pro uses all stored rules', () => {
    expect(resolveEffectivePageVisibility(input(full), PRO).rules).toEqual(full.pageVisibility.rules)
  })

  test('Unknown → empty', () => {
    expect(resolveEffectivePageVisibility(input(full), UNKNOWN)).toEqual({ rules: [] })
  })

  test('No V2 → empty', () => {
    expect(resolveEffectivePageVisibility(input(null), PRO)).toEqual({ rules: [] })
  })

  test('Pro downgrade preserves paidRules', () => {
    const down = mergePageVisibilityPatch(full, { rules: [rule('/page', 'hide')] }, FREE)
    expect(down.pageVisibility?.paidRules).toEqual(full.pageVisibility.rules)
    expect(resolveEffectivePageVisibility(input(down), FREE).rules).toEqual([rule('/page', 'hide')])
    expect(resolveEffectivePageVisibility(input(down), PRO).rules).toEqual(full.pageVisibility.rules)
  })

  test('Pro explicit save clears paidRules', () => {
    const down = mergePageVisibilityPatch(full, { rules: [rule('/x', 'hide')] }, FREE)
    const up = mergePageVisibilityPatch(down, { rules: [rule('/x', 'hide')] }, PRO)
    expect(up.pageVisibility).toEqual({ rules: [rule('/x', 'hide')] })
  })
})

describe('Developer — cross-feature preservation', () => {
  test('page visibility edit preserves all V2 neighbors', () => {
    const r = mergePageVisibilityPatch(full, { rules: [] }, PRO)
    expect(r.colors).toEqual(full.colors)
    expect(r.launcher).toEqual(full.launcher)
    expect(r.attention).toEqual(full.attention)
    expect(r.messagePreview).toEqual(full.messagePreview)
    expect(r.quickReplies).toEqual(full.quickReplies)
    expect(r.preChatForm).toEqual(full.preChatForm)
    expect(r.desktop).toEqual(full.desktop)
    expect(r.mobile).toEqual(full.mobile)
    expect(parseAppearanceV2(r)).not.toBeNull()
  })

  test('all 7 sibling merges preserve page visibility', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'sunset' } }).pageVisibility).toEqual(full.pageVisibility)
    expect(mergeLauncherPatch(full, { shape: 'pill' }, PRO).pageVisibility).toEqual(full.pageVisibility)
    expect(mergeAttentionPatch(full, { animation: 'glow' }, PRO).pageVisibility).toEqual(full.pageVisibility)
    expect(mergeMessagePreviewPatch(full, { enabled: false }).pageVisibility).toEqual(full.pageVisibility)
    expect(mergeQuickRepliesPatch(full, { items: ['Support'] }, PRO).pageVisibility).toEqual(full.pageVisibility)
    expect(mergePositioningPatch(full, { hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' } }, 'bottom-center').pageVisibility).toEqual(full.pageVisibility)
    expect(mergePreChatFormPatch(full, { fields: [] }, PRO).pageVisibility).toEqual(full.pageVisibility)
  })
})

describe('Developer — strict parseAppearanceV2 pageVisibility', () => {
  test('valid pageVisibility coexists with all V2 fields', () => {
    expect(parseAppearanceV2(full)?.pageVisibility).toEqual(full.pageVisibility)
  })

  test('rejects null, arrays, primitives', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: null })).toBeNull()
    expect(parseAppearanceV2({ version: 1, pageVisibility: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, pageVisibility: 'hello' })).toBeNull()
  })

  test('rejects invalid pattern', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [rule('no-slash', 'hide')] } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [rule('/*', 'hide')] } })).toBeNull()
  })

  test('rejects invalid match/action', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [{ pattern: '/x', match: 'regex', action: 'hide' }] } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [{ pattern: '/x', match: 'exact', action: 'toggle' }] } })).toBeNull()
  })

  test('rejects duplicate rules', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [rule('/a', 'hide'), rule('/a', 'hide')] } })).toBeNull()
  })

  test('rejects unexpected keys', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [], css: 'x' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [{ pattern: '/x', match: 'exact', action: 'hide', label: 'X' }] } })).toBeNull()
  })

  test('rejects empty paidRules', () => {
    expect(parseAppearanceV2({ version: 1, pageVisibility: { rules: [rule('/x', 'hide')], paidRules: [] } })).toBeNull()
  })

  test('absent pageVisibility is valid', () => {
    expect(parseAppearanceV2({ version: 1 })?.pageVisibility).toBeUndefined()
  })

  test('empty rules is valid', () => {
    const v = parseAppearanceV2({ version: 1, pageVisibility: { rules: [] } })
    expect(v?.pageVisibility).toEqual({ rules: [] })
  })

  test('device-specific rules accepted', () => {
    const v = parseAppearanceV2({ version: 1, pageVisibility: { rules: [rule('/x', 'hide', 'exact', 'desktop')] } })
    expect(v?.pageVisibility?.rules[0].device).toBe('desktop')
  })
})

describe('Developer — Free entitlement leakage regression', () => {
  // These tests verify the fix for the blocker where Free's resolveEffectivePageVisibility
  // filtered by match === 'exact' but did NOT exclude device-specific rules.
  // Free must never receive device-scoped or prefix rules in its effective config.

  test('Pro device-specific exact rules → Free downgrade → rules empty (no leakage)', () => {
    const paidOnly = [
      rule('/checkout', 'hide', 'exact', 'mobile'),
      rule('/account', 'hide', 'exact', 'desktop'),
    ]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules: paidOnly } } }, FREE)
    expect(result.rules).toEqual([])
  })

  test('Mixed general exact + device exact + prefix → Free retains only general exact', () => {
    const mixed = [
      rule('/help', 'hide'),                              // general exact → Free eligible
      rule('/checkout', 'hide', 'exact', 'mobile'),       // device exact → paid-only
      rule('/products', 'hide', 'prefix'),                 // prefix → paid-only
    ]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules: mixed } } }, FREE)
    expect(result.rules).toEqual([rule('/help', 'hide')])
  })

  test('Free edit preserves paid configuration with device + prefix rules', () => {
    const paidConfig = {
      rules: [rule('/help', 'hide'), rule('/checkout', 'hide', 'exact', 'mobile'), rule('/products', 'hide', 'prefix')],
    }
    const full = { version: 1 as const, desktop: {}, mobile: {}, pageVisibility: paidConfig }
    const down = mergePageVisibilityPatch(full, { rules: [rule('/about', 'show')] }, FREE)
    // Free edit: stored rules = the Free edit, paidRules = the prior Pro config.
    expect(down.pageVisibility?.rules).toEqual([rule('/about', 'show')])
    expect(down.pageVisibility?.paidRules).toEqual(paidConfig.rules)
    // Free effective: only general exact rules from the Free edit.
    expect(resolveEffectivePageVisibility({ appearanceV2: down }, FREE).rules).toEqual([rule('/about', 'show')])
  })

  test('Upgrade restores paid configuration with device + prefix rules', () => {
    const paidConfig = {
      rules: [rule('/help', 'hide'), rule('/checkout', 'hide', 'exact', 'mobile'), rule('/products', 'hide', 'prefix')],
    }
    const full = { version: 1 as const, desktop: {}, mobile: {}, pageVisibility: paidConfig }
    const down = mergePageVisibilityPatch(full, { rules: [rule('/about', 'show')] }, FREE)
    // Upgrade to Pro → restores paidRules.
    expect(resolveEffectivePageVisibility({ appearanceV2: down }, PRO).rules).toEqual(paidConfig.rules)
  })

  test('Explicit paid save clears stale paidRules', () => {
    const paidConfig = {
      rules: [rule('/help', 'hide'), rule('/checkout', 'hide', 'exact', 'mobile')],
    }
    const full = { version: 1 as const, desktop: {}, mobile: {}, pageVisibility: paidConfig }
    const down = mergePageVisibilityPatch(full, { rules: [rule('/about', 'show')] }, FREE)
    const up = mergePageVisibilityPatch(down, { rules: [rule('/about', 'show')] }, PRO)
    expect(up.pageVisibility).toEqual({ rules: [rule('/about', 'show')] })
    expect(up.pageVisibility?.paidRules).toBeUndefined()
  })

  test('Public config never leaks paidRules to Free', () => {
    const paidConfig = {
      rules: [rule('/checkout', 'hide', 'exact', 'mobile'), rule('/products', 'hide', 'prefix')],
    }
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: paidConfig } }, FREE)
    // Free effective rules must be empty — no device or prefix rules.
    expect(result.rules).toEqual([])
    // No paidRules field in the effective output.
    expect(JSON.stringify(result)).not.toContain('paidRules')
  })

  test('Free with 3 general exact rules + 2 device rules → only 3 general exact returned', () => {
    const rules = [
      rule('/a', 'hide'),
      rule('/b', 'show'),
      rule('/c', 'hide'),
      rule('/d', 'hide', 'exact', 'desktop'),
      rule('/e', 'hide', 'exact', 'mobile'),
    ]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules } } }, FREE)
    expect(result.rules).toEqual([rule('/a', 'hide'), rule('/b', 'show'), rule('/c', 'hide')])
    // No device rules in the result.
    expect(result.rules.every(r => !r.device)).toBe(true)
  })

  test('Free with only device exact rules → empty (all filtered)', () => {
    const rules = [
      rule('/a', 'hide', 'exact', 'desktop'),
      rule('/b', 'hide', 'exact', 'mobile'),
    ]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules } } }, FREE)
    expect(result.rules).toEqual([])
  })

  test('Free with only prefix rules → empty (all filtered)', () => {
    const rules = [rule('/products', 'hide', 'prefix')]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules } } }, FREE)
    expect(result.rules).toEqual([])
  })

  test('Pro with device + prefix rules → all returned', () => {
    const rules = [
      rule('/help', 'hide'),
      rule('/checkout', 'hide', 'exact', 'mobile'),
      rule('/products', 'hide', 'prefix'),
    ]
    const result = resolveEffectivePageVisibility({ appearanceV2: { version: 1, pageVisibility: { rules } } }, PRO)
    expect(result.rules).toEqual(rules)
  })
})
