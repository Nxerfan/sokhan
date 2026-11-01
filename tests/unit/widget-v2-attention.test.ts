/// <reference types="bun-types" />
/**
 * Feature 4 — Attention Animations, independent reviewer-owned unit contract.
 * Production modules described in the implementation prompt must implement
 * exactly these functions. No database or browser dependency here.
 */
import { describe, test, expect } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { validateAttentionPatch, mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { resolveEffectiveAttention } from '../../src/lib/widget/effective-attention'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const UNKNOWN = getEntitlements('__not_a_plan__')
const source = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 35, offsetY: -12 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -23, offsetY: 8 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'pill' as const },
  attention: { animation: 'glow' as const },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('plan limits and public effective attention', () => {
  test('Free basic, Pro advanced, unknown fail closed', () => {
    expect(FREE?.attentionAnimations).toBe('basic')
    expect(PRO?.attentionAnimations).toBe('advanced')
    expect(UNKNOWN).toBeNull()
  })
  test('legacy without V2 attention never animates', () => {
    for (const plan of [FREE, PRO, UNKNOWN]) {
      expect(resolveEffectiveAttention(input(null), plan)).toEqual({ animation: 'none' })
    }
  })
  test('Free accepts none/pulse rendering only; Pro supports all four motions', () => {
    for (const animation of ['none', 'pulse', 'bounce', 'shake', 'glow'] as const) {
      const stored = input({ version: 1, attention: { animation } })
      expect(resolveEffectiveAttention(stored, PRO).animation).toBe(animation)
      expect(resolveEffectiveAttention(stored, FREE).animation).toBe(
        animation === 'pulse' ? 'pulse' : 'none',
      )
      expect(resolveEffectiveAttention(stored, UNKNOWN).animation).toBe('none')
    }
  })
})

describe('strict PATCH and entitlement enforcement', () => {
  test('Free none/pulse permitted, paid-only motions rejected with 403 code', () => {
    for (const animation of ['none', 'pulse']) {
      expect(validateAttentionPatch({ attention: { animation } }, FREE).ok).toBe(true)
    }
    for (const animation of ['bounce', 'shake', 'glow']) {
      expect(validateAttentionPatch({ attention: { animation } }, FREE))
        .toEqual({ ok: false, code: 'attention_animation_not_allowed' })
    }
  })
  test('Pro accepts exactly five values, unknown plan rejects all', () => {
    for (const animation of ['none', 'pulse', 'bounce', 'shake', 'glow']) {
      expect(validateAttentionPatch({ attention: { animation } }, PRO).ok).toBe(true)
      expect(validateAttentionPatch({ attention: { animation } }, UNKNOWN).ok).toBe(false)
    }
  })
  test('invalid structures and smuggled fields rejected', () => {
    const values: unknown[] = [
      undefined, null, 1, [], 'pulse', {}, { animation: null },
      { animation: 'PULSE' }, { animation: 'pulse', paidAnimation: 'glow' },
      { animation: 'glow', css: 'url(javascript:evil)' },
      { animation: 'pulse', unexpected: true }, { animation: ['glow'] },
    ]
    for (const attention of values) {
      expect(validateAttentionPatch({ attention }, PRO).ok).toBe(false)
    }
  })
})

describe('true-patch regression for all V2 neighbors', () => {
  test('attention save preserves Colors, Launcher, and BOTH device positions', () => {
    const out = mergeAttentionPatch(source, { animation: 'bounce' }, PRO)
    expect(out.attention).toEqual({ animation: 'bounce' })
    expect(out.colors).toEqual(source.colors)
    expect(out.launcher).toEqual(source.launcher)
    expect(out.desktop).toEqual(source.desktop)
    expect(out.mobile).toEqual(source.mobile)
    expect(parseAppearanceV2(out)).not.toBeNull()
  })
  test('idempotent attention save does not erase unrelated V2 fields', () => {
    const out = mergeAttentionPatch(source, { animation: 'glow' }, PRO)
    expect(out.colors).toEqual(source.colors)
    expect(out.launcher).toEqual(source.launcher)
  })
  test('Colors edit does not erase Attention', () => {
    const out = mergeColorPatch(source, { theme: { mode: 'preset', presetId: 'sunset' } })
    expect(out.attention).toEqual(source.attention)
    expect(out.launcher).toEqual(source.launcher)
  })
  test('Launcher edit does not erase Attention', () => {
    const out = mergeLauncherPatch(source, { shape: 'rounded' }, PRO)
    expect(out.attention).toEqual(source.attention)
    expect(out.colors).toEqual(source.colors)
  })
  test('Positioning edit does not erase Attention', () => {
    const out = mergePositioningPatch(source, {
      hasAny: true, desktop: { hasFields: true, anchor: 'bottom-end' },
    }, 'bottom-end')
    expect(out.attention).toEqual(source.attention)
    expect(out.colors).toEqual(source.colors)
    expect(out.launcher).toEqual(source.launcher)
    expect(out.mobile).toEqual(source.mobile)
  })
  test('combined edits keep final intended values regardless of prior features', () => {
    const a = mergeAttentionPatch(source, { animation: 'shake' }, PRO)
    const b = mergeColorPatch(a, { theme: { mode: 'preset', presetId: 'sunset' } })
    const c = mergeLauncherPatch(b, { shape: 'rounded' }, PRO)
    const d = mergePositioningPatch(c, {
      hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' },
    }, 'bottom-end')
    expect(d.attention?.animation).toBe('shake')
    expect(d.colors?.presetId).toBe('sunset')
    expect(d.launcher?.shape).toBe('rounded')
    expect(d.mobile?.positioning?.anchor).toBe('bottom-center')
    expect(d.desktop).toEqual(source.desktop)
  })
})

describe('downgrade, restore, and explicit paid override', () => {
  test('Pro glow -> Free pulse preserves paid preference but applies pulse', () => {
    const down = mergeAttentionPatch(source, { animation: 'pulse' }, FREE)
    expect(down.attention).toEqual({ animation: 'pulse', paidAnimation: 'glow' })
    expect(resolveEffectiveAttention(input(down), FREE).animation).toBe('pulse')
    expect(resolveEffectiveAttention(input(down), PRO).animation).toBe('glow')
  })
  test('Free idempotent edits preserve old Pro choice', () => {
    const first = mergeAttentionPatch(source, { animation: 'pulse' }, FREE)
    const second = mergeAttentionPatch(first, { animation: 'none' }, FREE)
    const third = mergeAttentionPatch(second, { animation: 'none' }, FREE)
    expect(third.attention?.paidAnimation).toBe('glow')
    expect(resolveEffectiveAttention(input(third), PRO).animation).toBe('glow')
  })
  test('explicit Pro choice clears paid preference EVEN if same as stored Free shape', () => {
    const free = mergeAttentionPatch(source, { animation: 'pulse' }, FREE)
    expect(resolveEffectiveAttention(input(free), PRO).animation).toBe('glow')
    const pro = mergeAttentionPatch(free, { animation: 'pulse' }, PRO)
    expect(pro.attention).toEqual({ animation: 'pulse' })
    expect(resolveEffectiveAttention(input(pro), PRO).animation).toBe('pulse')
    expect(pro.colors).toEqual(source.colors)
    expect(pro.launcher).toEqual(source.launcher)
  })
  test('Pro explicit off clears preserved paid preference', () => {
    const free = mergeAttentionPatch(source, { animation: 'pulse' }, FREE)
    const pro = mergeAttentionPatch(free, { animation: 'none' }, PRO)
    expect(pro.attention).toEqual({ animation: 'none' })
    expect(resolveEffectiveAttention(input(pro), PRO).animation).toBe('none')
  })
})

describe('strict persisted schema and injection prevention', () => {
  test('valid attention coexists with all previous V2 fields', () => {
    expect(parseAppearanceV2(source)).toEqual(source)
  })
  test('unknown animation names and CSS fragments fail validation', () => {
    for (const animation of ['UNKNOWN', 'pulse;color:red', '<script>', 'url(javascript:x)']) {
      expect(parseAppearanceV2({ version: 1, attention: { animation } })).toBeNull()
    }
  })
  test('paidAnimation is paid-only and cannot be caller-controlled PATCH field', () => {
    const invalids: unknown[] = [
      { version: 1, attention: { animation: 'pulse', paidAnimation: 'pulse' } },
      { version: 1, attention: { animation: 'none', paidAnimation: 'none' } },
      { version: 1, attention: { animation: 'glow', unexpected: true } },
      { version: 1, attention: [] },
      { version: 1, attention: { get animation() { throw Error('getter') } } },
    ]
    for (const value of invalids) expect(parseAppearanceV2(value)).toBeNull()
  })
})
