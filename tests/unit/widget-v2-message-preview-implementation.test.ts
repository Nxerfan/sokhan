/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 5 — Message Preview.
 *
 * These tests exercise the REAL production modules with additional edge cases
 * that complement (not duplicate) the reviewer-owned contract. They cover:
 *   - Text normalization + truncation with ASCII, emoji, and mixed scripts.
 *   - Multi-message dedup sequences (first, second, duplicate).
 *   - State transitions (closed → preview → open → closed → re-eligible).
 *   - Dismiss vs open distinction.
 *   - Realtime/poll/history/post source boundaries.
 *   - Stale-async safety (seenIds survives across batches).
 *   - Default disabled behavior for all plans.
 *   - Cross-feature preservation in mergeMessagePreviewPatch.
 *   - Downgrade/upgrade semantics for resolveEffectiveMessagePreview.
 *   - Strict parseAppearanceV2 rejection of malformed messagePreview.
 */
import { describe, test, expect } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validateMessagePreviewPatch, mergeMessagePreviewPatch,
} from '../../src/lib/widget/message-preview-patch'
import { resolveEffectiveMessagePreview } from '../../src/lib/widget/effective-message-preview'
import {
  getMessagePreviewText, PREVIEW_MAX_CODE_POINTS,
  type MessagePreviewOptions,
} from '../../src/lib/widget/message-preview-policy'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unknown_plan__')

const agentMsg = (id: string, text: string, conversationId = 'conv-1') => ({
  id, conversationId, senderType: 'agent', contentType: 'text',
  content: { text }, createdAt: '2026-11-01T08:00:00Z',
})

const baseOpts = (overrides: Partial<MessagePreviewOptions> = {}): MessagePreviewOptions => ({
  enabled: true, panelOpen: false, authorized: true,
  conversationId: 'conv-1', source: 'live',
  message: agentMsg('m-1', 'Hello'), seenIds: [],
  ...overrides,
})

describe('Developer — text normalization and truncation', () => {
  test('ASCII text under the cap is returned verbatim', () => {
    const text = 'A'.repeat(100)
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m', text) }))).toBe(text)
  })

  test('ASCII text over the cap is truncated to 120 + ellipsis', () => {
    const text = 'A'.repeat(200)
    const result = getMessagePreviewText(baseOpts({ message: agentMsg('m', text) }))
    expect(result).not.toBeNull()
    expect(result!.length).toBe(121) // 120 chars + 1 ellipsis
    expect(result!.startsWith('A'.repeat(120))).toBe(true)
    expect(result!.endsWith('\u2026')).toBe(true)
  })

  test('exactly 120 code points is NOT truncated (no ellipsis)', () => {
    const text = 'A'.repeat(120)
    const result = getMessagePreviewText(baseOpts({ message: agentMsg('m', text) }))
    expect(result).toBe(text)
  })

  test('emoji are counted as single code points', () => {
    // Each emoji is 2 UTF-16 code units but 1 code point via Array.from.
    const text = '\uD83D\uDE00'.repeat(150) // 150 emoji code points
    const result = getMessagePreviewText(baseOpts({ message: agentMsg('m', text) }))
    expect(result).not.toBeNull()
    expect(Array.from(result!).length).toBe(121) // 120 + ellipsis
  })

  test('tabs and newlines are collapsed to single spaces', () => {
    const result = getMessagePreviewText(baseOpts({
      message: agentMsg('m', 'hello\t\tworld\n\nfoo  bar'),
    }))
    expect(result).toBe('hello world foo bar')
  })

  test('leading and trailing whitespace is trimmed', () => {
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m', '  hello  ') }))).toBe('hello')
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m', '\n\t  hi  \n') }))).toBe('hi')
  })

  test('whitespace-only text returns null', () => {
    for (const ws of ['', ' ', '   ', '\n\n', '\t\t', ' \n \t ']) {
      expect(getMessagePreviewText(baseOpts({ message: agentMsg('m', ws) }))).toBeNull()
    }
  })

  test('non-string text field returns null', () => {
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m', 'x'), content: { text: 123 } },
    }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m', 'x'), content: { text: null } },
    }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m', 'x'), content: { text: undefined } },
    }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m', 'x'), content: {} },
    }))).toBeNull()
  })
})

describe('Developer — multi-message dedup sequences', () => {
  test('first message previews, second different message previews, duplicate does not', () => {
    const seenIds: string[] = []
    // First message.
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-1', 'First'), seenIds }))).toBe('First')
    seenIds.push('m-1')
    // Second message (different id).
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-2', 'Second'), seenIds }))).toBe('Second')
    seenIds.push('m-2')
    // Duplicate of first (same id) — no preview.
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-1', 'First'), seenIds }))).toBeNull()
    // Duplicate of second — no preview.
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-2', 'Second'), seenIds }))).toBeNull()
  })

  test('empty seenIds allows the first message', () => {
    expect(getMessagePreviewText(baseOpts({ seenIds: [] }))).toBe('Hello')
  })

  test('message with empty id is rejected', () => {
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('', 'Hello') }))).toBeNull()
  })

  test('message with non-string id is rejected', () => {
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m-1', 'Hello'), id: 123 as unknown as string },
    }))).toBeNull()
  })
})

describe('Developer — state transitions and dismiss', () => {
  test('closed → preview → open → no preview → closed → re-eligible for NEW message', () => {
    const seenIds: string[] = []
    // Closed + new message → preview.
    expect(getMessagePreviewText(baseOpts({ panelOpen: false, message: agentMsg('m-1', 'Reply 1'), seenIds }))).toBe('Reply 1')
    seenIds.push('m-1')
    // Open → no preview (even for a new message).
    expect(getMessagePreviewText(baseOpts({ panelOpen: true, message: agentMsg('m-2', 'Reply 2'), seenIds }))).toBeNull()
    // Close → the m-2 message was NOT seen (panel was open), so it's still eligible.
    // But in a real runtime, m-2 would have been added to seenIds during the open panel.
    // Here we simulate that: the visitor saw m-2 while open, so it's seen.
    seenIds.push('m-2')
    // A NEW message (m-3) after closing → eligible again.
    expect(getMessagePreviewText(baseOpts({ panelOpen: false, message: agentMsg('m-3', 'Reply 3'), seenIds }))).toBe('Reply 3')
  })

  test('dismiss does not prevent a subsequent new message from previewing', () => {
    const seenIds: string[] = []
    // First message → preview. Dismiss hides it (runtime action, not policy).
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-1', 'First'), seenIds }))).toBe('First')
    seenIds.push('m-1')
    // After dismiss, a new different message → preview.
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m-2', 'Second'), seenIds }))).toBe('Second')
  })

  test('unauthorized visitor never gets a preview regardless of message', () => {
    expect(getMessagePreviewText(baseOpts({ authorized: false }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({ authorized: false, conversationId: null }))).toBeNull()
  })

  test('null conversationId blocks preview', () => {
    expect(getMessagePreviewText(baseOpts({ conversationId: null }))).toBeNull()
  })
})

describe('Developer — source ingestion boundaries', () => {
  test('live and poll produce previews; history and post never do', () => {
    for (const source of ['live', 'poll'] as const) {
      expect(getMessagePreviewText(baseOpts({ source }))).toBe('Hello')
    }
    for (const source of ['history', 'post'] as const) {
      expect(getMessagePreviewText(baseOpts({ source }))).toBeNull()
    }
  })

  test('history source is still blocked even when seenIds is empty', () => {
    // A history message that was never seen — still no preview (source gate).
    expect(getMessagePreviewText(baseOpts({ source: 'history', seenIds: [] }))).toBeNull()
  })

  test('post (optimistic visitor echo) is blocked', () => {
    expect(getMessagePreviewText(baseOpts({ source: 'post' }))).toBeNull()
  })
})

describe('Developer — sender and content type gates', () => {
  test('only agent sender produces a preview', () => {
    for (const senderType of ['contact', 'ai', 'system', 'visitor', 'bot', '']) {
      expect(getMessagePreviewText(baseOpts({
        message: { ...agentMsg('m-1', 'Hello'), senderType },
      }))).toBeNull()
    }
    expect(getMessagePreviewText(baseOpts({
      message: { ...agentMsg('m-1', 'Hello'), senderType: 'agent' },
    }))).toBe('Hello')
  })

  test('only text content type produces a preview', () => {
    for (const contentType of ['image', 'file', 'video', 'audio', 'system', '']) {
      expect(getMessagePreviewText(baseOpts({
        message: { ...agentMsg('m-1', 'Hello'), contentType },
      }))).toBeNull()
    }
  })

  test('message from a different conversation is blocked', () => {
    expect(getMessagePreviewText(baseOpts({
      message: agentMsg('m-1', 'Hello', 'other-conv'),
    }))).toBeNull()
  })
})

describe('Developer — default disabled behavior', () => {
  test('disabled entitlement blocks all previews', () => {
    expect(getMessagePreviewText(baseOpts({ enabled: false }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({ enabled: false, source: 'live' }))).toBeNull()
    expect(getMessagePreviewText(baseOpts({ enabled: false, source: 'poll' }))).toBeNull()
  })

  test('all paid plans see enabled=true when stored true; Free always false', () => {
    const stored = { appearanceV2: { version: 1, messagePreview: { enabled: true } } }
    expect(resolveEffectiveMessagePreview(stored, FREE).enabled).toBe(false)
    expect(resolveEffectiveMessagePreview(stored, PRO).enabled).toBe(true)
    expect(resolveEffectiveMessagePreview(stored, MAX).enabled).toBe(true)
    expect(resolveEffectiveMessagePreview(stored, SELF).enabled).toBe(true)
    expect(resolveEffectiveMessagePreview(stored, UNKNOWN).enabled).toBe(false)
  })

  test('no stored V2 → false for all plans', () => {
    for (const ent of [FREE, PRO, MAX, SELF, UNKNOWN]) {
      expect(resolveEffectiveMessagePreview({ appearanceV2: null }, ent).enabled).toBe(false)
      expect(resolveEffectiveMessagePreview({ appearanceV2: undefined }, ent).enabled).toBe(false)
    }
  })

  test('explicit false stored → false even for paid', () => {
    const stored = { appearanceV2: { version: 1, messagePreview: { enabled: false } } }
    expect(resolveEffectiveMessagePreview(stored, PRO).enabled).toBe(false)
  })
})

describe('Developer — PATCH validation edge cases', () => {
  test('Free cannot patch even when enabled=false (not just true)', () => {
    expect(validateMessagePreviewPatch({ messagePreview: { enabled: false } }, FREE))
      .toEqual({ ok: false, code: 'message_preview_not_allowed' })
  })

  test('Max and Self-hosted can patch (not just Pro)', () => {
    for (const ent of [MAX, SELF]) {
      expect(validateMessagePreviewPatch({ messagePreview: { enabled: true } }, ent))
        .toEqual({ ok: true, data: { enabled: true } })
    }
  })

  test('unknown plan is rejected with not_authorized', () => {
    expect(validateMessagePreviewPatch({ messagePreview: { enabled: true } }, UNKNOWN))
      .toEqual({ ok: false, code: 'message_preview_not_authorized' })
  })

  test('null entitlements is rejected', () => {
    expect(validateMessagePreviewPatch({ messagePreview: { enabled: true } }, null).ok).toBe(false)
  })

  test('boolean coercion is rejected (enabled must be strict boolean)', () => {
    for (const v of ['true', 1, 0, 'false', 'yes', 'no', 'on', 'off']) {
      expect(validateMessagePreviewPatch({ messagePreview: { enabled: v } }, PRO).ok).toBe(false)
    }
  })

  test('smuggled fields in PATCH are rejected', () => {
    for (const extra of [
      { enabled: true, text: 'hello' },
      { enabled: true, id: 'x' },
      { enabled: true, plan: 'pro' },
      { enabled: true, css: 'x' },
      { enabled: true, arbitrary: 1 },
    ]) {
      expect(validateMessagePreviewPatch({ messagePreview: extra }, PRO).ok).toBe(false)
    }
  })

  test('missing messagePreview body is rejected with no_fields', () => {
    expect(validateMessagePreviewPatch({}, PRO).ok).toBe(false)
  })

  test('missing enabled field is rejected', () => {
    expect(validateMessagePreviewPatch({ messagePreview: {} }, PRO).ok).toBe(false)
  })
})

describe('Developer — cross-feature preservation in mergeMessagePreviewPatch', () => {
  const full = {
    version: 1 as const,
    desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 10, offsetY: -5 } },
    mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -3, offsetY: 7 } },
    colors: { mode: 'preset' as const, presetId: 'sunset' },
    launcher: { shape: 'pill' as const, paidShape: 'pill' as const },
    attention: { animation: 'glow' as const, paidAnimation: 'glow' as const },
    messagePreview: { enabled: true },
  }

  test('messagePreview edit preserves colors, launcher, attention, BOTH positions', () => {
    const r = mergeMessagePreviewPatch(full, { enabled: false })
    expect(r.colors).toEqual(full.colors)
    expect(r.launcher).toEqual(full.launcher)
    expect(r.attention).toEqual(full.attention)
    expect(r.desktop).toEqual(full.desktop)
    expect(r.mobile).toEqual(full.mobile)
    expect(r.messagePreview).toEqual({ enabled: false })
  })

  test('each sibling merge preserves messagePreview', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'emerald' } }).messagePreview).toEqual({ enabled: true })
    expect(mergeLauncherPatch(full, { shape: 'tab' }, PRO).messagePreview).toEqual({ enabled: true })
    expect(mergeAttentionPatch(full, { animation: 'none' }, PRO).messagePreview).toEqual({ enabled: true })
    expect(mergePositioningPatch(full, { hasAny: true, desktop: { hasFields: true, anchor: 'bottom-end' } }, 'bottom-end').messagePreview).toEqual({ enabled: true })
  })

  test('messagePreview on empty V2 creates a valid canonical object', () => {
    const r = mergeMessagePreviewPatch(null, { enabled: true })
    expect(r.version).toBe(1)
    expect(r.messagePreview).toEqual({ enabled: true })
    expect(r.desktop).toEqual({})
    expect(r.mobile).toEqual({})
    expect(parseAppearanceV2(r)).not.toBeNull()
  })
})

describe('Developer — strict parseAppearanceV2 messagePreview', () => {
  test('valid messagePreview coexists with all V2 fields', () => {
    const v = {
      version: 1 as const,
      desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 0, offsetY: 0 } },
      mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: 0, offsetY: 0 } },
      messagePreview: { enabled: true },
    }
    expect(parseAppearanceV2(v)).toEqual({
      ...v,
      desktop: v.desktop,
      mobile: v.mobile,
      messagePreview: { enabled: true },
    })
  })

  test('reject non-boolean enabled', () => {
    for (const enabled of ['true', 1, 0, null, 'yes', [], {}]) {
      expect(parseAppearanceV2({ version: 1, messagePreview: { enabled } })).toBeNull()
    }
  })

  test('reject arrays, primitives, and extra keys', () => {
    expect(parseAppearanceV2({ version: 1, messagePreview: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, messagePreview: true })).toBeNull()
    expect(parseAppearanceV2({ version: 1, messagePreview: 'true' })).toBeNull()
    expect(parseAppearanceV2({ version: 1, messagePreview: { enabled: true, extra: 1 } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, messagePreview: { enabled: true, text: 'x' } })).toBeNull()
  })

  test('reject getter-based malformed objects', () => {
    expect(parseAppearanceV2({
      version: 1,
      messagePreview: { get enabled() { throw new Error('unsafe') } },
    })).toBeNull()
  })

  test('absent messagePreview is valid (additive field)', () => {
    expect(parseAppearanceV2({ version: 1 })?.messagePreview).toBeUndefined()
    expect(parseAppearanceV2({ version: 1, desktop: {} })?.messagePreview).toBeUndefined()
  })

  test('false is a valid enabled value', () => {
    expect(parseAppearanceV2({ version: 1, messagePreview: { enabled: false } }))
      .toEqual({ version: 1, desktop: {}, mobile: {}, messagePreview: { enabled: false } })
  })
})

describe('Developer — XSS safety and PREVIEW_MAX_CODE_POINTS constant', () => {
  test('HTML content is returned as plain text (never escaped, never HTML)', () => {
    const raw = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    expect(getMessagePreviewText(baseOpts({ message: agentMsg('m', raw) }))).toBe(raw)
  })

  test('PREVIEW_MAX_CODE_POINTS is 120', () => {
    expect(PREVIEW_MAX_CODE_POINTS).toBe(120)
  })

  test('truncation preserves the first 120 code points exactly', () => {
    const text = 'AB'.repeat(100) // 200 code points
    const result = getMessagePreviewText(baseOpts({ message: agentMsg('m', text) }))
    expect(result).not.toBeNull()
    expect(Array.from(result!.slice(0, 120)).length).toBe(120)
    expect(result!.startsWith('AB'.repeat(60))).toBe(true) // first 120 chars
  })
})

describe('Developer — downgrade/upgrade lifecycle', () => {
  test('Pro enables → downgrade to Free → stored true but effective false → upgrade restores true', () => {
    // Pro enables.
    const stored = { appearanceV2: mergeMessagePreviewPatch(null, { enabled: true }) }
    expect(resolveEffectiveMessagePreview(stored, PRO).enabled).toBe(true)
    // Downgrade to Free — stored unchanged, effective false.
    expect(resolveEffectiveMessagePreview(stored, FREE).enabled).toBe(false)
    // The stored preference is NOT modified by the resolver.
    expect(stored.appearanceV2.messagePreview).toEqual({ enabled: true })
    // Upgrade back to Pro — effective true restored.
    expect(resolveEffectiveMessagePreview(stored, PRO).enabled).toBe(true)
  })

  test('explicit Pro disable persists across upgrade', () => {
    const stored = { appearanceV2: mergeMessagePreviewPatch(null, { enabled: false }) }
    expect(resolveEffectiveMessagePreview(stored, PRO).enabled).toBe(false)
    // "Upgrade" to Max — still false (explicit disable).
    expect(resolveEffectiveMessagePreview(stored, MAX).enabled).toBe(false)
  })

  test('Free never sees stored true as effective', () => {
    const stored = { appearanceV2: { version: 1, messagePreview: { enabled: true } } }
    expect(resolveEffectiveMessagePreview(stored, FREE).enabled).toBe(false)
    expect(resolveEffectiveMessagePreview(stored, UNKNOWN).enabled).toBe(false)
  })
})
