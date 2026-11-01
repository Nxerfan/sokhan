/// <reference types="bun-types" />
/**
 * Reviewer-owned contract for Feature 5 — Message Preview.
 * The coding agent writes separate development tests and production code.
 * Do NOT weaken these tests, synthesize incoming messages in the browser,
 * or bypass access/identity checks.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validateMessagePreviewPatch, mergeMessagePreviewPatch,
} from '../../src/lib/widget/message-preview-patch'
import { resolveEffectiveMessagePreview } from '../../src/lib/widget/effective-message-preview'
import { getMessagePreviewText } from '../../src/lib/widget/message-preview-policy'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unknown_plan__')
const base = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 52, offsetY: -25 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -19, offsetY: 10 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const, paidShape: 'pill' as const },
  attention: { animation: 'pulse' as const, paidAnimation: 'glow' as const },
  messagePreview: { enabled: true },
}
const stored = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Message Preview — server-authoritative plan enforcement', () => {
  test('Free off, paid on, unknown fail closed', () => {
    expect(FREE?.messagePreview).toBe(false)
    for (const ent of [PRO, MAX, SELF]) expect(ent?.messagePreview).toBe(true)
    expect(UNKNOWN).toBeNull()
    expect(resolveEffectiveMessagePreview(stored(base), FREE)).toEqual({ enabled: false })
    expect(resolveEffectiveMessagePreview(stored(base), UNKNOWN)).toEqual({ enabled: false })
    for (const ent of [PRO, MAX, SELF])
      expect(resolveEffectiveMessagePreview(stored(base), ent)).toEqual({ enabled: true })
  })
  test('no stored V2 selection defaults OFF on every plan', () => {
    for (const ent of [FREE, PRO, UNKNOWN]) {
      expect(resolveEffectiveMessagePreview(stored(null), ent)).toEqual({ enabled: false })
      expect(resolveEffectiveMessagePreview(stored({ version: 1 }), ent)).toEqual({ enabled: false })
    }
  })
  test('Free cannot patch even false; Pro can explicitly enable or disable', () => {
    for (const enabled of [true, false]) {
      expect(validateMessagePreviewPatch({ messagePreview: { enabled } }, FREE))
        .toEqual({ ok: false, code: 'message_preview_not_allowed' })
      expect(validateMessagePreviewPatch({ messagePreview: { enabled } }, PRO))
        .toEqual({ ok: true, data: { enabled } })
      expect(validateMessagePreviewPatch({ messagePreview: { enabled } }, UNKNOWN).ok).toBe(false)
    }
  })
  test('forbid unknown or malformed patch fields and prototype tricks', () => {
    for (const messagePreview of [
      undefined, null, true, 'true', {}, [], { enabled: 'true' },
      { enabled: 1 }, { enabled: null }, { enabled: true, text: '<img>' },
      { enabled: true, plan: 'pro' }, { enabled: true, css: 'position:fixed' },
    ]) expect(validateMessagePreviewPatch({ messagePreview }, PRO).ok).toBe(false)
  })
  test('explicit false persists and is effective for paid plan', () => {
    const result = mergeMessagePreviewPatch(base, { enabled: false })
    expect(result.messagePreview).toEqual({ enabled: false })
    expect(resolveEffectiveMessagePreview(stored(result), PRO)).toEqual({ enabled: false })
  })
  test('downgrade preserves stored true without exposing it to Free', () => {
    expect(resolveEffectiveMessagePreview(stored(base), FREE).enabled).toBe(false)
    expect(resolveEffectiveMessagePreview(stored(base), PRO).enabled).toBe(true)
    const changed = mergeMessagePreviewPatch(base, { enabled: true })
    expect(changed.messagePreview).toEqual({ enabled: true })
  })
})

describe('Message Preview — V2 schema and true-patch security', () => {
  test('parse accepted V2 object with every previous feature', () => {
    expect(parseAppearanceV2(base)).toEqual(base)
  })
  test('reject unknown keys, numbers, strings, null and getters in storage', () => {
    const invalids: unknown[] = [
      { version: 1, messagePreview: { enabled: 'yes' } },
      { version: 1, messagePreview: { enabled: 1 } },
      { version: 1, messagePreview: [] },
      { version: 1, messagePreview: { enabled: true, message: 'secret' } },
      { version: 1, messagePreview: { get enabled() { throw Error('unsafe getter') } } },
    ]
    for (const v of invalids) expect(parseAppearanceV2(v)).toBeNull()
  })
  test('preview editing MUST preserve other paid fields and BOTH device positions', () => {
    const result = mergeMessagePreviewPatch(base, { enabled: false })
    expect(result.colors).toEqual(base.colors)
    expect(result.launcher).toEqual(base.launcher)
    expect(result.attention).toEqual(base.attention)
    expect(result.desktop).toEqual(base.desktop)
    expect(result.mobile).toEqual(base.mobile)
  })
  test('each previously approved V2 merge must preserve messagePreview', () => {
    expect(mergeColorPatch(base, { theme: { mode: 'preset', presetId: 'sunset' } }).messagePreview).toEqual(base.messagePreview)
    expect(mergeLauncherPatch(base, { shape: 'pill' }, PRO).messagePreview).toEqual(base.messagePreview)
    expect(mergeAttentionPatch(base, { animation: 'shake' }, PRO).messagePreview).toEqual(base.messagePreview)
    expect(mergePositioningPatch(base, {
      hasAny: true, mobile: { hasFields: true, anchor: 'bottom-end' },
    }, 'bottom-end').messagePreview).toEqual(base.messagePreview)
  })
  test('a full chained edit never silently erases preview or neighboring settings', () => {
    const a = mergeMessagePreviewPatch(base, { enabled: true })
    const b = mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } })
    const c = mergeAttentionPatch(b, { animation: 'bounce' }, PRO)
    const d = mergeLauncherPatch(c, { shape: 'rounded' }, PRO)
    expect(d.messagePreview).toEqual({ enabled: true })
    expect(d.colors?.presetId).toBe('sunset')
    expect(d.attention?.animation).toBe('bounce')
    expect(d.launcher?.shape).toBe('rounded')
    expect(d.desktop).toEqual(base.desktop)
    expect(d.mobile).toEqual(base.mobile)
  })
})

describe('Message Preview — pure incoming-message eligibility and privacy', () => {
  const message = { id: 'm-1', conversationId: 'conv-1', senderType: 'agent',
    contentType: 'text', content: { text: 'New agent reply' }, createdAt: '2026-11-01T08:00:00Z' }
  const opts = {
    enabled: true, panelOpen: false, authorized: true,
    conversationId: 'conv-1', source: 'live' as const, message, seenIds: [] as string[],
  }
  test('authorized new agent message while closed displays text', () => {
    expect(getMessagePreviewText(opts)).toBe('New agent reply')
  })
  test('disable, open panel, unauthorized, wrong conversation and duplicate must not leak', () => {
    expect(getMessagePreviewText({ ...opts, enabled: false })).toBeNull()
    expect(getMessagePreviewText({ ...opts, panelOpen: true })).toBeNull()
    expect(getMessagePreviewText({ ...opts, authorized: false })).toBeNull()
    expect(getMessagePreviewText({ ...opts, conversationId: null })).toBeNull()
    expect(getMessagePreviewText({ ...opts, conversationId: 'other' })).toBeNull()
    expect(getMessagePreviewText({ ...opts, seenIds: ['m-1'] })).toBeNull()
    expect(getMessagePreviewText({ ...opts, message: { ...message, conversationId: 'other' } })).toBeNull()
  })
  test('history, initial restore and optimistic POST never trigger a preview', () => {
    for (const source of ['history', 'post'] as const)
      expect(getMessagePreviewText({ ...opts, source })).toBeNull()
    expect(getMessagePreviewText({ ...opts, source: 'poll' })).toBe('New agent reply')
  })
  test('visitor, AI, system, attachment and non-text events never preview', () => {
    for (const senderType of ['contact', 'ai', 'system', 'visitor']) {
      expect(getMessagePreviewText({ ...opts, message: { ...message, senderType } })).toBeNull()
    }
    expect(getMessagePreviewText({ ...opts, message: { ...message, contentType: 'image' } })).toBeNull()
    expect(getMessagePreviewText({ ...opts, message: { ...message, content: { text: '' } } })).toBeNull()
  })
  test('text is capped at 120 Unicode characters; no invisible control content', () => {
    const long = 'الف'.repeat(150)
    const preview = getMessagePreviewText({ ...opts, message: { ...message, content: { text: long } } })
    expect(preview).not.toBeNull()
    expect(Array.from(preview!).length).toBeLessThanOrEqual(121)
    expect(preview!.startsWith('الف'.repeat(100))).toBe(true)
    expect(getMessagePreviewText({ ...opts, message: { ...message, content: { text: ' \n   ' } } })).toBeNull()
  })
  test('untrusted text returned as plain content, not rendered HTML', () => {
    const raw = '<img src=x onerror=alert(1)>'
    expect(getMessagePreviewText({ ...opts, message: { ...message, content: { text: raw } } })).toBe(raw)
  })
})
