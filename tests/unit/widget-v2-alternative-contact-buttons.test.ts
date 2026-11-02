/// <reference types="bun-types" />
/**
 * Independent reviewer acceptance — Widget V2 / Feature 9 Alternative Contact Buttons.
 * Test-first contract. This file is reviewer-owned and must not be changed by
 * the feature implementation agent. The production modules do not exist yet.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  type AlternativeContactButton,
  buildAlternativeContactHref,
  isValidAlternativeContactButton,
} from '../../src/lib/widget/alternative-contact-types'
import {
  validateAlternativeContactButtonsPatch,
  mergeAlternativeContactButtonsPatch,
} from '../../src/lib/widget/alternative-contact-patch'
import {
  resolveEffectiveAlternativeContactButtons,
} from '../../src/lib/widget/effective-alternative-contacts'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'
import { mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'

type Kind = AlternativeContactButton['kind']
const item = (kind: Kind, label: string, value: string): AlternativeContactButton => ({ kind, label, value })
const PHONE = item('phone', 'Call us', '+989121234567')
const EMAIL = item('email', 'Email us', 'support@example.com')
const WHATSAPP = item('whatsapp', 'WhatsApp', '+989121234567')
const TELEGRAM = item('telegram', 'Telegram', 'support_team')
const WEBSITE = item('website', 'Support center', 'https://help.example.com/contact')
const FIVE = [PHONE, EMAIL, WHATSAPP, TELEGRAM, WEBSITE]
const TWO = [PHONE, EMAIL]
const free = getEntitlements('free')!
const pro = getEntitlements('pro')!
const max = getEntitlements('max')!
const self = getEntitlements('self-hosted')!
const input = (appearanceV2: unknown) => ({ appearanceV2 })
const stored = (items: AlternativeContactButton[], paidItems?: AlternativeContactButton[]) => ({
  version: 1 as const,
  desktop: {},
  mobile: {},
  alternativeContactButtons: { items, ...(paidItems ? { paidItems } : {}) },
})
const patch = (items: AlternativeContactButton[], entitlements = free) =>
  validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items } }, entitlements)

describe('Reviewer — plan limits and fail-closed boundaries', () => {
  test('Free has two slots, paid three plans have five, unknown plans have none', () => {
    expect(free.alternativeContactButtons).toBe(2)
    for (const e of [pro, max, self]) expect(e.alternativeContactButtons).toBe(5)
    expect(getEntitlements('plan-that-does-not-exist')).toBeNull()
  })
  test('Zero configured buttons means no contact UI, preserving legacy behavior', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(null), free)).toEqual({ items: [] })
    expect(resolveEffectiveAlternativeContactButtons(input(stored([])), pro)).toEqual({ items: [] })
    expect(patch([]).ok).toBe(true)
  })
  test('Free accepts exactly two and rejects three; paid accepts five', () => {
    expect(patch(TWO).ok).toBe(true)
    expect(patch([PHONE, EMAIL, WHATSAPP]).ok).toBe(false)
    expect(patch(FIVE, pro).ok).toBe(true)
    expect(patch(FIVE, max).ok).toBe(true)
    expect(patch(FIVE, self).ok).toBe(true)
  })
  test('Unknown plan rejects nonempty AND empty patches', () => {
    for (const items of [[], TWO])
      expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items } }, null).ok).toBe(false)
    expect(resolveEffectiveAlternativeContactButtons(input(stored(FIVE)), null)).toEqual({ items: [] })
  })
  test('Free effective config exposes only first two and cannot leak paidItems', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(stored(FIVE)), free)).toEqual({ items: TWO })
    const down = stored(TWO, FIVE)
    expect(resolveEffectiveAlternativeContactButtons(input(down), free)).toEqual({ items: TWO })
    expect(JSON.stringify(resolveEffectiveAlternativeContactButtons(input(down), free))).not.toContain('paidItems')
  })
  test('Free edits preserve five-button Pro preference on upgrade', () => {
    const down = mergeAlternativeContactButtonsPatch(stored(FIVE), { items: [EMAIL] }, free)
    expect(down.alternativeContactButtons?.items).toEqual([EMAIL])
    expect(down.alternativeContactButtons?.paidItems).toEqual(FIVE)
    expect(resolveEffectiveAlternativeContactButtons(input(down), free)).toEqual({ items: [EMAIL] })
    expect(resolveEffectiveAlternativeContactButtons(input(down), pro)).toEqual({ items: FIVE })
  })
  test('Repeated Free edits preserve paid preference; explicit paid edit clears it', () => {
    const a = mergeAlternativeContactButtonsPatch(stored(FIVE), { items: TWO }, free)
    const b = mergeAlternativeContactButtonsPatch(a, { items: [PHONE] }, free)
    expect(b.alternativeContactButtons?.paidItems).toEqual(FIVE)
    const c = mergeAlternativeContactButtonsPatch(b, { items: TWO }, pro)
    expect(c.alternativeContactButtons?.paidItems).toBeUndefined()
    expect(resolveEffectiveAlternativeContactButtons(input(c), pro)).toEqual({ items: TWO })
  })
})

describe('Reviewer — strict contact destination policy', () => {
  test('All five allowed contact methods produce safe canonical destinations', () => {
    expect(buildAlternativeContactHref(PHONE)).toBe('tel:+989121234567')
    expect(buildAlternativeContactHref(EMAIL)).toBe('mailto:support@example.com')
    expect(buildAlternativeContactHref(WHATSAPP)).toBe('https://wa.me/989121234567')
    expect(buildAlternativeContactHref(TELEGRAM)).toBe('https://t.me/support_team')
    expect(buildAlternativeContactHref(WEBSITE)).toBe('https://help.example.com/contact')
  })
  test('Valid buttons accepted, unrecognized kinds are rejected', () => {
    for (const x of FIVE) expect(isValidAlternativeContactButton(x)).toBe(true)
    for (const kind of ['sms', 'script', 'javascript', '__proto__'])
      expect(isValidAlternativeContactButton({ kind, label: 'Try', value: '123' })).toBe(false)
  })
  test('Reject dangerous external URL schemes and embedded credentials', () => {
    for (const value of [
      'javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd',
      'http://example.com', '//example.com/path',
      'https://user:password@example.com', 'https://example.com\\n',
    ]) {
      expect(patch([item('website', 'Open', value)]).ok, value).toBe(false)
    }
  })
  test('Reject malicious / malformed phone, email, WhatsApp and Telegram values', () => {
    const invalid: AlternativeContactButton[] = [
      item('phone', 'Call', 'tel:+989121234567'),
      item('phone', 'Call', '111<script>'),
      item('email', 'Email', 'mailto:support@example.com'),
      item('email', 'Email', 'not-an-email'),
      item('whatsapp', 'WA', 'https://wa.me/12345678'),
      item('telegram', 'TG', 'https://t.me/user'),
      item('telegram', 'TG', '../javascript:alert(1)'),
    ]
    for (const x of invalid) expect(patch([x]).ok, JSON.stringify(x)).toBe(false)
  })
  test('Reject mailto recipient query, fragment and encoded header injection on all validation layers', () => {
    // This MUST be an email ADDRESS, not a tenant-controlled mailto URL.
    // Otherwise clicking a contact button can prepopulate Bcc/body/subject
    // without a visitor's intention. No display-only sanitization is enough.
    const injected = [
      'support@example.com?bcc=attacker%40outside.test',
      'support@example.com?subject=Unexpected',
      'support@example.com?body=Injected',
      'support@example.com%0D%0ABcc:attacker%40outside.test',
      'support@example.com#fragment',
    ]
    for (const value of injected) {
      const contact = item('email', 'Email us', value)
      expect(isValidAlternativeContactButton(contact), value).toBe(false)
      expect(validateAlternativeContactButtonsPatch({
        alternativeContactButtons: { items: [contact] },
      }, pro).ok, value).toBe(false)
      expect(parseAppearanceV2({
        version: 1, alternativeContactButtons: { items: [contact] },
      }), value).toBeNull()
    }
  })

  test('Accessor-backed contact values are rejected without executing getters', () => {
    let triggered = false
    const raw = {
      kind: 'email', label: 'Email us',
      get value() { triggered = true; throw Error('Must not invoke getters') },
    }
    expect(() => isValidAlternativeContactButton(raw)).not.toThrow()
    expect(triggered).toBe(false)
    expect(isValidAlternativeContactButton(raw)).toBe(false)
    expect(validateAlternativeContactButtonsPatch({
      alternativeContactButtons: { items: [raw] },
    }, pro).ok).toBe(false)
    expect(triggered).toBe(false)
  })

  test('Reject blank, multiline, whitespace-padded and overlong labels', () => {
    for (const label of ['', '   ', ' Email', 'Email ', 'Email\nnow', 'A'.repeat(41)]) {
      expect(patch([item('email', label, 'a@example.com')]).ok).toBe(false)
    }
  })
  test('Reject duplicate kinds, even when labels or destinations differ', () => {
    expect(patch([EMAIL, item('email', 'Second', 'second@example.com')]).ok).toBe(false)
  })
  test('No client-supplied paidItems, unknown keys, getters, arrays or primitives', () => {
    for (const bad of [
      null, [], true, 'text', {}, { items: 'bad' },
      { items: TWO, paidItems: FIVE },
      { items: TWO, unexpected: true },
      { items: [{ ...PHONE, onClick: 'alert(1)' }] },
      { get items() { throw Error('getter must not run') } },
    ]) {
      expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: bad }, pro).ok).toBe(false)
    }
  })
  test('Malformed persisted configuration is rejected safely by strict V2 parser', () => {
    for (const config of [
      { items: [{ ...PHONE, href: 'javascript:alert(1)' }] },
      { items: [PHONE, PHONE] },
      { items: FIVE, paidItems: 'wrong' },
      { items: [{ ...WEBSITE, value: 'javascript:alert(1)' }] },
      { get items() { throw Error('unsafe getter') } },
    ]) {
      expect(parseAppearanceV2({ version: 1, alternativeContactButtons: config })).toBeNull()
    }
  })
})

describe('Reviewer — additive V2 true-patch preservation', () => {
  const previous = {
    version: 1 as const,
    desktop: { positioning: { anchor: 'bottom-center' as const } },
    mobile: { positioning: { anchor: 'bottom-start' as const } },
    colors: { mode: 'preset' as const, presetId: 'emerald' },
    quickReplies: { items: ['Support'] },
    preChatForm: { fields: [{ key: 'name' as const, required: true }] },
    pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
  }
  test('Alternative contacts PATCH retains all previous V2 features', () => {
    const merged = mergeAlternativeContactButtonsPatch(previous, { items: TWO }, pro)
    for (const k of ['desktop', 'mobile', 'colors', 'quickReplies', 'preChatForm', 'pageVisibility'] as const)
      expect(merged[k]).toEqual(previous[k])
    expect(merged.alternativeContactButtons?.items).toEqual(TWO)
  })
  test('Color, positioning, quick replies, pre-chat and page visibility PATCH preserve contact buttons', () => {
    const a = mergeAlternativeContactButtonsPatch(previous, { items: TWO }, pro)
    expect(mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } }).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePositioningPatch(a, { hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' } }, 'bottom-center').alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergeQuickRepliesPatch(a, { items: ['Help'] }, pro).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePreChatFormPatch(a, { fields: [] }, pro).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePageVisibilityPatch(a, { rules: [] }, pro).alternativeContactButtons).toEqual(a.alternativeContactButtons)
  })
  test('Canonical parser retains contacts alongside prior fields', () => {
    const a = { ...previous, alternativeContactButtons: { items: TWO } }
    expect(parseAppearanceV2(a)).toEqual(a)
  })
})
