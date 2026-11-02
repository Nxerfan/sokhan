/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 11 — Context Chat (BETA).
 *
 * Covers:
 *   - Entitlements (Free fail-closed, Pro/Max/Self-hosted allowed).
 *   - Default-off behavior for every existing tenant (no stored config).
 *   - Strict parsing + accessor safety (no getter execution, no Symbol keys).
 *   - Downgrade/upgrade preference restoration.
 *   - Invalid PATCH rejection (both toggles on Free, malformed shapes).
 *   - Page title/pathname sanitization (bounds, single-line, plain text).
 *   - Query/hash/control-character/percent-encoded-injection rejection.
 *   - Free forged-payload suppression at the server boundary
 *     (acceptPageContext with server-resolved effective disabled).
 *   - Authorized paid message persistence (server boundary acceptance).
 *   - No automatic context attachment (undefined/null → null).
 *   - One-shot consumption / failed-send retry / SPA navigation invalidation /
 *     "no location.href" capture contract in all three widget runtimes.
 *   - Pure TS === slug script === v1 script === NPM widget validator parity.
 *   - Agent-facing display safe-text contract (no innerHTML, plain JSX text).
 *   - Cross-feature true-patch preservation (both directions).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  isValidContextChatConfig,
  sanitizePageContext,
  acceptPageContext,
  PAGE_CONTEXT_PATHNAME_MAX,
  PAGE_CONTEXT_TITLE_MAX_CODEPOINTS,
} from '../../src/lib/widget/context-chat-types'
import {
  validateContextChatPatch, mergeContextChatPatch,
} from '../../src/lib/widget/context-chat-patch'
import { resolveEffectiveContextChat, getStoredContextChat } from '../../src/lib/widget/effective-context-chat'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'
import { mergeSmartAvoidancePatch } from '../../src/lib/widget/smart-avoidance-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePreChatFormPatch } from '../../src/lib/widget/pre-chat-form-patch'
import { mergePageVisibilityPatch } from '../../src/lib/widget/page-visibility-patch'
import { mergeAlternativeContactButtonsPatch } from '../../src/lib/widget/alternative-contact-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'
import { buildScript as buildSlugScript } from '../../src/app/api/widget/[slug]/script/route'
import { buildScript as buildV1Script } from '../../src/app/api/widget/v1/sukhan.js/route'
import { SukhanWidget } from '../../packages/widget-npm/src/widget'

const FREE = getEntitlements('free')!
const PRO = getEntitlements('pro')!
const MAX = getEntitlements('max')!
const SELF = getEntitlements('self-hosted')!
const UNKNOWN = getEntitlements('__unknown__')
const stored = (enabled: boolean) => ({ version: 1 as const, desktop: {}, mobile: {}, contextChat: { enabled } })
const page = { pathname: '/products/example', title: 'Example product' }
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Developer — entitlements and defaults', () => {
  test('Free false, Pro/Max/Self true, unknown null', () => {
    expect(FREE.contextChat).toBe(false)
    for (const e of [PRO, MAX, SELF]) expect(e.contextChat).toBe(true)
    expect(UNKNOWN).toBeNull()
  })
  test('Default off for every existing tenant (no stored config)', () => {
    expect(resolveEffectiveContextChat(input(null), PRO)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(undefined), PRO)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input({}), PRO)).toEqual({ enabled: false })
    expect(getStoredContextChat(input(null))).toBeNull()
  })
  test('Legacy V2 config without contextChat defaults off even on paid', () => {
    expect(resolveEffectiveContextChat(input({ version: 1, desktop: {}, mobile: {} }), PRO)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input({ version: 1, smartAvoidance: { enabled: true } }), PRO)).toEqual({ enabled: false })
  })
  test('Stored true + Free → false (fail closed)', () => {
    expect(resolveEffectiveContextChat(input(stored(true)), FREE)).toEqual({ enabled: false })
  })
  test('Stored true + Pro/Max/Self → true', () => {
    expect(resolveEffectiveContextChat(input(stored(true)), PRO)).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(stored(true)), MAX)).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(stored(true)), SELF)).toEqual({ enabled: true })
  })
  test('Stored false + Pro → false', () => {
    expect(resolveEffectiveContextChat(input(stored(false)), PRO)).toEqual({ enabled: false })
  })
  test('Unknown plan / null entitlements → false', () => {
    expect(resolveEffectiveContextChat(input(stored(true)), UNKNOWN)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(stored(true)), null)).toEqual({ enabled: false })
  })
  test('Malformed stored appearanceV2 fails closed (resolver returns false)', () => {
    for (const bad of [true, 2, 'yes', [], { version: 2, contextChat: { enabled: true } }, { version: 1, contextChat: { enabled: 'true' } }]) {
      expect(resolveEffectiveContextChat(input(bad), PRO)).toEqual({ enabled: false })
    }
  })
})

describe('Developer — downgrade and upgrade restoration', () => {
  test('Paid enable → downgrade off → upgrade restores the stored preference', () => {
    const saved = mergeContextChatPatch({ version: 1 }, { enabled: true }, PRO)
    expect(saved.contextChat).toEqual({ enabled: true })
    expect(getStoredContextChat(input(saved))).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(saved), PRO)).toEqual({ enabled: true })
    // Downgrade: effective false, stored preference retained.
    expect(resolveEffectiveContextChat(input(saved), FREE)).toEqual({ enabled: false })
    expect(getStoredContextChat(input(saved))).toEqual({ enabled: true })
    // Upgrade again: the paid preference is restored without a re-write.
    expect(resolveEffectiveContextChat(input(saved), MAX)).toEqual({ enabled: true })
    expect(resolveEffectiveContextChat(input(saved), SELF)).toEqual({ enabled: true })
  })
  test('Explicit off stays off across the same cycle', () => {
    const off = mergeContextChatPatch({ version: 1 }, { enabled: false }, PRO)
    expect(resolveEffectiveContextChat(input(off), PRO)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(off), FREE)).toEqual({ enabled: false })
    expect(resolveEffectiveContextChat(input(off), PRO)).toEqual({ enabled: false })
  })
})

describe('Developer — PATCH validation', () => {
  test('Free rejects BOTH true and false toggles', () => {
    for (const enabled of [true, false]) {
      const r = validateContextChatPatch({ contextChat: { enabled } }, FREE)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('context_chat_not_allowed')
    }
  })
  test('Unknown plan / null entitlements rejected as not authorized', () => {
    expect(validateContextChatPatch({ contextChat: { enabled: true } }, UNKNOWN).ok).toBe(false)
    const r = validateContextChatPatch({ contextChat: { enabled: true } }, null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('context_chat_not_authorized')
  })
  test('Pro/Max/Self accept both toggles', () => {
    for (const enabled of [true, false]) {
      for (const e of [PRO, MAX, SELF]) {
        const r = validateContextChatPatch({ contextChat: { enabled } }, e)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.data).toEqual({ enabled })
      }
    }
  })
  test('Malformed shapes rejected without executing getters', () => {
    let invoked = false
    const accessor = { get enabled() { invoked = true; throw Error('must not execute') } }
    for (const val of [null, [], true, 'true', {}, { enabled: 1 }, { enabled: 'true' },
      { enabled: null }, { enabled: undefined }, { enabled: true, plan: 'pro' },
      { enabled: true, scrapeDOM: true }, { enabled: true, script: 'alert(1)' }, accessor]) {
      expect(() => validateContextChatPatch({ contextChat: val }, PRO)).not.toThrow()
      const r = validateContextChatPatch({ contextChat: val }, PRO)
      expect(r.ok).toBe(false)
    }
    expect(invoked).toBe(false)
  })
  test('Symbol keys rejected', () => {
    const evil: Record<PropertyKey, unknown> = { enabled: true }
    evil[Symbol('x')] = 1
    expect(validateContextChatPatch({ contextChat: evil }, PRO).ok).toBe(false)
  })
  test('Missing contextChat field is a no-fields error (not a crash)', () => {
    const r = validateContextChatPatch({}, PRO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('context_chat_no_fields')
  })
})

describe('Developer — strict appearance parsing', () => {
  test('parseAppearanceV2 accepts + canonicalizes contextChat', () => {
    expect(parseAppearanceV2(stored(true))?.contextChat).toEqual({ enabled: true })
    expect(parseAppearanceV2(stored(false))?.contextChat).toEqual({ enabled: false })
  })
  test('parseAppearanceV2 rejects malformed contextChat (whole config fails closed)', () => {
    for (const config of [null, [], {}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, extra: 1 }]) {
      expect(parseAppearanceV2({ version: 1, contextChat: config })).toBeNull()
    }
  })
  test('isValidContextChatConfig accepts exact boolean shape only', () => {
    expect(isValidContextChatConfig({ enabled: true })).toBe(true)
    expect(isValidContextChatConfig({ enabled: false })).toBe(true)
    for (const bad of [null, undefined, true, 'x', [], { enabled: 'true' }, { enabled: 1 }, { enabled: true, extra: 1 }]) {
      expect(isValidContextChatConfig(bad)).toBe(false)
    }
  })
  test('isValidContextChatConfig rejects accessors without executing the getter', () => {
    let invoked = false
    const accessor = { get enabled() { invoked = true; return true } }
    expect(isValidContextChatConfig(accessor)).toBe(false)
    expect(invoked).toBe(false)
  })
})

describe('Developer — page-context sanitization', () => {
  test('Valid plain page contexts round-trip exactly', () => {
    expect(sanitizePageContext(page)).toEqual(page)
    expect(sanitizePageContext({ pathname: '/', title: 'Home' })).toEqual({ pathname: '/', title: 'Home' })
    // Internationalized (Persian) path + title.
    expect(sanitizePageContext({ pathname: '/محصولات/گوشی', title: 'عنوان صفحه' }))
      .toEqual({ pathname: '/محصولات/گوشی', title: 'عنوان صفحه' })
    // Percent-encoded internationalized path (what location.pathname returns).
    expect(sanitizePageContext({ pathname: '/products/%D9%85%D8%AD%D8%B5%D9%88%D9%84', title: 'Product' }))
      .toEqual({ pathname: '/products/%D9%85%D8%AD%D8%B5%D9%88%D9%84', title: 'Product' })
    // Boundary lengths: exactly 240 pathname chars / 120 title code points.
    expect(sanitizePageContext({ pathname: '/' + 'a'.repeat(PAGE_CONTEXT_PATHNAME_MAX - 1), title: 'Page' })).not.toBeNull()
    expect(sanitizePageContext({ pathname: '/ok', title: 'x'.repeat(PAGE_CONTEXT_TITLE_MAX_CODEPOINTS) })).not.toBeNull()
    // Astral title: surrogate pairs count as ONE code point.
    expect(sanitizePageContext({ pathname: '/ok', title: '😀'.repeat(120) })).not.toBeNull()
  })
  test('Canonical copy — the returned object is never the raw input reference', () => {
    const raw = { ...page }
    const out = sanitizePageContext(raw)!
    expect(out).not.toBe(raw)
    expect(out).toEqual(page)
  })
  test('Title bounds + single-line + plain-text strictness', () => {
    for (const title of ['', '  ', ' Leading', 'Trailing ', 'A\nB', 'A\rB', 'A\u0000B',
      'A\u007FB', 'A\u009FB', 'A\u2028B', 'A\u2029B', 'x'.repeat(121),
      '<script>alert(1)</script>', '5 < 10', 'a<b>', '\u0639\u0646\u0648\u0627\u0646\tبا تَب']) {
      expect(sanitizePageContext({ pathname: '/safe', title }), JSON.stringify(title)).toBeNull()
    }
  })
  test('Pathname rejects absolute/protocol-relative/query/fragment/backslash/control', () => {
    for (const pathname of [
      'products/example', '//attacker.example/path', 'https://host.example/secret',
      'javascript:alert(1)', '/checkout?token=SECRET', '/product#fragment',
      '/\\evil', '/x\nInjected', '/x\rInjected', '/x\u0000Injected', '/x\u007FInjected',
      '/%0D%0Aevil', '/%00', '/products/%3Fsecret', '/products/%23fragment', '/p/%5Cevil',
      '/path with space', '/' + 'a'.repeat(PAGE_CONTEXT_PATHNAME_MAX),
    ]) {
      expect(sanitizePageContext({ pathname, title: 'Page' }), JSON.stringify(pathname)).toBeNull()
    }
  })
  test('Pathname rejects raw tab and malformed percent-encoding', () => {
    expect(sanitizePageContext({ pathname: '/x\tInjected', title: 'Page' })).toBeNull()
    // A bare '%' not followed by two hex digits fails closed.
    expect(sanitizePageContext({ pathname: '/100%-off', title: 'Page' })).toBeNull()
  })
  test('Rejects unknown keys — DOM, forms, credentials, full URL, storage', () => {
    for (const extra of ['html', 'search', 'hash', 'origin', 'cookies', 'fullUrl', 'href',
      'localStorage', 'sessionStorage', 'credentials', 'forms', 'dom', 'textContent'] as const) {
      expect(sanitizePageContext({ ...page, [extra]: 'x' })).toBeNull()
    }
  })
  test('Rejects missing keys + non-plain objects', () => {
    for (const raw of [undefined, null, true, 2, 'page', [], {}, { pathname: '/safe' }, { title: 'Page' },
      { pathname: '/safe', title: {} }, { pathname: '/safe', title: [] },
      { pathname: '/safe', title: 5 }, { pathname: 7, title: 'Page' }]) {
      expect(sanitizePageContext(raw), JSON.stringify(raw)).toBeNull()
    }
  })
  test('Rejects getters without executing them; Symbol keys rejected', () => {
    let invoked = false
    const accessor = { pathname: '/safe', get title() { invoked = true; throw Error('getter') } }
    expect(() => sanitizePageContext(accessor)).not.toThrow()
    expect(sanitizePageContext(accessor)).toBeNull()
    expect(invoked).toBe(false)
    const sym: Record<PropertyKey, unknown> = { ...page }
    sym[Symbol('secret')] = 1
    expect(sanitizePageContext(sym)).toBeNull()
  })
  test('Class instances / Map / Date are not plain objects', () => {
    expect(sanitizePageContext(new (class { pathname = '/safe'; title = 'P' })())).toBeNull()
    expect(sanitizePageContext(new Map())).toBeNull()
    expect(sanitizePageContext(new Date())).toBeNull()
  })
})

describe('Developer — server-boundary acceptance (forged payload suppression)', () => {
  test('Effective disabled → ANY supplied context is dropped (Free forged payload)', () => {
    for (const enabled of [false]) {
      expect(acceptPageContext(page, enabled)).toBeNull()
      expect(acceptPageContext({ ...page, evil: 1 }, enabled)).toBeNull()
      expect(acceptPageContext({ pathname: '/x?session=SECRET#frag', title: 'T' }, enabled)).toBeNull()
    }
  })
  test('Effective enabled + valid context → accepted (authorized paid persistence)', () => {
    expect(acceptPageContext(page, true)).toEqual(page)
    expect(acceptPageContext({ pathname: '/محصولات', title: 'عنوان' }, true))
      .toEqual({ pathname: '/محصولات', title: 'عنوان' })
  })
  test('No explicit context with the send → null (no automatic attachment)', () => {
    expect(acceptPageContext(undefined, true)).toBeNull()
    expect(acceptPageContext(null, true)).toBeNull()
    expect(acceptPageContext(undefined, false)).toBeNull()
  })
  test('Effective enabled + malformed context → null (never persisted)', () => {
    for (const raw of [{}, [], true, { pathname: '/safe' }, { ...page, cookies: 'x' },
      { pathname: '//evil', title: 'T' }, { pathname: '/safe', title: 'A\nB' }]) {
      expect(acceptPageContext(raw, true), JSON.stringify(raw)).toBeNull()
    }
  })
  test('The messages route resolves the effective config server-side and passes it to acceptPageContext', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')
    expect(route).toContain('resolveEffectiveContextChat(')
    expect(route).toContain('acceptPageContext(body.pageContext, effectiveContextChat.enabled)')
    // Server-authoritative: the effective config comes from the tenant row +
    // its widgetConfig — never from client-controlled body fields.
    expect(route).toContain('getEntitlements(tokenTenant.plan)')
    expect(route).toContain("tokenTenant.widgetConfig?.appearanceV2")
    // Persistence keeps the plain { text } shape for ordinary messages.
    expect(route).toContain(': { text },')
    // Context is NEVER attached to the AI response content.
    expect(route).not.toContain('content: { text: aiResponse!.text, source: aiResponse!.source, pageContext')
  })
})

describe('Developer — cross-feature true-patch preservation', () => {
  const neighbors = {
    version: 1 as const,
    desktop: { positioning: { anchor: 'bottom-start' as const, offsetX: 4, offsetY: 5 } },
    mobile: {},
    colors: { mode: 'preset' as const, presetId: 'emerald' },
    launcher: { shape: 'pill' as const },
    attention: { animation: 'glow' as const },
    messagePreview: { enabled: true },
    quickReplies: { items: ['Hi', 'Help'] },
    preChatForm: { fields: [{ key: 'name' as const, required: true }] },
    pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact' as const, action: 'hide' as const }] },
    alternativeContactButtons: { items: [{ kind: 'email' as const, label: 'Email', value: 'hi@example.com' }] },
    smartAvoidance: { enabled: true },
  }

  test('Context Chat edit preserves ALL prior V2 neighbors', () => {
    const saved = mergeContextChatPatch(neighbors, { enabled: true }, PRO)
    for (const key of ['desktop', 'mobile', 'colors', 'launcher', 'attention', 'messagePreview',
      'quickReplies', 'preChatForm', 'pageVisibility', 'alternativeContactButtons', 'smartAvoidance'] as const) {
      expect(saved[key], key).toEqual(neighbors[key])
    }
    expect(saved.contextChat).toEqual({ enabled: true })
  })

  test('Every sibling merge preserves contextChat (both directions)', () => {
    const before = mergeContextChatPatch(neighbors, { enabled: true }, PRO)
    expect(mergeColorPatch(before, { theme: { mode: 'preset', presetId: 'emerald' } }).contextChat).toEqual({ enabled: true })
    expect(mergeLauncherPatch(before, { shape: 'tab' }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergeAttentionPatch(before, { animation: 'pulse' }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergeMessagePreviewPatch(before, { enabled: false }).contextChat).toEqual({ enabled: true })
    expect(mergeQuickRepliesPatch(before, { items: ['Hello'] }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergePreChatFormPatch(before, { fields: [] }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergePageVisibilityPatch(before, { rules: [] }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergeAlternativeContactButtonsPatch(before, { items: [] }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergeSmartAvoidancePatch(before, { enabled: false }, PRO).contextChat).toEqual({ enabled: true })
    expect(mergePositioningPatch(before, { hasAny: true, desktop: { hasFields: true, anchor: 'bottom-end' } }, 'bottom-end').contextChat)
      .toEqual({ enabled: true })
  })
})

// ─── Widget runtime source contracts (slug / v1 / NPM) ─────────────────────

const slugJs = buildSlugScript('https://app.sukhan.chat', 'demo', false, '/?XTransformPort=3003', false)
const v1Js = buildV1Script(null, false)

/**
 * Extract a self-contained function from a generated runtime script by brace
 * matching and evaluate it. The context-chat validators contain no braces
 * inside string literals, so plain brace counting is safe.
 */
function extractRuntimeFn<T>(js: string, marker: string, label: string): T {
  const start = js.indexOf(marker)
  if (start < 0) throw new Error(`[ ${label} ] function missing from generated script: ${marker}`)
  let depth = 0
  let i = start
  let seenOpen = false
  for (; i < js.length; i++) {
    if (js[i] === '{') { depth++; seenOpen = true }
    else if (js[i] === '}') {
      depth--
      if (seenOpen && depth === 0) break
    }
  }
  if (!(seenOpen && depth === 0)) throw new Error(`[ ${label} ] unbalanced braces around: ${marker}`)
  const src = js.slice(start, i + 1)
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src + ')')() as T
}

type ValidPathnameFn = (pathname: unknown) => boolean
type ValidTitleFn = (title: unknown) => boolean

const slugValidPathname = extractRuntimeFn<ValidPathnameFn>(slugJs, 'function __skContextChatValidPathname(', 'slug script')
const slugValidTitle = extractRuntimeFn<ValidTitleFn>(slugJs, 'function __skContextChatValidTitle(', 'slug script')
const v1ValidPathname = extractRuntimeFn<ValidPathnameFn>(v1Js, 'function __skContextChatValidPathname(', 'v1 script')
const v1ValidTitle = extractRuntimeFn<ValidTitleFn>(v1Js, 'function __skContextChatValidTitle(', 'v1 script')
// The NPM methods are private in TS but present on the prototype at runtime;
// both are pure functions (never use `this`), so they can be invoked directly.
const npmValidPathname = (SukhanWidget.prototype as unknown as Record<string, ValidPathnameFn>).contextChatValidPathname
const npmValidTitle = (SukhanWidget.prototype as unknown as Record<string, ValidTitleFn>).contextChatValidTitle

describe('Developer — runtime validator parity: pure TS === slug === v1 === NPM', () => {
  const pathnames: Array<[string, boolean]> = [
    ['/products/example', true],
    ['/', true],
    ['/محصولات/گوشی', true],
    ['/products/%D9%85%D8%AD%D8%B5%D9%88%D9%84', true],
    ['/products/100%25-off', true],
    ['/' + 'a'.repeat(240), false],
    ['/' + 'a'.repeat(239), true],
    ['/products/example?session=SECRET', false],
    ['/products/example#fragment', false],
    ['//attacker.example/path', false],
    ['https://host.example/secret', false],
    ['javascript:alert(1)', false],
    ['/\\evil', false],
    ['/x\nInjected', false],
    ['/x\rInjected', false],
    ['/x\u0000Injected', false],
    ['/x\u007FInjected', false],
    ['/%0D%0Aevil', false],
    ['/%00', false],
    ['/products/%3Fsecret', false],
    ['/products/%23fragment', false],
    ['/p/%5Cevil', false],
    ['/path with space', false],
    ['/x\tInjected', false],
    ['/100%-off', false],
    ['products/example', false],
    ['', false],
  ]
  const titles: Array<[string, boolean]> = [
    ['Example product', true],
    ['عنوان صفحه', true],
    ['😀'.repeat(120), true],
    ['x'.repeat(120), true],
    ['x'.repeat(121), false],
    ['', false],
    ['  ', false],
    [' Leading', false],
    ['Trailing ', false],
    ['A\nB', false],
    ['A\rB', false],
    ['A\u0000B', false],
    ['A\u007FB', false],
    ['A\u009FB', false],
    ['A\u2028B', false],
    ['A\u2029B', false],
    ['<script>alert(1)</script>', false],
    ['5 < 10', false],
  ]

  test('pathname accept/reject decisions are identical across all four runtimes', () => {
    for (const [pathname, expected] of pathnames) {
      const viaPure = sanitizePageContext({ pathname, title: 'Page' }) !== null
      expect(viaPure, `pure: ${JSON.stringify(pathname)}`).toBe(expected)
      expect(slugValidPathname(pathname), `slug: ${JSON.stringify(pathname)}`).toBe(expected)
      expect(v1ValidPathname(pathname), `v1: ${JSON.stringify(pathname)}`).toBe(expected)
      expect(npmValidPathname(pathname), `npm: ${JSON.stringify(pathname)}`).toBe(expected)
    }
  })
  test('title accept/reject decisions are identical across all four runtimes', () => {
    for (const [title, expected] of titles) {
      const viaPure = sanitizePageContext({ pathname: '/safe', title }) !== null
      expect(viaPure, `pure: ${JSON.stringify(title)}`).toBe(expected)
      expect(slugValidTitle(title), `slug: ${JSON.stringify(title)}`).toBe(expected)
      expect(v1ValidTitle(title), `v1: ${JSON.stringify(title)}`).toBe(expected)
      expect(npmValidTitle(title), `npm: ${JSON.stringify(title)}`).toBe(expected)
    }
  })
  test('non-string inputs fail closed in every runtime validator', () => {
    for (const bad of [undefined, null, 5, {}, [], true]) {
      expect(slugValidPathname(bad)).toBe(false)
      expect(v1ValidPathname(bad)).toBe(false)
      expect(npmValidPathname(bad)).toBe(false)
      expect(slugValidTitle(bad)).toBe(false)
      expect(v1ValidTitle(bad)).toBe(false)
      expect(npmValidTitle(bad)).toBe(false)
    }
  })
})

describe('Developer — slug + v1 runtime wiring contracts', () => {
  // The Context Chat section of a generated script spans the validators
  // through the row visibility helper — the full URL / href / query / hash /
  // cookies / storage are NEVER read within it. (Pre-existing identity/login
  // flows elsewhere in the script legitimately reference location.href.)
  function contextChatSection(js: string): string {
    const start = js.indexOf('function __skContextChatValidPathname(')
    const end = js.indexOf('function updateContextChatRow(')
    return start >= 0 && end > start ? js.slice(start, end) : ''
  }
  for (const [label, js] of [['slug script', slugJs], ['v1 script', v1Js]] as const) {
    test(`${label}: required visitor test ids + capture source`, () => {
      expect(js).toContain("setAttribute('data-testid', 'context-chat-share')")
      expect(js).toContain("setAttribute('data-testid', 'context-chat-indicator')")
      expect(js).toContain("setAttribute('data-testid', 'context-chat-clear')")
      // Capture reads ONLY location.pathname + document.title (never the
      // full URL / query / hash) — scoped to the Context Chat section.
      expect(js).toContain('window.location.pathname')
      expect(js).toContain('document.title')
      const section = contextChatSection(js)
      expect(section.length).toBeGreaterThan(0)
      expect(section).not.toContain('.href')
      expect(section).not.toContain('location.search')
      expect(section).not.toContain('location.hash')
      expect(section).not.toContain('cookie')
      expect(section).not.toContain('localStorage')
      expect(section).not.toContain('sessionStorage')
    })
    test(`${label}: feature is config-gated (no share control when disabled)`, () => {
      expect(js).toContain('state.contextChatEnabled = !!(config.contextChat && config.contextChat.enabled);')
      expect(js).toContain('if (state.contextChatEnabled) {')
    })
    test(`${label}: one-shot consumption with in-flight identity guard`, () => {
      expect(js).toContain('state.contextChatPending === sendPageContext')
      expect(js).toContain('clearContextChatPending();')
    })
    test(`${label}: SPA navigation invalidates a stale pending attachment`, () => {
      expect(js).toContain('window.location.pathname !== state.contextChatPending.pathname')
    })
    test(`${label}: context is attached ONLY from the explicit pending opt-in`, () => {
      // The send body gets pageContext exclusively via the pending attachment.
      expect(js).toContain('var sendPageContext = state.contextChatEnabled ? state.contextChatPending : null;')
      expect(js).toContain('if (sendPageContext) sendBody.pageContext = sendPageContext;')
    })
    test(`${label}: rendered via textContent (never innerHTML) for the context chip`, () => {
      expect(js).toContain(".sk-context-chat-title')")
      expect(js).toContain('t.textContent = state.contextChatPending.title')
      expect(js).toContain('p.textContent = state.contextChatPending.pathname')
    })
  }
})

describe('Developer — NPM runtime wiring contracts', () => {
  const npmSrc = readFileSync(join(process.cwd(), 'packages/widget-npm/src/widget.ts'), 'utf8')
  // The Context Chat section spans the validator methods through the row
  // visibility helper — the full URL / href is NEVER read within it (the
  // pre-existing login returnUrl flow elsewhere is unrelated).
  const ccStart = npmSrc.indexOf('private contextChatValidPathname(')
  const ccEnd = npmSrc.indexOf('private updateContextChatRow(')
  const ccSection = ccStart >= 0 && ccEnd > ccStart ? npmSrc.slice(ccStart, ccEnd) : ''
  test('required visitor test ids + capture source (no full-URL capture)', () => {
    expect(ccSection.length).toBeGreaterThan(0)
    expect(npmSrc).toContain("setAttribute('data-testid', 'context-chat-share')")
    expect(npmSrc).toContain("setAttribute('data-testid', 'context-chat-indicator')")
    expect(npmSrc).toContain("setAttribute('data-testid', 'context-chat-clear')")
    expect(npmSrc).toContain('window.location.pathname')
    expect(npmSrc).toContain('document.title')
    expect(ccSection).not.toContain('.href')
    expect(ccSection).not.toContain('location.search')
    expect(ccSection).not.toContain('location.hash')
    expect(ccSection).not.toContain('cookie')
    expect(ccSection).not.toContain('localStorage')
    expect(ccSection).not.toContain('sessionStorage')
  })
  test('one-shot consumption + failed-send preservation + SPA invalidation', () => {
    expect(npmSrc).toContain('sendPageContext === this.state.contextChatPending')
    expect(npmSrc).toContain('this.clearContextChatPending()')
    expect(npmSrc).toContain("window.location.pathname !== this.state.contextChatPending.pathname")
  })
  test('NPM public send() exposes the optional per-message pageContext argument', () => {
    expect(npmSrc).toContain('send(text: string, pageContext?: PageContext): Promise<void>')
    const typesSrc = readFileSync(join(process.cwd(), 'packages/widget-npm/src/types.ts'), 'utf8')
    expect(typesSrc).toContain('send(text: string, pageContext?: PageContext): Promise<void>')
    expect(typesSrc).toContain('export interface PageContext {')
    expect(typesSrc).toContain('pageContext?: PageContext')
  })
  test('NPM ApiClient.sendMessage carries the optional pageContext', () => {
    const apiSrc = readFileSync(join(process.cwd(), 'packages/widget-npm/src/api.ts'), 'utf8')
    expect(apiSrc).toContain('async sendMessage(token: string, text: string, pageContext?: PageContext)')
    expect(apiSrc).toContain('if (pageContext) body.pageContext = pageContext')
  })
  test('identity switch never carries the previous visitor\'s pending attachment', () => {
    expect(npmSrc).toContain('this.state.contextChatPending = null\n    this.renderContextChatIndicator()')
  })
})

describe('Developer — agent-facing display safe-text contract', () => {
  const inboxSrc = readFileSync(join(process.cwd(), 'src/components/dashboard/views/inbox-view.tsx'), 'utf8')
  test('visitor pageContext renders as plain text with a clear label', () => {
    expect(inboxSrc).toContain('pageContext')
    expect(inboxSrc).toContain("{pageContext.title}")
    expect(inboxSrc).toContain("{pageContext.pathname}")
    expect(inboxSrc).toContain("t('sharedPageLabel')")
  })
  test('never raw-HTML injection / link rendering for the context', () => {
    expect(inboxSrc).not.toContain('dangerouslySetInnerHTML')
    expect(inboxSrc).not.toContain('innerHTML')
    // The context values are never turned into anchors.
    expect(inboxSrc).not.toContain('href={pageContext')
    // Not rendered for the agent's own messages (own-bubble exclusion).
    expect(inboxSrc).toContain('!isOwn && !isSystem')
  })
  test('bilingual agent label exists in both message catalogs', () => {
    for (const loc of ['en', 'fa']) {
      const messages = JSON.parse(readFileSync(join(process.cwd(), `src/messages/${loc}.json`), 'utf8'))
      expect(typeof messages.dashboard.sharedPageLabel).toBe('string')
      expect(messages.dashboard.sharedPageLabel.length).toBeGreaterThan(0)
      expect(typeof messages.settings.contextChat.title).toBe('string')
      expect(typeof messages.settings.contextChat.privacy).toBe('string')
    }
  })
})

describe('Developer — dashboard + public config wiring', () => {
  test('dashboard GET exposes entitlements/effective/stored for contextChat', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/widget-config/route.ts'), 'utf8')
    expect(src).toContain('resolveEffectiveContextChat')
    expect(src).toContain('getStoredContextChat')
    expect(src).toContain('contextChat: {')
    expect(src).toContain("entitlements: { enabled: entitlements?.contextChat ?? false }")
    expect(src).toContain('CONTEXT_CHAT_ERROR_STATUS')
    expect(src).toContain("context_chat_not_allowed: 403")
  })
  test('dashboard PATCH validates + merges contextChat with sibling preservation', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/widget-config/route.ts'), 'utf8')
    expect(src).toContain('validateContextChatPatch({ contextChat: body.contextChat }, entitlements)')
    expect(src).toContain('mergeContextChatPatch(baseAppearanceV2, contextChatPatch, entitlements)')
    expect(src).toContain('hasContextChatField(body)')
  })
  test('public widget config exposes ONLY the effective { enabled } state', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/config/route.ts'), 'utf8')
    expect(src).toContain('resolveEffectiveContextChat(contextChatInput, entitlements)')
    expect(src).toContain('responseBody.contextChat = effectiveContextChat')
    // The public route never references the stored preference getter.
    expect(src).not.toContain('getStoredContextChat')
  })
  test('contextChat is a recognized PATCH key (not rejected as unrecognized)', () => {
    const patchSrc = readFileSync(join(process.cwd(), 'src/lib/widget/positioning-patch.ts'), 'utf8')
    expect(patchSrc).toContain("'smartAvoidance', 'contextChat',")
  })
  test('appearance-v2 canonical parser accepts the additive contextChat key', () => {
    expect(parseAppearanceV2({ version: 1, contextChat: { enabled: true } })?.contextChat).toEqual({ enabled: true })
    // Unknown keys that are NOT contextChat still fail closed.
    expect(parseAppearanceV2({ version: 1, nope: 1 })).toBeNull()
  })
})
