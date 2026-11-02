/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 9 — Alternative Contact Buttons.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validateAlternativeContactButtonsPatch, mergeAlternativeContactButtonsPatch,
} from '../../src/lib/widget/alternative-contact-patch'
import { resolveEffectiveAlternativeContactButtons } from '../../src/lib/widget/effective-alternative-contacts'
import {
  type AlternativeContactButton,
  buildAlternativeContactHref,
  isValidAlternativeContactButton,
  ALTERNATIVE_CONTACT_KINDS,
  LABEL_MAX_CODE_POINTS,
  VALUE_MAX_LENGTH,
} from '../../src/lib/widget/alternative-contact-types'
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
const FREE = getEntitlements('free')!
const PRO = getEntitlements('pro')!
const MAX = getEntitlements('max')!
const SELF = getEntitlements('self-hosted')!
const UNKNOWN = getEntitlements('__unknown__')
const input = (appearanceV2: unknown) => ({ appearanceV2 })
const stored = (items: AlternativeContactButton[], paidItems?: AlternativeContactButton[]) => ({
  version: 1 as const, desktop: {}, mobile: {},
  alternativeContactButtons: { items, ...(paidItems ? { paidItems } : {}) },
})
const patch = (items: AlternativeContactButton[], ent: Readonly<ReturnType<typeof getEntitlements>> = FREE) =>
  validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items } }, ent as never)

describe('Developer — href builders for all five kinds', () => {
  test('phone → tel:', () => { expect(buildAlternativeContactHref(PHONE)).toBe('tel:+989121234567') })
  test('email → mailto:', () => { expect(buildAlternativeContactHref(EMAIL)).toBe('mailto:support@example.com') })
  test('whatsapp → wa.me with digits only', () => {
    expect(buildAlternativeContactHref(WHATSAPP)).toBe('https://wa.me/989121234567')
    expect(buildAlternativeContactHref(item('whatsapp', 'WA', '+1-555-123-4567'))).toBe('https://wa.me/15551234567')
  })
  test('telegram → t.me', () => { expect(buildAlternativeContactHref(TELEGRAM)).toBe('https://t.me/support_team') })
  test('website → original HTTPS URL', () => { expect(buildAlternativeContactHref(WEBSITE)).toBe('https://help.example.com/contact') })
  test('unknown kind → #', () => {
    expect(buildAlternativeContactHref({ kind: 'unknown' as Kind, label: 'X', value: 'x' })).toBe('#')
  })
})

describe('Developer — isValidAlternativeContactButton edge cases', () => {
  test('all five valid kinds accepted', () => {
    for (const x of FIVE) expect(isValidAlternativeContactButton(x)).toBe(true)
  })
  test('rejects unknown kinds', () => {
    for (const kind of ['sms', 'script', 'javascript', '__proto__', 'fax']) {
      expect(isValidAlternativeContactButton({ kind: kind as never, label: 'Try', value: '123' })).toBe(false)
    }
  })
  test('rejects extra properties', () => {
    expect(isValidAlternativeContactButton({ ...PHONE, href: 'tel:123' })).toBe(false)
    expect(isValidAlternativeContactButton({ ...PHONE, onClick: 'alert(1)' })).toBe(false)
  })
  test('rejects non-string fields', () => {
    expect(isValidAlternativeContactButton({ kind: 123, label: 'X', value: 'x' })).toBe(false)
    expect(isValidAlternativeContactButton({ kind: 'phone', label: 123, value: 'x' })).toBe(false)
    expect(isValidAlternativeContactButton({ kind: 'phone', label: 'X', value: 123 })).toBe(false)
  })
  test('rejects blank/whitespace-padded/multiline labels', () => {
    for (const label of ['', '   ', ' Call', 'Call ', 'Call\nnow', 'A'.repeat(41)]) {
      expect(isValidAlternativeContactButton(item('email', label, 'a@b.com'))).toBe(false)
    }
  })
  test('accepts label at exactly 40 code points', () => {
    expect(isValidAlternativeContactButton(item('email', 'A'.repeat(40), 'a@b.com'))).toBe(true)
  })
  test('rejects dangerous URL schemes for website', () => {
    for (const v of ['javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'http://example.com', '//example.com']) {
      expect(isValidAlternativeContactButton(item('website', 'Open', v))).toBe(false)
    }
  })
  test('rejects credentials in website URL', () => {
    expect(isValidAlternativeContactButton(item('website', 'Open', 'https://user:pass@example.com'))).toBe(false)
  })
  test('rejects backslash in website URL', () => {
    expect(isValidAlternativeContactButton(item('website', 'Open', 'https://example.com\\n'))).toBe(false)
  })
  test('rejects tel: prefix in phone value', () => {
    expect(isValidAlternativeContactButton(item('phone', 'Call', 'tel:+989121234567'))).toBe(false)
  })
  test('rejects mailto: prefix in email value', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'mailto:a@b.com'))).toBe(false)
  })
  test('rejects http URL in whatsapp value', () => {
    expect(isValidAlternativeContactButton(item('whatsapp', 'WA', 'https://wa.me/123'))).toBe(false)
  })
  test('rejects @ prefix in telegram value', () => {
    expect(isValidAlternativeContactButton(item('telegram', 'TG', '@user'))).toBe(false)
  })
  test('rejects script tags in values', () => {
    expect(isValidAlternativeContactButton(item('phone', 'Call', '111<script>'))).toBe(false)
    expect(isValidAlternativeContactButton(item('telegram', 'TG', '../javascript:alert(1)'))).toBe(false)
  })
  test('constants', () => {
    expect(ALTERNATIVE_CONTACT_KINDS).toEqual(['phone', 'email', 'whatsapp', 'telegram', 'website'])
    expect(LABEL_MAX_CODE_POINTS).toBe(40)
    expect(VALUE_MAX_LENGTH).toBe(500)
  })
})

describe('Developer — plan limits and fail-closed', () => {
  test('Free max 2, paid max 5', () => {
    expect(FREE.alternativeContactButtons).toBe(2)
    for (const e of [PRO, MAX, SELF]) expect(e.alternativeContactButtons).toBe(5)
  })
  test('Free accepts 0-2, rejects 3', () => {
    expect(patch([]).ok).toBe(true)
    expect(patch([PHONE]).ok).toBe(true)
    expect(patch(TWO).ok).toBe(true)
    expect(patch([PHONE, EMAIL, WHATSAPP]).ok).toBe(false)
  })
  test('Pro accepts 5, rejects 6', () => {
    expect(patch(FIVE, PRO).ok).toBe(true)
    expect(patch([...FIVE, PHONE], PRO).ok).toBe(false) // 6 items (but PHONE is duplicate kind)
  })
  test('Unknown plan rejects all', () => {
    expect(patch([], UNKNOWN).ok).toBe(false)
    expect(patch(TWO, UNKNOWN).ok).toBe(false)
  })
  test('null entitlements rejected', () => {
    expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items: [] } }, null as unknown as never).ok).toBe(false)
  })
})

describe('Developer — validation edge cases', () => {
  test('rejects client-supplied paidItems', () => {
    expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items: TWO, paidItems: FIVE } }, PRO).ok).toBe(false)
  })
  test('rejects duplicate kinds', () => {
    expect(patch([EMAIL, item('email', 'Second', 'second@example.com')]).ok).toBe(false)
  })
  test('rejects unexpected keys', () => {
    expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items: TWO, plan: 'pro' } }, PRO).ok).toBe(false)
    expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { items: TWO, css: 'x' } }, PRO).ok).toBe(false)
  })
  test('rejects malformed types', () => {
    for (const bad of [null, [], true, 'text', {}, { items: 'bad' }, { items: null }]) {
      expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: bad }, PRO).ok).toBe(false)
    }
  })
  test('rejects getter-based objects', () => {
    expect(validateAlternativeContactButtonsPatch({ alternativeContactButtons: { get items() { throw Error('x') } } }, PRO).ok).toBe(false)
  })
  test('empty items accepted on all plans', () => {
    for (const e of [FREE, PRO, MAX, SELF]) {
      expect(patch([], e)).toEqual({ ok: true, data: { items: [] } })
    }
  })
})

describe('Developer — resolver and downgrade/upgrade', () => {
  test('Free truncates to first 2', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(stored(FIVE)), FREE)).toEqual({ items: TWO })
  })
  test('Pro uses all stored items', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(stored(FIVE)), PRO)).toEqual({ items: FIVE })
  })
  test('Unknown → empty', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(stored(FIVE)), UNKNOWN)).toEqual({ items: [] })
  })
  test('No V2 → empty', () => {
    expect(resolveEffectiveAlternativeContactButtons(input(null), PRO)).toEqual({ items: [] })
  })
  test('Free effective never leaks paidItems', () => {
    const down = stored(TWO, FIVE)
    const result = resolveEffectiveAlternativeContactButtons(input(down), FREE)
    expect(result).toEqual({ items: TWO })
    expect(JSON.stringify(result)).not.toContain('paidItems')
  })
  test('Pro downgrade preserves paidItems on upgrade', () => {
    const down = mergeAlternativeContactButtonsPatch(stored(FIVE), { items: [EMAIL] }, FREE)
    expect(down.alternativeContactButtons?.paidItems).toEqual(FIVE)
    expect(resolveEffectiveAlternativeContactButtons(input(down), FREE)).toEqual({ items: [EMAIL] })
    expect(resolveEffectiveAlternativeContactButtons(input(down), PRO)).toEqual({ items: FIVE })
  })
  test('Repeated Free edits preserve paidItems', () => {
    const a = mergeAlternativeContactButtonsPatch(stored(FIVE), { items: TWO }, FREE)
    const b = mergeAlternativeContactButtonsPatch(a, { items: [PHONE] }, FREE)
    expect(b.alternativeContactButtons?.paidItems).toEqual(FIVE)
  })
  test('Explicit paid save clears paidItems', () => {
    const down = mergeAlternativeContactButtonsPatch(stored(FIVE), { items: TWO }, FREE)
    const up = mergeAlternativeContactButtonsPatch(down, { items: TWO }, PRO)
    expect(up.alternativeContactButtons?.paidItems).toBeUndefined()
  })
})

describe('Developer — strict parseAppearanceV2', () => {
  test('valid config with all V2 fields', () => {
    const v = { version: 1, alternativeContactButtons: { items: TWO } }
    expect(parseAppearanceV2(v)?.alternativeContactButtons).toEqual({ items: TWO })
  })
  test('rejects null, arrays, primitives', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: null })).toBeNull()
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: 'hello' })).toBeNull()
  })
  test('rejects invalid kind', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [{ kind: 'sms', label: 'X', value: '123' }] } })).toBeNull()
  })
  test('rejects extra properties on button', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [{ ...PHONE, href: 'tel:123' }] } })).toBeNull()
  })
  test('rejects duplicate kinds', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [PHONE, PHONE] } })).toBeNull()
  })
  test('rejects empty paidItems', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: TWO, paidItems: [] } })).toBeNull()
  })
  test('rejects getters', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { get items() { throw Error('x') } } })).toBeNull()
  })
  test('rejects dangerous website value', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [item('website', 'Open', 'javascript:alert(1)')] } })).toBeNull()
  })
  test('absent field is valid', () => {
    expect(parseAppearanceV2({ version: 1 })?.alternativeContactButtons).toBeUndefined()
  })
  test('empty items is valid', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [] } })?.alternativeContactButtons).toEqual({ items: [] })
  })
})

describe('Developer — cross-feature preservation', () => {
  const full = {
    version: 1 as const,
    desktop: { positioning: { anchor: 'bottom-center' as const } },
    mobile: { positioning: { anchor: 'bottom-start' as const } },
    colors: { mode: 'preset' as const, presetId: 'emerald' },
    quickReplies: { items: ['Support'] },
    preChatForm: { fields: [{ key: 'name' as const, required: true }] },
    pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
    alternativeContactButtons: { items: TWO },
  }
  test('alt contacts edit preserves all V2 neighbors', () => {
    const r = mergeAlternativeContactButtonsPatch(full, { items: [PHONE] }, PRO)
    expect(r.colors).toEqual(full.colors)
    expect(r.quickReplies).toEqual(full.quickReplies)
    expect(r.preChatForm).toEqual(full.preChatForm)
    expect(r.pageVisibility).toEqual(full.pageVisibility)
    expect(r.desktop).toEqual(full.desktop)
    expect(r.mobile).toEqual(full.mobile)
    expect(parseAppearanceV2(r)).not.toBeNull()
  })
  test('all 5 sibling merges preserve alt contacts', () => {
    const a = mergeAlternativeContactButtonsPatch(full, { items: TWO }, PRO)
    expect(mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } }).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePositioningPatch(a, { hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' } }, 'bottom-center').alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergeQuickRepliesPatch(a, { items: ['Help'] }, PRO).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePreChatFormPatch(a, { fields: [] }, PRO).alternativeContactButtons).toEqual(a.alternativeContactButtons)
    expect(mergePageVisibilityPatch(a, { rules: [] }, PRO).alternativeContactButtons).toEqual(a.alternativeContactButtons)
  })
})

describe('Developer — email injection and accessor safety regression', () => {
  test('email with ?bcc= query parameter rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com?bcc=attacker@outside.test'))).toBe(false)
  })
  test('email with ?subject= query parameter rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com?subject=hi'))).toBe(false)
  })
  test('email with ?body= query parameter rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com?body=hello'))).toBe(false)
  })
  test('email with URL fragment rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com#fragment'))).toBe(false)
  })
  test('email with percent-encoded CR/LF rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com%0d%0aBcc:attacker@test'))).toBe(false)
  })
  test('email with percent sign rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com%40test'))).toBe(false)
  })
  test('email with raw newline rejected', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support@example.com\nBcc:attacker@test'))).toBe(false)
  })
  test('legitimate plus-addressing still accepted', () => {
    expect(isValidAlternativeContactButton(item('email', 'Email', 'support+sales@example.com'))).toBe(true)
  })
  test('legitimate email still accepted', () => {
    expect(isValidAlternativeContactButton(EMAIL)).toBe(true)
  })
  test('PATCH validation rejects email with ?bcc=', () => {
    expect(patch([item('email', 'Email', 'support@example.com?bcc=attacker@outside.test')]).ok).toBe(false)
  })
  test('V2 parser rejects email with ?bcc=', () => {
    expect(parseAppearanceV2({ version: 1, alternativeContactButtons: { items: [item('email', 'Email', 'support@example.com?bcc=x')] } })).toBeNull()
  })

  test('accessor-backed value does not execute getter', () => {
    let triggered = false
    const raw = {
      kind: 'email' as const, label: 'Email us',
      get value() { triggered = true; throw Error('Must not invoke getters') },
    }
    // Must not throw — must return false.
    expect(isValidAlternativeContactButton(raw)).toBe(false)
    expect(triggered).toBe(false)
  })
  test('accessor-backed kind does not execute getter', () => {
    let triggered = false
    const raw = {
      get kind() { triggered = true; throw Error('Must not invoke getters') },
      label: 'Test', value: 'support@example.com',
    }
    expect(isValidAlternativeContactButton(raw)).toBe(false)
    expect(triggered).toBe(false)
  })
  test('accessor-backed label does not execute getter', () => {
    let triggered = false
    const raw = {
      kind: 'email' as const,
      get label() { triggered = true; throw Error('Must not invoke getters') },
      value: 'support@example.com',
    }
    expect(isValidAlternativeContactButton(raw)).toBe(false)
    expect(triggered).toBe(false)
  })
  test('object with Symbol key rejected', () => {
    const sym = Symbol('test')
    const raw = { kind: 'email' as const, label: 'Test', value: 'support@example.com', [sym]: 'extra' }
    expect(isValidAlternativeContactButton(raw)).toBe(false)
  })
  test('object with extra property rejected', () => {
    expect(isValidAlternativeContactButton({ ...EMAIL, href: 'tel:123' })).toBe(false)
    expect(isValidAlternativeContactButton({ ...PHONE, onClick: 'alert(1)' })).toBe(false)
  })
  test('PATCH validation rejects accessor-backed value', () => {
    const raw = {
      kind: 'email', label: 'Email',
      get value() { throw Error('getter') },
    }
    expect(patch([raw as never]).ok).toBe(false)
  })
  test('V2 parser rejects accessor-backed value', () => {
    const raw = { version: 1, alternativeContactButtons: { items: [{ kind: 'email', label: 'Email', get value() { throw Error('x') } }] } }
    expect(parseAppearanceV2(raw)).toBeNull()
  })
})
