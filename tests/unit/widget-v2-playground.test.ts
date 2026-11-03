/// <reference types="bun-types" />
/**
 * Independent reviewer-owned Feature 12 Playground contract.
 * Playground is LOCAL-ONLY simulation, never a production config PATCH,
 * public widget embed, message POST, subscription bypass, or stored V2 change.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { COLOR_PALETTES } from '../../src/lib/widget/color-palettes'
import { POSITIONING_ANCHORS } from '../../src/lib/widget/positioning-geometry'
import {
  getPlaygroundCapabilities,
  createPlaygroundDraft,
  sanitizePlaygroundDraft,
  type PlaygroundDraft,
} from '../../src/lib/widget/playground-policy'

const free = getEntitlements('free')!
const pro = getEntitlements('pro')!
const max = getEntitlements('max')!
const self = getEntitlements('self-hosted')!

const effective = {
  defaultLocale: 'en',
  positioning: {
    desktop: { anchor: 'bottom-start' as const, offsetX: 24, offsetY: 32 },
    mobile: { anchor: 'bottom-center' as const, offsetX: -9, offsetY: 15 },
  },
  colors: { mode: 'preset' as const, presetId: 'emerald', tokens: COLOR_PALETTES.find(x => x.id === 'emerald')!.tokens },
  launcher: { shape: 'rounded' as const },
}

describe('Reviewer — Playground entitlement and initial effective snapshot', () => {
  test('Playground enabled on Free, Pro, Max and Self-hosted; unknown fails closed', () => {
    for (const e of [free, pro, max, self]) {
      expect(e.playground).toBe(true)
      expect(getPlaygroundCapabilities(e).enabled).toBe(true)
    }
    expect(getPlaygroundCapabilities(null).enabled).toBe(false)
    expect(getPlaygroundCapabilities(getEntitlements('constructor')).enabled).toBe(false)
  })
  test('All paying and Free plans can test all three canonical anchor presets', () => {
    for (const e of [free, pro, max, self]) {
      expect(getPlaygroundCapabilities(e).anchors).toEqual([...POSITIONING_ANCHORS])
    }
    expect(getPlaygroundCapabilities(null).anchors).toEqual([])
  })
  test('Palette list comes from the canonical 10-color catalog; no invented palettes', () => {
    for (const e of [free, pro, max, self]) {
      expect(getPlaygroundCapabilities(e).paletteIds).toEqual(COLOR_PALETTES.map(p => p.id))
    }
    expect(getPlaygroundCapabilities(null).paletteIds).toEqual([])
  })
  test('Free has only tab/rounded shapes; paid also offers pill; unknown offers none', () => {
    expect(getPlaygroundCapabilities(free).launcherShapes).toEqual(['tab', 'rounded'])
    for (const e of [pro, max, self]) {
      expect(getPlaygroundCapabilities(e).launcherShapes).toEqual(['tab', 'rounded', 'pill'])
    }
    expect(getPlaygroundCapabilities(null).launcherShapes).toEqual([])
  })
  test('Precise offset editing and custom accent simulation use canonical entitlements', () => {
    const basic = getPlaygroundCapabilities(free)
    expect(basic.precisePositioning).toBe(false)
    expect(basic.customColors).toBe(false)
    for (const e of [pro, max, self]) {
      const c = getPlaygroundCapabilities(e)
      expect(c.precisePositioning).toBe(true)
      expect(c.customColors).toBe(true)
    }
    expect(getPlaygroundCapabilities(null).precisePositioning).toBe(false)
    expect(getPlaygroundCapabilities(null).customColors).toBe(false)
  })
  test('Initial draft reflects actual SERVER-EFFECTIVE desktop values for paid', () => {
    const draft = createPlaygroundDraft(effective, pro, 'desktop')
    expect(draft).toEqual({
      device: 'desktop', locale: 'en',
      anchor: 'bottom-start', offsetX: 24, offsetY: 32,
      paletteId: 'emerald', shape: 'rounded', customAccent: null, open: false,
    })
  })
  test('Switching to mobile uses the effective mobile anchor and offsets', () => {
    const draft = createPlaygroundDraft(effective, pro, 'mobile')
    expect(draft.device).toBe('mobile')
    expect(draft.anchor).toBe('bottom-center')
    expect(draft.offsetX).toBe(-9)
    expect(draft.offsetY).toBe(15)
  })
  test('Free never reactivates paid-only stored offsets, even for paid-looking input', () => {
    const draft = createPlaygroundDraft(effective, free, 'desktop')
    expect(draft.offsetX).toBe(0)
    expect(draft.offsetY).toBe(0)
    expect(getPlaygroundCapabilities(free).launcherShapes).not.toContain('pill')
  })
  test('Missing or malformed baseline falls back to safe Sukhan defaults', () => {
    const draft = createPlaygroundDraft({}, free, 'desktop')
    expect(draft).toEqual({
      device: 'desktop', locale: 'fa', anchor: 'bottom-end',
      offsetX: 0, offsetY: 0, paletteId: 'sukhan',
      shape: 'tab', customAccent: null, open: false,
    })
    expect(createPlaygroundDraft({ defaultLocale: 'bad' }, pro, 'desktop').locale).toBe('fa')
  })
  test('Baseline creator and draft sanitizer cannot modify the input snapshot', () => {
    const before = structuredClone(effective)
    const draft = createPlaygroundDraft(effective, pro, 'desktop')
    const result = sanitizePlaygroundDraft({ ...draft, paletteId: 'ocean' }, pro)
    expect(result?.paletteId).toBe('ocean')
    expect(effective).toEqual(before)
    expect(createPlaygroundDraft(effective, pro, 'desktop').paletteId).toBe('emerald')
  })
})

describe('Reviewer — Playground strict local-only draft validation', () => {
  const valid = (): PlaygroundDraft => createPlaygroundDraft(effective, pro, 'desktop')
  test('Normal paid experiment with alternate palette, shape, accent and offsets is valid', () => {
    const c = valid()
    const v = { ...c, anchor: 'bottom-center', shape: 'pill', offsetX: -80, offsetY: 42, paletteId: 'midnight', customAccent: '#663399', open: true }
    expect(sanitizePlaygroundDraft(v, pro)).toEqual(v)
  })
  test('Free cannot simulate paid-only pill, nonzero precise offsets or custom accent', () => {
    const base = createPlaygroundDraft(effective, free, 'desktop')
    expect(sanitizePlaygroundDraft({ ...base, shape: 'pill' }, free)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetX: 1 }, free)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetY: -1 }, free)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, customAccent: '#123456' }, free)).toBeNull()
    expect(sanitizePlaygroundDraft(base, free)).toEqual(base)
  })
  test('Unknown entitlements cannot accept forged experiment state', () => {
    expect(sanitizePlaygroundDraft(valid(), null)).toBeNull()
    expect(sanitizePlaygroundDraft(valid(), getEntitlements('__proto__'))).toBeNull()
  })
  test('Reject arbitrary palette, shape, anchor, locale, device and malformed accents', () => {
    const base = valid()
    for (const override of [
      { paletteId: 'https://remote.test/palette.css' }, { paletteId: 'not-real' },
      { shape: 'dangerous' }, { anchor: 'top-left' },
      { locale: 'javascript:' }, { device: 'iframe' },
      { customAccent: 'red' }, { customAccent: 'url(javascript:alert(1))' },
      { customAccent: '#12345' },
    ]) expect(sanitizePlaygroundDraft({ ...base, ...override }, pro)).toBeNull()
  })
  test('Reject non-finite, fractional, out-of-bounds or incorrect offset types', () => {
    const base = valid()
    for (const offset of [NaN, Infinity, -Infinity, 1.1, 2001, -2001, '20', null]) {
      expect(sanitizePlaygroundDraft({ ...base, offsetX: offset }, pro)).toBeNull()
      expect(sanitizePlaygroundDraft({ ...base, offsetY: offset }, pro)).toBeNull()
    }
  })
  test('Only the exact local draft schema is allowed; reject unknown and missing keys', () => {
    const base = valid()
    expect(sanitizePlaygroundDraft({ ...base, plan: 'pro' }, pro)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, html: '<script>alert(1)</script>' }, pro)).toBeNull()
    const { shape: _shape, ...missing } = base
    expect(sanitizePlaygroundDraft(missing, pro)).toBeNull()
    expect(sanitizePlaygroundDraft([], pro)).toBeNull()
    expect(sanitizePlaygroundDraft(null, pro)).toBeNull()
  })
  test('Accessor-backed values and symbols are rejected without triggering getters', () => {
    let called = false
    const unsafe = { ...valid(), get paletteId() { called = true; throw Error('must never execute') } }
    expect(() => sanitizePlaygroundDraft(unsafe, pro)).not.toThrow()
    expect(sanitizePlaygroundDraft(unsafe, pro)).toBeNull()
    expect(called).toBe(false)
    expect(sanitizePlaygroundDraft({ ...valid(), [Symbol('secret')]: true }, pro)).toBeNull()
  })
  test('Accepting a draft returns a fresh value and cannot mutate the original', () => {
    const base = valid()
    const result = sanitizePlaygroundDraft(base, pro)!
    expect(result).toEqual(base)
    expect(result).not.toBe(base)
    result.paletteId = 'sunset'
    expect(base.paletteId).toBe('emerald')
  })
})
