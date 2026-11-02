/// <reference types="bun-types" />
/**
 * Reviewer-owned, independent acceptance tests: Feature 8 Page Visibility.
 * DO NOT edit to make production failures green. These tests are intentionally
 * separate from the developer's implementation suite.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { evaluatePageVisibility, isValidPagePattern, type PageVisibilityRule } from '../../src/lib/widget/page-visibility-types'
import { resolveEffectivePageVisibility } from '../../src/lib/widget/effective-page-visibility'
import { validatePageVisibilityPatch, mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'

const free = getEntitlements('free')!
const pro = getEntitlements('pro')!
const rule = (pattern: string, action: 'show' | 'hide', match: 'exact' | 'prefix' = 'exact', device?: 'desktop' | 'mobile'): PageVisibilityRule =>
  ({ pattern, action, match, ...(device ? { device } : {}) })
const stored = (rules: PageVisibilityRule[], paidRules?: PageVisibilityRule[]) => ({
  appearanceV2: { version: 1, desktop: {}, mobile: {}, pageVisibility: { rules, ...(paidRules ? { paidRules } : {}) } },
})

describe('Reviewer: Page Visibility entitlement boundaries', () => {
  test('Free rejects paid prefix/device rules on PATCH', () => {
    for (const r of [rule('/shop', 'hide', 'prefix'), rule('/shop', 'hide', 'exact', 'mobile'), rule('/shop', 'hide', 'exact', 'desktop')]) {
      expect(validatePageVisibilityPatch({ pageVisibility: { rules: [r] } }, free)).toEqual({ ok: false, code: 'page_visibility_not_allowed' })
    }
  })

  test('Free public effective rules never include PAID device-scoped exact rules after downgrade', () => {
    const paidOnly = [rule('/checkout', 'hide', 'exact', 'mobile'), rule('/account', 'hide', 'exact', 'desktop')]
    const result = resolveEffectivePageVisibility(stored(paidOnly), free)
    expect(result.rules, 'Free must not enforce a desktop/mobile selector saved while paid').toEqual([])
  })

  test('Free retains eligible general exact rule, but drops paid-only device and prefix rules', () => {
    const mixed = [rule('/help', 'hide'), rule('/checkout', 'hide', 'exact', 'mobile'), rule('/products', 'hide', 'prefix')]
    expect(resolveEffectivePageVisibility(stored(mixed), free).rules).toEqual([rule('/help', 'hide')])
  })

  test('Pro downgrade to Free then back preserves paidRules without leaking them publicly', () => {
    const advanced = [rule('/checkout', 'hide', 'exact', 'mobile'), rule('/products', 'hide', 'prefix')]
    const downgraded = mergePageVisibilityPatch(stored(advanced).appearanceV2, { rules: [rule('/privacy', 'hide')] }, free)
    expect(resolveEffectivePageVisibility({ appearanceV2: downgraded }, free).rules).toEqual([rule('/privacy', 'hide')])
    expect(resolveEffectivePageVisibility({ appearanceV2: downgraded }, pro).rules).toEqual(advanced)
    const upgraded = mergePageVisibilityPatch(downgraded, { rules: [rule('/new', 'hide')] }, pro)
    expect(upgraded.pageVisibility?.paidRules).toBeUndefined()
    expect(resolveEffectivePageVisibility({ appearanceV2: upgraded }, pro).rules).toEqual([rule('/new', 'hide')])
  })

  test('Unknown plan has no rules and cannot PATCH', () => {
    expect(resolveEffectivePageVisibility(stored([rule('/hidden', 'hide')]), null).rules).toEqual([])
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [] } }, null).ok).toBe(false)
  })

  test('Free maximum three rules and paid maximum ten are authoritative', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => rule('/path-' + i, 'hide'))
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: many(3) } }, free).ok).toBe(true)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: many(4) } }, free).ok).toBe(false)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: many(10) } }, pro).ok).toBe(true)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: many(11) } }, pro).ok).toBe(false)
  })

  test('Prototype keys and unknown client paidRules never become executable config', () => {
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [], paidRules: [] } }, pro).ok).toBe(false)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [rule('/safe', 'hide'), rule('/safe', 'hide')] } }, pro).ok).toBe(false)
    expect(validatePageVisibilityPatch({ pageVisibility: { rules: [{ ...rule('/safe', 'hide'), unexpected: 'x' }] } }, pro).ok).toBe(false)
  })

  test('Malformed V2 pageVisibility fails parsing without erasing sibling fields', () => {
    expect(parseAppearanceV2({ version: 1, desktop: {}, mobile: {}, pageVisibility: { rules: [rule('/good', 'hide')], paidRules: 'not-array' } })).toBeNull()
    const a = stored([rule('/safe', 'hide')]).appearanceV2
    const b = mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'emerald' } })
    expect(b.pageVisibility).toEqual(a.pageVisibility)
    const c = mergePreChatFormPatch(b, { fields: [{ key: 'name', required: true }] }, pro)
    expect(c.pageVisibility).toEqual(a.pageVisibility)
  })
})

describe('Reviewer: real pathname matching contract', () => {
  test('Default visibility and exact matching', () => {
    expect(evaluatePageVisibility([], '/anything', 'mobile')).toBe('show')
    expect(evaluatePageVisibility([rule('/checkout', 'hide')], '/checkout', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility([rule('/checkout', 'hide')], '/checkout/success', 'desktop')).toBe('show')
  })

  test('Segment prefix never matches similarly named sibling routes', () => {
    const rules = [rule('/cart', 'hide', 'prefix')]
    expect(evaluatePageVisibility(rules, '/cart/items', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/cartography', 'desktop')).toBe('show')
  })

  test('Root prefix means the entire site, including nested routes', () => {
    const rules = [rule('/', 'hide', 'prefix')]
    expect(evaluatePageVisibility(rules, '/', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/checkout', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility(rules, '/products/view', 'mobile')).toBe('hide')
  })

  test('Hide wins over show independent of ordering', () => {
    const h = rule('/store', 'hide', 'prefix'), s = rule('/store/a', 'show')
    expect(evaluatePageVisibility([s, h], '/store/a', 'desktop')).toBe('hide')
    expect(evaluatePageVisibility([h, s], '/store/a', 'desktop')).toBe('hide')
  })

  test('Device-specific visibility does not apply to other device', () => {
    const m = rule('/page', 'hide', 'exact', 'mobile')
    expect(evaluatePageVisibility([m], '/page', 'mobile')).toBe('hide')
    expect(evaluatePageVisibility([m], '/page', 'desktop')).toBe('show')
  })

  test('Pattern input stays literal and bounded', () => {
    for (const invalid of ['checkout', '', '/*', '/x?', '/x\\y', '/x\n', '/'.repeat(501)]) expect(isValidPagePattern(invalid)).toBe(false)
    expect(isValidPagePattern('/x')).toBe(true)
  })
})
