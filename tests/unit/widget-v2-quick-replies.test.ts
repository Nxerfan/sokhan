/// <reference types="bun-types" />
/**
 * Feature 6 — independent reviewer-owned Quick Replies contract.
 * Developer must add SEPARATE implementation unit tests; do not alter
 * this file or workflow to make a production implementation pass.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validateQuickRepliesPatch, mergeQuickRepliesPatch,
} from '../../src/lib/widget/quick-replies-patch'
import { resolveEffectiveQuickReplies } from '../../src/lib/widget/effective-quick-replies'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unknown_plan__')
const TEN = [
  'Pricing', 'Features', 'Support', 'Billing', 'Availability',
  'Training', 'Installation', 'Cancel', 'Account', 'Talk to a person',
]
const firstTwo = TEN.slice(0, 2)
const full = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 37, offsetY: -16 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -13, offsetY: 8 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const, paidShape: 'pill' as const },
  attention: { animation: 'pulse' as const, paidAnimation: 'glow' as const },
  messagePreview: { enabled: true },
  quickReplies: { items: TEN },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Quick Replies: canonical plan caps and effective public configuration', () => {
  test('Free 2, paid 10, unknown fail closed', () => {
    expect(FREE?.quickReplies).toBe(2)
    for (const ent of [PRO, MAX, SELF]) expect(ent?.quickReplies).toBe(10)
    expect(UNKNOWN).toBeNull()
    expect(resolveEffectiveQuickReplies(input(full), FREE)).toEqual({ items: firstTwo })
    for (const ent of [PRO, MAX, SELF])
      expect(resolveEffectiveQuickReplies(input(full), ent)).toEqual({ items: TEN })
    expect(resolveEffectiveQuickReplies(input(full), UNKNOWN)).toEqual({ items: [] })
  })
  test('legacy config and empty V2 never invent suggested questions', () => {
    for (const ent of [FREE, PRO, UNKNOWN]) {
      expect(resolveEffectiveQuickReplies(input(null), ent)).toEqual({ items: [] })
      expect(resolveEffectiveQuickReplies(input({ version: 1 }), ent)).toEqual({ items: [] })
    }
  })
  test('Free effective config never exposes stored paid-only items', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['Hours', 'Shipping'] }, FREE)
    expect(down.quickReplies?.items).toEqual(['Hours', 'Shipping'])
    expect(resolveEffectiveQuickReplies(input(down), FREE)).toEqual({ items: ['Hours', 'Shipping'] })
    expect(resolveEffectiveQuickReplies(input(down), PRO)).toEqual({ items: TEN })
  })
})

describe('Quick Replies: strict server-side PATCH validation', () => {
  test('Free allows 0..2 items, rejects 3+; paid allows up to 10, rejects 11+', () => {
    for (const items of [[], ['Hello'], firstTwo]) {
      expect(validateQuickRepliesPatch({ quickReplies: { items } }, FREE))
        .toEqual({ ok: true, data: { items } })
    }
    expect(validateQuickRepliesPatch({ quickReplies: { items: TEN.slice(0, 3) } }, FREE))
      .toEqual({ ok: false, code: 'quick_replies_limit_exceeded' })
    expect(validateQuickRepliesPatch({ quickReplies: { items: TEN } }, PRO))
      .toEqual({ ok: true, data: { items: TEN } })
    expect(validateQuickRepliesPatch({ quickReplies: { items: [...TEN, 'Eleventh'] } }, PRO))
      .toEqual({ ok: false, code: 'quick_replies_limit_exceeded' })
  })
  test('unknown plan refuses any write, including empty list', () => {
    for (const items of [[], ['Hi']]) {
      expect(validateQuickRepliesPatch({ quickReplies: { items } }, UNKNOWN).ok).toBe(false)
    }
  })
  test('reject malformed types, unexpected properties and client-supplied paidItems', () => {
    for (const quickReplies of [
      null, undefined, 2, 'Hello', [], {}, { items: null }, { items: 'Hi' },
      { items: [42] }, { items: [null] }, { items: ['Good'], paidItems: ['Secret'] },
      { items: ['Good'], plan: 'pro' }, { items: [['Nested']] },
    ]) expect(validateQuickRepliesPatch({ quickReplies }, PRO).ok).toBe(false)
  })
  test('text is 1..80 Unicode code points, single line, nonblank and duplicate-free', () => {
    for (const items of [
      [''], [' '], ['  Hello  '], ['\nHello'], ['Hello\nWorld'],
      ['A'.repeat(81)], ['😀'.repeat(81)], ['Hello', 'Hello'], ['Hello', 'hello'],
      ['Question', 'Question '],
    ]) expect(validateQuickRepliesPatch({ quickReplies: { items } }, PRO).ok).toBe(false)
    const good = ['😀'.repeat(80), 'فارسی و English']
    expect(validateQuickRepliesPatch({ quickReplies: { items: good } }, PRO))
      .toEqual({ ok: true, data: { items: good } })
  })
})

describe('Quick Replies: downgrade, upgrade and explicit paid override', () => {
  test('Pro ten -> Free edit two preserves all ten for re-upgrade', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['New one', 'New two'] }, FREE)
    expect(down.quickReplies).toEqual({ items: ['New one', 'New two'], paidItems: TEN })
    expect(resolveEffectiveQuickReplies(input(down), FREE).items).toEqual(['New one', 'New two'])
    expect(resolveEffectiveQuickReplies(input(down), PRO).items).toEqual(TEN)
  })
  test('Free idempotent edit does NOT lose original paid preference', () => {
    const down = mergeQuickRepliesPatch(full, { items: firstTwo }, FREE)
    const again = mergeQuickRepliesPatch(down, { items: firstTwo }, FREE)
    expect(again.quickReplies?.paidItems).toEqual(TEN)
    expect(resolveEffectiveQuickReplies(input(again), PRO).items).toEqual(TEN)
  })
  test('Pro explicitly picks SAME stored Free list and clears old paidItems', () => {
    const free = mergeQuickRepliesPatch(full, { items: ['A', 'B'] }, FREE)
    expect(resolveEffectiveQuickReplies(input(free), PRO).items).toEqual(TEN)
    const paid = mergeQuickRepliesPatch(free, { items: ['A', 'B'] }, PRO)
    expect(paid.quickReplies).toEqual({ items: ['A', 'B'] })
    expect(resolveEffectiveQuickReplies(input(paid), PRO).items).toEqual(['A', 'B'])
  })
  test('Free may clear basic suggestions while preserving old paid preferences', () => {
    const free = mergeQuickRepliesPatch(full, { items: [] }, FREE)
    expect(resolveEffectiveQuickReplies(input(free), FREE).items).toEqual([])
    expect(resolveEffectiveQuickReplies(input(free), PRO).items).toEqual(TEN)
    const paidOff = mergeQuickRepliesPatch(free, { items: [] }, PRO)
    expect(paidOff.quickReplies).toEqual({ items: [] })
  })
})

describe('Quick Replies: true-patch and schema integrity', () => {
  test('new feature coexists with all previous V2 capabilities', () => {
    expect(parseAppearanceV2(full)).toEqual(full)
  })
  test('Quick Replies update preserves Colors, Launcher, Attention, Message Preview and both device offsets', () => {
    const out = mergeQuickRepliesPatch(full, { items: ['One'] }, PRO)
    expect(out.colors).toEqual(full.colors)
    expect(out.launcher).toEqual(full.launcher)
    expect(out.attention).toEqual(full.attention)
    expect(out.messagePreview).toEqual(full.messagePreview)
    expect(out.desktop).toEqual(full.desktop)
    expect(out.mobile).toEqual(full.mobile)
    expect(parseAppearanceV2(out)).not.toBeNull()
  })
  test('all FIVE sibling PATCH merges preserve Quick Replies', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'sunset' } }).quickReplies).toEqual(full.quickReplies)
    expect(mergeLauncherPatch(full, { shape: 'pill' }, PRO).quickReplies).toEqual(full.quickReplies)
    expect(mergeAttentionPatch(full, { animation: 'shake' }, PRO).quickReplies).toEqual(full.quickReplies)
    expect(mergeMessagePreviewPatch(full, { enabled: false }).quickReplies).toEqual(full.quickReplies)
    expect(mergePositioningPatch(full, {
      hasAny: true, desktop: { hasFields: true, anchor: 'bottom-end' },
    }, 'bottom-end').quickReplies).toEqual(full.quickReplies)
  })
  test('combined edits preserve suggestions even after unrelated V2 saves', () => {
    const a = mergeQuickRepliesPatch(full, { items: ['Help'] }, PRO)
    const b = mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } })
    const c = mergeAttentionPatch(b, { animation: 'shake' }, PRO)
    const d = mergeLauncherPatch(c, { shape: 'pill' }, PRO)
    const e = mergeMessagePreviewPatch(d, { enabled: false })
    expect(e.quickReplies).toEqual({ items: ['Help'] })
    expect(e.colors?.presetId).toBe('sunset')
    expect(e.desktop).toEqual(full.desktop)
    expect(e.mobile).toEqual(full.mobile)
  })
  test('malformed V2 suggestions and injected keys fail closed at parser boundary', () => {
    for (const quickReplies of [
      {}, null, [], { items: [null] }, { items: [3] },
      { items: ['Hi'], css: 'url(javascript:evil)' },
      { items: ['Hi'], paidItems: ['Hi'] }, // contradictory paid preference
      { items: ['Hi'], paidItems: [] }, // useless paid marker
      { get items() { throw Error('unsafe getter') } },
    ]) expect(parseAppearanceV2({ version: 1, quickReplies })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['<img src=x onerror=alert(1)>'] } })).not.toBeNull()
  })
})
