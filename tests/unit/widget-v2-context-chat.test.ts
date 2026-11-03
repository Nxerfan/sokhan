/// <reference types="bun-types" />
/**
 * Independent reviewer-owned acceptance contract — Feature 11 Context Chat.
 * Deliberately test-first: implementation files do not exist on handoff HEAD.
 * Visitor consent is a per-message opt-in; no automatic page scraping.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  isValidContextChatConfig,
  sanitizePageContext,
  acceptPageContext,
} from '../../src/lib/widget/context-chat-types'
import {
  validateContextChatPatch, mergeContextChatPatch,
} from '../../src/lib/widget/context-chat-patch'
import {
  resolveEffectiveContextChat,
} from '../../src/lib/widget/effective-context-chat'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeSmartAvoidancePatch } from '../../src/lib/widget/smart-avoidance-patch'
import { mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'
import { mergeAlternativeContactButtonsPatch } from '../../src/lib/widget/alternative-contact-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'

const free = getEntitlements('free')!
const pro = getEntitlements('pro')!
const max = getEntitlements('max')!
const self = getEntitlements('self-hosted')!
const stored = (enabled: boolean) => ({
  version: 1 as const, desktop: {}, mobile: {}, contextChat: { enabled },
})
const page = { pathname: '/products/example', title: 'Example product' }
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Reviewer — Context Chat BETA entitlement and persistence', () => {
  test('Only Pro, Max and Self-hosted permit Context Chat; Free and unknown fail closed', () => {
    expect(free.contextChat).toBe(false)
    for (const e of [pro, max, self]) expect(e.contextChat).toBe(true)
    expect(getEntitlements('constructor')).toBeNull()
    expect(resolveEffectiveContextChat(input(stored(true)), free)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(stored(true)), null)).toEqual({ enabled: false })
  })
  test('Legacy V2 and missing configuration default off even when plan is paid', () => {
    expect(resolveEffectiveContextChat(input(null), pro)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input({ version: 1 }), pro)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(stored(true)), pro)).toEqual({ enabled: true })
  })
  test('Paid accepts true/false toggles; Free rejects BOTH values', () => {
    for (const enabled of [true, false]) {
      for (const entitlements of [pro, max, self]) {
        expect(validateContextChatPatch({ contextChat: { enabled } }, entitlements).ok).toBe(true)
      }
      expect(validateContextChatPatch({ contextChat: { enabled } }, free).ok).toBe(false)
      expect(validateContextChatPatch({ contextChat: { enabled } }, null).ok).toBe(false)
    }
  })
  test('Malformed patches and accessor objects fail without executing getters', () => {
    let invoked = false
    const accessor = { get enabled() { invoked = true; throw Error('must not execute') } }
    const variants: unknown[] = [null, [], true, {}, { enabled: 'true' }, { enabled: 1 },
      { enabled: true, plan: 'pro' }, { enabled: true, script: 'alert(1)' }, accessor]
    for (const val of variants) {
      expect(() => validateContextChatPatch({ contextChat: val }, pro)).not.toThrow()
      expect(validateContextChatPatch({ contextChat: val }, pro).ok).toBe(false)
    }
    expect(invoked).toBe(false)
  })
  test('Strict appearance parser validates and persists only the boolean enabled field', () => {
    expect(parseAppearanceV2(stored(true))?.contextChat).toEqual({ enabled: true })
    expect(parseAppearanceV2(stored(false))?.contextChat).toEqual({ enabled: false })
    expect(isValidContextChatConfig({ enabled: true })).toBe(true)
    expect(isValidContextChatConfig({ enabled: 'true' })).toBe(false)
    for (const config of [null, [], {}, { enabled: 'true' }, { enabled: true, extra: true }]) {
      expect(parseAppearanceV2({ version: 1, contextChat: config })).toBeNull()
    }
  })
  test('Paid preference survives downgrade and returns on upgrade without Free access', () => {
    const saved = mergeContextChatPatch({ version: 1 }, { enabled: true }, pro)
    expect(saved.contextChat).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(saved), pro)).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(saved), free)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(saved), max)).toEqual({ enabled: true })
    const off = mergeContextChatPatch(saved, { enabled: false }, pro)
    expect(resolveEffectiveContextChat(input(off), pro)).toEqual({ enabled: false })
  })
  test('Context Chat true-patch and prior feature true-patches preserve each other', () => {
    const before = {
      version: 1 as const, desktop: {}, mobile: {},
      colors: { mode: 'preset' as const, presetId: 'emerald' },
      smartAvoidance: { enabled: true },
      pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
      alternativeContactButtons: { items: [{ kind: 'email' as const, label: 'Email', value: 'hi@example.com' }] },
      preChatForm: { fields: [{ key: 'name' as const, required: true }] },
    }
    const saved = mergeContextChatPatch(before, { enabled: true }, pro)
    for (const k of ['colors', 'smartAvoidance', 'pageVisibility', 'alternativeContactButtons', 'preChatForm'] as const)
      expect(saved[k]).toEqual(before[k])
    expect(mergeColorPatch(saved, { theme: { mode: 'preset', presetId: 'emerald' } }).contextChat).toEqual({ enabled: true })
    expect(mergeSmartAvoidancePatch(saved, { enabled: false }, pro).contextChat).toEqual({ enabled: true })
    expect(mergePageVisibilityPatch(saved, { rules: [] }, pro).contextChat).toEqual({ enabled: true })
    expect(mergeAlternativeContactButtonsPatch(saved, { items: [] }, pro).contextChat).toEqual({ enabled: true })
    expect(mergePreChatFormPatch(saved, { fields: [] }, pro).contextChat).toEqual({ enabled: true })
  })
})

describe('Reviewer — visitor page-context safety contract', () => {
  test('Valid plain title and path are accepted without origin, query or fragment', () => {
    expect(sanitizePageContext(page)).toEqual(page)
    expect(acceptPageContext(page, true)).toEqual(page)
  })
  test('When effective feature disabled, the backend must drop any supplied context', () => {
    expect(acceptPageContext(page, false)).toBeNull()
  })
  test('No context unless a valid object is explicitly supplied with a send', () => {
    expect(acceptPageContext(undefined, true)).toBeNull()
    expect(acceptPageContext(null, true)).toBeNull()
    expect(sanitizePageContext(undefined)).toBeNull()
  })
  test('Never accept absolute URLs, query strings, fragments or protocol-relative paths', () => {
    for (const pathname of [
      'https://host.example/secret', '//attacker.example/path', '/checkout?token=SECRET',
      '/product#fragment', 'javascript:alert(1)', '/\\evil', '/x\nInjected',
      '/%0D%0Aevil',
    ]) expect(sanitizePageContext({ pathname, title: 'Page' }), pathname).toBeNull()
  })
  test('Reject additional keys, raw DOM, form inputs and credentials', () => {
    const dangerous = [
      { ...page, html: '<input value="secret">' },
      { ...page, search: '?token=SECRET' },
      { ...page, hash: '#private' },
      { ...page, origin: 'https://host.example' },
      { ...page, cookies: 'session=secret' },
      { ...page, fullUrl: 'https://site.test/?auth=secret' },
    ]
    for (const candidate of dangerous) expect(sanitizePageContext(candidate)).toBeNull()
  })
  test('Only bounded, single-line title and short pathname may be saved', () => {
    for (const title of ['', '  ', ' Leading space', 'Trailing space ', 'A\nB', 'A\u0000B', 'x'.repeat(121)]) {
      expect(sanitizePageContext({ pathname: '/safe', title }), title).toBeNull()
    }
    expect(sanitizePageContext({ pathname: '/' + 'a'.repeat(241), title: 'Page' })).toBeNull()
    expect(sanitizePageContext({ pathname: '/ok', title: 'عنوان صفحه' })).toEqual({ pathname: '/ok', title: 'عنوان صفحه' })
  })
  test('Reject getters without executing them; do not accept symbols or unknown fields', () => {
    let invoked = false
    const accessor = { pathname: '/safe', get title() { invoked = true; throw Error('getter') } }
    expect(() => sanitizePageContext(accessor)).not.toThrow()
    expect(sanitizePageContext(accessor)).toBeNull()
    expect(invoked).toBe(false)
    expect(sanitizePageContext({ ...page, [Symbol('secret')]: 1 })).toBeNull()
  })
  test('Non-objects and nested/executable content are not a context snapshot', () => {
    for (const raw of [true, 2, 'page', [], {}, { pathname: '/safe', title: {} },
      { pathname: '/safe', title: ['bad'] }, { pathname: '/safe', title: '<script>alert(1)</script>' }])
      expect(sanitizePageContext(raw)).toBeNull()
  })
})
