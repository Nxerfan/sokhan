/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 6 — Quick Replies.
 *
 * These tests exercise the REAL production modules with additional edge cases
 * that complement (not duplicate) the reviewer-owned contract. They cover:
 *   - Input normalization (no trim, reject padding/multiline).
 *   - Unicode length boundaries (1, 80, 81 code points, emoji).
 *   - Case-insensitive duplicate detection.
 *   - Downgrade/upgrade/paidItems preservation lifecycle.
 *   - Explicit Pro override clearing paidItems (no stale-preference bug).
 *   - Cross-feature preservation across all 6 sibling merges.
 *   - Strict parseAppearanceV2 rejection of malformed quickReplies.
 *   - Resolver edge cases (empty items, paidItems restore, unknown plans).
 *   - Validation edge cases (non-string items, nested arrays, paidItems smuggling).
 */
import { describe, test, expect } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validateQuickRepliesPatch, mergeQuickRepliesPatch,
} from '../../src/lib/widget/quick-replies-patch'
import { resolveEffectiveQuickReplies } from '../../src/lib/widget/effective-quick-replies'
import {
  FREE_QUICK_REPLIES_MAX,
  PAID_QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX_CODE_POINTS,
  normalizeQuickReplyText,
  hasCaseInsensitiveDuplicate,
  isAdvancedQuickRepliesPlan,
  shouldShowQuickReplies,
} from '../../src/lib/widget/quick-replies-types'
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

const TEN = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9', 'J0']
const firstTwo = TEN.slice(0, 2)
const full = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 5, offsetY: -5 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -3, offsetY: 3 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const },
  attention: { animation: 'pulse' as const },
  messagePreview: { enabled: true },
  quickReplies: { items: TEN },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Developer — normalizeQuickReplyText edge cases', () => {
  test('rejects whitespace-padded labels (no trimming)', () => {
    expect(normalizeQuickReplyText('  Hello')).toBeNull()
    expect(normalizeQuickReplyText('Hello  ')).toBeNull()
    expect(normalizeQuickReplyText(' Hello ')).toBeNull()
  })

  test('rejects blank and whitespace-only', () => {
    expect(normalizeQuickReplyText('')).toBeNull()
    expect(normalizeQuickReplyText(' ')).toBeNull()
    expect(normalizeQuickReplyText('   ')).toBeNull()
    expect(normalizeQuickReplyText('\t')).toBeNull()
  })

  test('rejects multiline (newlines)', () => {
    expect(normalizeQuickReplyText('\nHello')).toBeNull()
    expect(normalizeQuickReplyText('Hello\nWorld')).toBeNull()
    expect(normalizeQuickReplyText('Hello\rWorld')).toBeNull()
  })

  test('accepts valid single-line text', () => {
    expect(normalizeQuickReplyText('Hello')).toBe('Hello')
    expect(normalizeQuickReplyText('Hello World')).toBe('Hello World')
    expect(normalizeQuickReplyText('A')).toBe('A')
  })

  test('exact 80 code points accepted, 81 rejected', () => {
    expect(normalizeQuickReplyText('A'.repeat(80))).toBe('A'.repeat(80))
    expect(normalizeQuickReplyText('A'.repeat(81))).toBeNull()
  })

  test('emoji counted as single code points', () => {
    expect(normalizeQuickReplyText('😀'.repeat(80))).toBe('😀'.repeat(80))
    expect(normalizeQuickReplyText('😀'.repeat(81))).toBeNull()
  })

  test('rejects non-string types', () => {
    expect(normalizeQuickReplyText(42)).toBeNull()
    expect(normalizeQuickReplyText(null)).toBeNull()
    expect(normalizeQuickReplyText(undefined)).toBeNull()
    expect(normalizeQuickReplyText(true)).toBeNull()
    expect(normalizeQuickReplyText([])).toBeNull()
    expect(normalizeQuickReplyText({})).toBeNull()
  })
})

describe('Developer — hasCaseInsensitiveDuplicate', () => {
  test('detects exact and case-insensitive duplicates', () => {
    expect(hasCaseInsensitiveDuplicate(['Hello', 'Hello'])).toBe(true)
    expect(hasCaseInsensitiveDuplicate(['Hello', 'hello'])).toBe(true)
    expect(hasCaseInsensitiveDuplicate(['Hello', 'HELLO'])).toBe(true)
  })

  test('no duplicates in unique list', () => {
    expect(hasCaseInsensitiveDuplicate(['Hello', 'World'])).toBe(false)
    expect(hasCaseInsensitiveDuplicate(['A', 'B', 'C'])).toBe(false)
    expect(hasCaseInsensitiveDuplicate([])).toBe(false)
  })
})

describe('Developer — isAdvancedQuickRepliesPlan', () => {
  test('Free is not advanced, paid is advanced', () => {
    expect(isAdvancedQuickRepliesPlan(FREE_QUICK_REPLIES_MAX)).toBe(false)
    expect(isAdvancedQuickRepliesPlan(PAID_QUICK_REPLIES_MAX)).toBe(true)
    expect(isAdvancedQuickRepliesPlan(0)).toBe(false)
  })
})

describe('Developer — validation edge cases', () => {
  test('Free accepts 0, 1, 2 items; rejects 3+ with limit_exceeded', () => {
    expect(validateQuickRepliesPatch({ quickReplies: { items: [] } }, FREE).ok).toBe(true)
    expect(validateQuickRepliesPatch({ quickReplies: { items: ['A'] } }, FREE).ok).toBe(true)
    expect(validateQuickRepliesPatch({ quickReplies: { items: ['A', 'B'] } }, FREE).ok).toBe(true)
    const r = validateQuickRepliesPatch({ quickReplies: { items: ['A', 'B', 'C'] } }, FREE)
    expect(r).toEqual({ ok: false, code: 'quick_replies_limit_exceeded' })
  })

  test('Max and Self-hosted accept up to 10', () => {
    for (const ent of [MAX, SELF]) {
      expect(validateQuickRepliesPatch({ quickReplies: { items: TEN } }, ent).ok).toBe(true)
      const r = validateQuickRepliesPatch({ quickReplies: { items: [...TEN, 'X'] } }, ent)
      expect(r).toEqual({ ok: false, code: 'quick_replies_limit_exceeded' })
    }
  })

  test('null entitlements rejected', () => {
    expect(validateQuickRepliesPatch({ quickReplies: { items: [] } }, null).ok).toBe(false)
  })

  test('rejects non-array items', () => {
    for (const items of ['Hello', 42, null, {}, true]) {
      expect(validateQuickRepliesPatch({ quickReplies: { items } }, PRO).ok).toBe(false)
    }
  })

  test('rejects non-string elements in items', () => {
    for (const el of [42, null, {}, [], true, undefined]) {
      expect(validateQuickRepliesPatch({ quickReplies: { items: [el] } }, PRO).ok).toBe(false)
    }
  })

  test('rejects nested arrays in items', () => {
    expect(validateQuickRepliesPatch({ quickReplies: { items: [['Nested']] } }, PRO).ok).toBe(false)
  })

  test('rejects smuggled paidItems in PATCH', () => {
    const r = validateQuickRepliesPatch({ quickReplies: { items: ['A'], paidItems: ['B'] } }, PRO)
    expect(r.ok).toBe(false)
  })

  test('rejects unexpected keys (css, plan, id)', () => {
    for (const extra of [
      { items: ['A'], css: 'x' },
      { items: ['A'], plan: 'pro' },
      { items: ['A'], id: 1 },
    ]) {
      expect(validateQuickRepliesPatch({ quickReplies: extra }, PRO).ok).toBe(false)
    }
  })

  test('returns items as-is (no trimming)', () => {
    const r = validateQuickRepliesPatch({ quickReplies: { items: ['Hello World'] } }, PRO)
    expect(r).toEqual({ ok: true, data: { items: ['Hello World'] } })
  })
})

describe('Developer — downgrade/upgrade/paidItems lifecycle', () => {
  test('Pro 10 → Free 2: paidItems preserves all 10', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['X', 'Y'] }, FREE)
    expect(down.quickReplies).toEqual({ items: ['X', 'Y'], paidItems: TEN })
    expect(resolveEffectiveQuickReplies(input(down), FREE).items).toEqual(['X', 'Y'])
    expect(resolveEffectiveQuickReplies(input(down), PRO).items).toEqual(TEN)
  })

  test('Free idempotent edit preserves paidItems (no stale-preference bug)', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['X', 'Y'] }, FREE)
    const again = mergeQuickRepliesPatch(down, { items: ['X', 'Y'] }, FREE)
    expect(again.quickReplies?.paidItems).toEqual(TEN)
  })

  test('Pro explicit override clears paidItems even when items match stored Free items', () => {
    const free = mergeQuickRepliesPatch(full, { items: ['A', 'B'] }, FREE)
    expect(free.quickReplies?.paidItems).toEqual(TEN)
    const pro = mergeQuickRepliesPatch(free, { items: ['A', 'B'] }, PRO)
    expect(pro.quickReplies).toEqual({ items: ['A', 'B'] })
    expect(pro.quickReplies?.paidItems).toBeUndefined()
  })

  test('Free clear to empty preserves paidItems', () => {
    const free = mergeQuickRepliesPatch(full, { items: [] }, FREE)
    expect(free.quickReplies?.items).toEqual([])
    expect(free.quickReplies?.paidItems).toEqual(TEN)
    expect(resolveEffectiveQuickReplies(input(free), PRO).items).toEqual(TEN)
  })

  test('Pro clear to empty removes paidItems', () => {
    const paid = mergeQuickRepliesPatch(full, { items: [] }, PRO)
    expect(paid.quickReplies).toEqual({ items: [] })
    expect(paid.quickReplies?.paidItems).toBeUndefined()
  })

  test('Free edit from already-Free config (no paidItems) does not create paidItems', () => {
    const freeConfig = { ...full, quickReplies: { items: ['A', 'B'] } }
    const edited = mergeQuickRepliesPatch(freeConfig, { items: ['C', 'D'] }, FREE)
    expect(edited.quickReplies).toEqual({ items: ['C', 'D'] })
    expect(edited.quickReplies?.paidItems).toBeUndefined()
  })
})

describe('Developer — resolver edge cases', () => {
  test('null entitlements → empty', () => {
    expect(resolveEffectiveQuickReplies(input(full), UNKNOWN)).toEqual({ items: [] })
    expect(resolveEffectiveQuickReplies(input(full), null)).toEqual({ items: [] })
  })

  test('no V2 → empty', () => {
    expect(resolveEffectiveQuickReplies(input(null), PRO)).toEqual({ items: [] })
    expect(resolveEffectiveQuickReplies(input({ version: 1 }), PRO)).toEqual({ items: [] })
  })

  test('Free truncates to first 2', () => {
    expect(resolveEffectiveQuickReplies(input(full), FREE).items).toEqual(TEN.slice(0, 2))
  })

  test('Pro with paidItems restores them', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['X', 'Y'] }, FREE)
    expect(resolveEffectiveQuickReplies(input(down), PRO).items).toEqual(TEN)
    expect(resolveEffectiveQuickReplies(input(down), MAX).items).toEqual(TEN)
  })

  test('Pro without paidItems uses stored items', () => {
    expect(resolveEffectiveQuickReplies(input(full), PRO).items).toEqual(TEN)
  })

  test('Free with paidItems does NOT expose them', () => {
    const down = mergeQuickRepliesPatch(full, { items: ['X', 'Y'] }, FREE)
    expect(resolveEffectiveQuickReplies(input(down), FREE).items).toEqual(['X', 'Y'])
  })
})

describe('Developer — cross-feature preservation', () => {
  test('quickReplies edit preserves all 6 V2 neighbors', () => {
    const r = mergeQuickRepliesPatch(full, { items: ['New'] }, PRO)
    expect(r.colors).toEqual(full.colors)
    expect(r.launcher).toEqual(full.launcher)
    expect(r.attention).toEqual(full.attention)
    expect(r.messagePreview).toEqual(full.messagePreview)
    expect(r.desktop).toEqual(full.desktop)
    expect(r.mobile).toEqual(full.mobile)
    expect(parseAppearanceV2(r)).not.toBeNull()
  })

  test('all 5 sibling merges preserve quickReplies', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'sunset' } }).quickReplies).toEqual(full.quickReplies)
    expect(mergeLauncherPatch(full, { shape: 'pill' }, PRO).quickReplies).toEqual(full.quickReplies)
    expect(mergeAttentionPatch(full, { animation: 'shake' }, PRO).quickReplies).toEqual(full.quickReplies)
    expect(mergeMessagePreviewPatch(full, { enabled: false }).quickReplies).toEqual(full.quickReplies)
    expect(mergePositioningPatch(full, { hasAny: true, desktop: { hasFields: true, anchor: 'bottom-end' } }, 'bottom-end').quickReplies).toEqual(full.quickReplies)
  })

  test('chained edits preserve quickReplies', () => {
    const a = mergeQuickRepliesPatch(full, { items: ['Help'] }, PRO)
    const b = mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } })
    const c = mergeAttentionPatch(b, { animation: 'shake' }, PRO)
    const d = mergeLauncherPatch(c, { shape: 'pill' }, PRO)
    const e = mergeMessagePreviewPatch(d, { enabled: false })
    expect(e.quickReplies).toEqual({ items: ['Help'] })
    expect(e.colors?.presetId).toBe('sunset')
    expect(e.messagePreview?.enabled).toBe(false)
  })
})

describe('Developer — strict parseAppearanceV2 quickReplies', () => {
  test('valid quickReplies coexists with all V2 fields', () => {
    expect(parseAppearanceV2(full)?.quickReplies).toEqual({ items: TEN })
  })

  test('rejects null, arrays, primitives', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: null })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: 'hello' })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: 42 })).toBeNull()
  })

  test('rejects non-string items', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: [null] } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: [3] } })).toBeNull()
  })

  test('rejects unexpected keys', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['A'], css: 'x' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['A'], extra: 1 } })).toBeNull()
  })

  test('rejects contradictory paidItems (subset of items)', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['A'], paidItems: ['A'] } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['A', 'B'], paidItems: ['A'] } })).toBeNull()
  })

  test('rejects empty paidItems', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['A'], paidItems: [] } })).toBeNull()
  })

  test('accepts valid paidItems (superset with new items)', () => {
    const v = parseAppearanceV2({ version: 1, quickReplies: { items: ['A'], paidItems: ['A', 'B', 'C'] } })
    expect(v?.quickReplies).toEqual({ items: ['A'], paidItems: ['A', 'B', 'C'] })
  })

  test('accepts empty items with paidItems', () => {
    const v = parseAppearanceV2({ version: 1, quickReplies: { items: [], paidItems: ['A', 'B'] } })
    expect(v?.quickReplies).toEqual({ items: [], paidItems: ['A', 'B'] })
  })

  test('rejects getter-based malformed objects', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { get items() { throw new Error('x') } } })).toBeNull()
  })

  test('absent quickReplies is valid (additive field)', () => {
    expect(parseAppearanceV2({ version: 1 })?.quickReplies).toBeUndefined()
  })

  test('HTML in items is accepted as plain text (XSS safety in DOM layer)', () => {
    const v = parseAppearanceV2({ version: 1, quickReplies: { items: ['<img src=x onerror=alert(1)>'] } })
    expect(v).not.toBeNull()
    expect(v?.quickReplies?.items).toEqual(['<img src=x onerror=alert(1)>'])
  })

  test('rejects whitespace-padded items in parser', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['  Hello  '] } })).toBeNull()
  })

  test('rejects duplicate items in parser', () => {
    expect(parseAppearanceV2({ version: 1, quickReplies: { items: ['Hello', 'hello'] } })).toBeNull()
  })
})

describe('Developer — constants', () => {
  test('FREE_QUICK_REPLIES_MAX is 2', () => {
    expect(FREE_QUICK_REPLIES_MAX).toBe(2)
  })

  test('PAID_QUICK_REPLIES_MAX is 10', () => {
    expect(PAID_QUICK_REPLIES_MAX).toBe(10)
  })

  test('QUICK_REPLY_MAX_CODE_POINTS is 80', () => {
    expect(QUICK_REPLY_MAX_CODE_POINTS).toBe(80)
  })
})

describe('Developer — identity-readiness visibility policy (shouldShowQuickReplies)', () => {
  // Helper: the fully-authorized, panel-open, pre-first-message state.
  const ready = {
    panelOpen: true,
    authorized: true,
    itemsCount: 2,
    hasVisitorMessage: false,
  }

  test('identity not ready (no token) → hidden even if panel open + items exist', () => {
    expect(shouldShowQuickReplies({ ...ready, authorized: false })).toBe(false)
  })

  test('authorization completes → visible without reopening panel', () => {
    // Before /contact resolves: authorized=false → hidden.
    expect(shouldShowQuickReplies({ ...ready, authorized: false })).toBe(false)
    // After /contact resolves: authorized=true → visible (same panel state).
    expect(shouldShowQuickReplies({ ...ready, authorized: true })).toBe(true)
  })

  test('authorization lost (token revoked / recovery starts) → immediately hidden', () => {
    // Authorized → visible.
    expect(shouldShowQuickReplies(ready)).toBe(true)
    // Token revoked → hidden.
    expect(shouldShowQuickReplies({ ...ready, authorized: false })).toBe(false)
  })

  test('authorization recovered → visible again', () => {
    // Lost → hidden.
    expect(shouldShowQuickReplies({ ...ready, authorized: false })).toBe(false)
    // Recovered → visible.
    expect(shouldShowQuickReplies({ ...ready, authorized: true })).toBe(true)
  })

  test('panel closed → hidden regardless of authorization', () => {
    expect(shouldShowQuickReplies({ ...ready, panelOpen: false })).toBe(false)
    expect(shouldShowQuickReplies({ ...ready, panelOpen: false, authorized: false })).toBe(false)
  })

  test('no items → hidden', () => {
    expect(shouldShowQuickReplies({ ...ready, itemsCount: 0 })).toBe(false)
  })

  test('visitor message persisted → hidden (permanent, even if authorized)', () => {
    expect(shouldShowQuickReplies({ ...ready, hasVisitorMessage: true })).toBe(false)
  })

  test('all conditions met → visible', () => {
    expect(shouldShowQuickReplies(ready)).toBe(true)
  })

  test('any single condition false → hidden', () => {
    // Each condition independently gates the visibility.
    expect(shouldShowQuickReplies({ ...ready, panelOpen: false })).toBe(false)
    expect(shouldShowQuickReplies({ ...ready, authorized: false })).toBe(false)
    expect(shouldShowQuickReplies({ ...ready, itemsCount: 0 })).toBe(false)
    expect(shouldShowQuickReplies({ ...ready, hasVisitorMessage: true })).toBe(false)
  })

  test('identity state transitions: mount → pending → ready → lost → recovered', () => {
    // 1. Mount: panel closed, no identity.
    expect(shouldShowQuickReplies({
      panelOpen: false, authorized: false, itemsCount: 2, hasVisitorMessage: false,
    })).toBe(false)

    // 2. Panel opens while /contact pending: authorized still false.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: false, itemsCount: 2, hasVisitorMessage: false,
    })).toBe(false)

    // 3. /contact succeeds: authorized becomes true → visible WITHOUT reopen.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: true, itemsCount: 2, hasVisitorMessage: false,
    })).toBe(true)

    // 4. Authorization lost (recovery): token cleared → hidden.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: false, itemsCount: 2, hasVisitorMessage: false,
    })).toBe(false)

    // 5. Recovery succeeds: authorized restored → visible again.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: true, itemsCount: 2, hasVisitorMessage: false,
    })).toBe(true)

    // 6. First visitor message persisted → permanently hidden.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: true, itemsCount: 2, hasVisitorMessage: true,
    })).toBe(false)
  })

  test('history restore: visitor message from history → hidden on reload', () => {
    // After reload, history includes a visitor message → hidden.
    expect(shouldShowQuickReplies({
      panelOpen: true, authorized: true, itemsCount: 2, hasVisitorMessage: true,
    })).toBe(false)
  })
})
