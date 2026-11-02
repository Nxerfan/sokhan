/// <reference types="bun-types" />
/**
 * Independent reviewer-owned Feature 7 Pre-chat Form contract.
 * No fabricated entitlements or security bypass; plan is server-derived.
 * Developer-owned tests live in a separate implementation suite.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { validatePreChatFormPatch, mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'
import { resolveEffectivePreChatForm } from '../../src/lib/widget/effective-pre-chat-form'
import { validatePreChatSubmission, shouldRequirePreChat } from '../../src/lib/widget/pre-chat-form-policy'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

type Field = { key: 'name' | 'email' | 'phone' | 'company'; required: boolean }
const freeFields: Field[] = [{ key: 'name', required: true }, { key: 'email', required: false }]
const paidFields: Field[] = [...freeFields, { key: 'phone', required: true }, { key: 'company', required: false }]
const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unrecognized__')
const full = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 35, offsetY: -12 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -19, offsetY: 9 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const, paidShape: 'pill' as const },
  attention: { animation: 'pulse' as const, paidAnimation: 'glow' as const },
  messagePreview: { enabled: true },
  quickReplies: { items: ['Hello', 'Pricing'], paidItems: ['Hello', 'Pricing', 'Support'] },
  preChatForm: { fields: paidFields },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Pre-chat Form — plan entitlements, defaults and effective resolution', () => {
  test('Free basic, paid advanced and unknown fail closed', () => {
    expect(FREE?.preChatForm).toBe('basic')
    for (const e of [PRO, MAX, SELF]) expect(e?.preChatForm).toBe('advanced')
    expect(UNKNOWN).toBeNull()
    expect(resolveEffectivePreChatForm(input(full), FREE)).toEqual({ fields: freeFields })
    for (const e of [PRO, MAX, SELF])
      expect(resolveEffectivePreChatForm(input(full), e)).toEqual({ fields: paidFields })
    expect(resolveEffectivePreChatForm(input(full), UNKNOWN)).toEqual({ fields: [] })
  })
  test('old V1, malformed V2, or absent selection never unexpectedly blocks chat', () => {
    for (const e of [FREE, PRO, UNKNOWN]) {
      expect(resolveEffectivePreChatForm(input(null), e)).toEqual({ fields: [] })
      expect(resolveEffectivePreChatForm(input({ version: 1 }), e)).toEqual({ fields: [] })
      expect(resolveEffectivePreChatForm(input({ version: 42 }), e)).toEqual({ fields: [] })
    }
  })
  test('Free is limited to name/email fields; paid can add phone/company', () => {
    expect(validatePreChatFormPatch({ preChatForm: { fields: freeFields } }, FREE))
      .toEqual({ ok: true, data: { fields: freeFields } })
    expect(validatePreChatFormPatch({ preChatForm: { fields: paidFields } }, PRO))
      .toEqual({ ok: true, data: { fields: paidFields } })
    const bad = validatePreChatFormPatch({ preChatForm: { fields: paidFields } }, FREE)
    expect(bad).toEqual({ ok: false, code: 'pre_chat_form_not_allowed' })
    expect(validatePreChatFormPatch({ preChatForm: { fields: [] } }, UNKNOWN).ok).toBe(false)
  })
})

describe('Pre-chat Form — strict PATCH shape and plan isolation', () => {
  test('empty list explicitly disables form on both Free and paid', () => {
    for (const e of [FREE, PRO])
      expect(validatePreChatFormPatch({ preChatForm: { fields: [] } }, e))
        .toEqual({ ok: true, data: { fields: [] } })
  })
  test('forbid malformed types, untrusted fields, duplicate keys and excess entries', () => {
    const invalid = [
      null, undefined, true, {}, [], { fields: null }, { fields: 'name' },
      { fields: ['name'] }, { fields: [{ key: 'name', required: 'true' }] },
      { fields: [{ key: 'name' }] }, { fields: [{ key: 'other', required: true }] },
      { fields: [{ key: 'name', required: true, label: '<script>' }] },
      { fields: freeFields, paidFields },
      { fields: [freeFields[0], freeFields[0]] },
      { fields: [...paidFields, freeFields[0]] },
    ]
    for (const preChatForm of invalid)
      expect(validatePreChatFormPatch({ preChatForm }, PRO).ok).toBe(false)
  })
  test('reject all client-supplied paidFields/plan/HTML/CSS and nested non-plain storage', () => {
    for (const data of [
      { fields: freeFields, paidFields },
      { fields: freeFields, plan: 'pro' },
      { fields: freeFields, html: '<form></form>' },
      { fields: freeFields, css: 'position:absolute' },
    ]) expect(validatePreChatFormPatch({ preChatForm: data }, PRO).ok).toBe(false)
    for (const v of [
      { version: 1, preChatForm: { fields: [{ key: 'name', required: 'yes' }] } },
      { version: 1, preChatForm: { fields: freeFields, unexpected: 1 } },
      { version: 1, preChatForm: { fields: [{ key: 'email', required: true }, { key: 'email', required: false }] } },
      { version: 1, preChatForm: { get fields() { throw Error('unsafe getter') } } },
    ]) expect(parseAppearanceV2(v)).toBeNull()
  })
})

describe('Pre-chat Form — downgrade/upgrade and true-patch preservation', () => {
  test('Pro advanced -> Free edit basic preserves advanced preference', () => {
    const down = mergePreChatFormPatch(full, { fields: [{ key: 'name', required: false }] }, FREE)
    expect(down.preChatForm).toEqual({
      fields: [{ key: 'name', required: false }],
      paidFields,
    })
    expect(resolveEffectivePreChatForm(input(down), FREE).fields).toEqual([{ key: 'name', required: false }])
    expect(resolveEffectivePreChatForm(input(down), PRO).fields).toEqual(paidFields)
  })
  test('Free edit again keeps original paid configuration', () => {
    const a = mergePreChatFormPatch(full, { fields: freeFields }, FREE)
    const b = mergePreChatFormPatch(a, { fields: [] }, FREE)
    expect(b.preChatForm?.paidFields).toEqual(paidFields)
    expect(resolveEffectivePreChatForm(input(b), PRO).fields).toEqual(paidFields)
  })
  test('explicit paid save clears paidFields even when identical to Free list', () => {
    const down = mergePreChatFormPatch(full, { fields: [{ key: 'name', required: true }] }, FREE)
    const upgraded = mergePreChatFormPatch(down, { fields: [{ key: 'name', required: true }] }, PRO)
    expect(upgraded.preChatForm).toEqual({ fields: [{ key: 'name', required: true }] })
    expect(resolveEffectivePreChatForm(input(upgraded), PRO).fields).toEqual([{ key: 'name', required: true }])
  })
  test('schema admits feature with all existing features without dropping them', () => {
    expect(parseAppearanceV2(full)).toEqual(full)
    const changed = mergePreChatFormPatch(full, { fields: [] }, PRO)
    for (const key of ['colors', 'launcher', 'attention', 'messagePreview', 'quickReplies', 'desktop', 'mobile'] as const)
      expect(changed[key]).toEqual(full[key])
  })
  test('all SIX previous V2 patch merges preserve the pre-chat form', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'sunset' } }).preChatForm).toEqual(full.preChatForm)
    expect(mergeLauncherPatch(full, { shape: 'pill' }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergeAttentionPatch(full, { animation: 'glow' }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergeMessagePreviewPatch(full, { enabled: false }).preChatForm).toEqual(full.preChatForm)
    expect(mergeQuickRepliesPatch(full, { items: ['Support'] }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergePositioningPatch(full, {
      hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' },
    }, 'bottom-center').preChatForm).toEqual(full.preChatForm)
  })
})

describe('Pre-chat Form — pure visitor submission validation', () => {
  const required = { fields: [{ key: 'name' as const, required: true }, { key: 'email' as const, required: true }] }
  test('valid values are accepted with strict declared field keys', () => {
    expect(validatePreChatSubmission({ values: { name: 'Alice', email: 'alice@example.com' } }, required))
      .toEqual({ ok: true, data: { name: 'Alice', email: 'alice@example.com' } })
  })
  test('required values must be present and nonblank, optional may be omitted', () => {
    for (const values of [{}, { name: 'Alice' }, { name: ' ', email: 'alice@example.com' }])
      expect(validatePreChatSubmission({ values }, required).ok).toBe(false)
    expect(validatePreChatSubmission({ values: { name: 'Alice' } }, { fields: freeFields }))
      .toEqual({ ok: true, data: { name: 'Alice' } })
  })
  test('reject email malformed, overlong values, HTML-like field KEYS and injection', () => {
    for (const values of [
      { name: 'Alice', email: 'not-an-email' },
      { name: 'A'.repeat(101), email: 'alice@example.com' },
      { name: 'Alice', email: 'alice@example.com', role: 'admin' },
      { name: 'Alice', email: 'alice@example.com', emailVerifiedAt: '2026-01-01' },
      { name: 'Alice', email: '<img src=x onerror=alert(1)>' },
    ]) expect(validatePreChatSubmission({ values }, required).ok).toBe(false)
  })
  test('unknown or absent configuration requires NO pre-chat flow', () => {
    expect(shouldRequirePreChat({ fields: [] }, false, false)).toBe(false)
    expect(shouldRequirePreChat({ fields: [] }, true, false)).toBe(false)
    expect(shouldRequirePreChat(required, true, true)).toBe(false)
  })
  test('requires form only before first persisted conversation message and until completed', () => {
    expect(shouldRequirePreChat(required, false, false)).toBe(true)
    expect(shouldRequirePreChat(required, true, false)).toBe(false)
    expect(shouldRequirePreChat(required, false, true)).toBe(false)
  })
  test('form values cannot be accepted if not configured by server', () => {
    expect(validatePreChatSubmission({ values: { name: 'Alice' } }, { fields: [] }).ok).toBe(false)
  })
})
