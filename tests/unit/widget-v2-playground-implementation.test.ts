/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 12 — Widget Playground.
 *
 * Covers:
 *   - Canonical entitlement resolution (Free/Pro/Max/Self-hosted enabled;
 *     unknown/null plans fail closed with NO usable options).
 *   - Palette / anchor / launcher catalogs imported from their canonical
 *     single sources of truth (no invented duplicates).
 *   - Free versus paid capabilities (pill / precise offsets / custom accent
 *     are paid-only experiments).
 *   - Unknown-plan fail-closed behavior.
 *   - Strict sanitizer and accessor safety (no getter execution, no Symbol
 *     keys, exact schema, fresh copies).
 *   - Baseline isolation and no mutation of the input snapshot.
 *   - Valid and invalid custom accent handling.
 *   - Offset bounds and preview geometry containment.
 *   - Desktop/mobile baseline separation.
 *   - Reset behavior (component wiring restores the server baseline).
 *   - Local-only messages and no persistence (zero network calls, no
 *     browser storage, React text rendering).
 *   - Safe text rendering (no innerHTML / dangerouslySetInnerHTML).
 *   - Device and language switching (dir + greeting, no config writes).
 *   - Dashboard integration (tab + panel wiring, entitlements field).
 *   - No regression to any existing V2 customization (sibling patches,
 *     canonical parser, PATCH unrecognized-key contract).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { COLOR_PALETTES, isValidColor } from '../../src/lib/widget/color-palettes'
import {
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
  computeLauncherPosition,
  computePanelVerticalPosition,
  computePanelHorizontalPosition,
} from '../../src/lib/widget/positioning-geometry'
import { LAUNCHER_SHAPES, FREE_LAUNCHER_SHAPES, PAID_ONLY_LAUNCHER_SHAPES } from '../../src/lib/widget/launcher-types'
import {
  getPlaygroundCapabilities,
  createPlaygroundDraft,
  sanitizePlaygroundDraft,
  PLAYGROUND_DEFAULT_LOCALE,
  PLAYGROUND_DEFAULT_ANCHOR,
  PLAYGROUND_DEFAULT_PALETTE_ID,
  PLAYGROUND_DEFAULT_SHAPE,
} from '../../src/lib/widget/playground-policy'
// Cross-feature regression imports (existing V2 customization behavior).
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import { validateContextChatPatch, mergeContextChatPatch } from '../../src/lib/widget/context-chat-patch'
import { validatePositioningPatch, mergePositioningPatch, hasUnrecognizedFields } from '../../src/lib/widget/positioning-patch'
import { validateColorPatch, mergeColorPatch } from '../../src/lib/widget/color-patch'
import { validateLauncherPatch, mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'

const FREE = getEntitlements('free')!
const PRO = getEntitlements('pro')!
const MAX = getEntitlements('max')!
const SELF = getEntitlements('self-hosted')!
const UNKNOWN = getEntitlements('__unknown__')

const effective = {
  defaultLocale: 'en',
  positioning: {
    desktop: { anchor: 'bottom-start' as const, offsetX: 24, offsetY: 32 },
    mobile: { anchor: 'bottom-center' as const, offsetX: -9, offsetY: 15 },
  },
  colors: {
    mode: 'preset' as const,
    presetId: 'emerald',
    tokens: COLOR_PALETTES.find((x) => x.id === 'emerald')!.tokens,
  },
  launcher: { shape: 'rounded' as const },
}

const paidDraft = () => createPlaygroundDraft(effective, PRO, 'desktop')

describe('Developer — canonical entitlement resolution', () => {
  test('playground entitlement is enabled on every canonical plan and the resolver agrees', () => {
    for (const e of [FREE, PRO, MAX, SELF]) {
      expect(e.playground).toBe(true)
      expect(getPlaygroundCapabilities(e).enabled).toBe(true)
    }
  })
  test('null and unknown plans fail closed — no usable options at all', () => {
    for (const e of [null, UNKNOWN, getEntitlements('constructor'), getEntitlements('__proto__')]) {
      const c = getPlaygroundCapabilities(e)
      expect(c.enabled).toBe(false)
      expect(c.anchors).toEqual([])
      expect(c.paletteIds).toEqual([])
      expect(c.launcherShapes).toEqual([])
      expect(c.precisePositioning).toBe(false)
      expect(c.customColors).toBe(false)
    }
  })
  test('the playground never infers capabilities from price or isLocked alone', () => {
    // The capability resolver reads ONLY the canonical entitlement fields.
    const synthetic = {
      ...FREE,
      precisePositioning: false,
      customColors: false,
      launcherSelection: 'limited' as const,
    }
    const c = getPlaygroundCapabilities(synthetic)
    expect(c.precisePositioning).toBe(false)
    expect(c.launcherShapes).not.toContain('pill')
    // A synthetic entitlement that flips the canonical fields IS honored
    // (the fields are the source of truth — not the plan slug or price).
    const syntheticPaid = { ...synthetic, precisePositioning: true, customColors: true, launcherSelection: 'all' as const }
    const cp = getPlaygroundCapabilities(syntheticPaid)
    expect(cp.precisePositioning).toBe(true)
    expect(cp.customColors).toBe(true)
    expect(cp.launcherShapes).toContain('pill')
  })
})

describe('Developer — canonical catalogs (no invented duplicates)', () => {
  test('anchors come from POSITIONING_ANCHORS for every plan', () => {
    for (const e of [FREE, PRO, MAX, SELF]) {
      expect(getPlaygroundCapabilities(e).anchors).toEqual([...POSITIONING_ANCHORS])
    }
  })
  test('palettes come from the canonical 10-color COLOR_PALETTES catalog', () => {
    expect(COLOR_PALETTES).toHaveLength(10)
    for (const e of [FREE, PRO, MAX, SELF]) {
      expect(getPlaygroundCapabilities(e).paletteIds).toEqual(COLOR_PALETTES.map((p) => p.id))
    }
  })
  test('launcher shapes come from the canonical launcher catalog with paid-only pill', () => {
    expect(LAUNCHER_SHAPES).toEqual(['tab', 'rounded', 'pill'])
    expect(getPlaygroundCapabilities(FREE).launcherShapes).toEqual([...FREE_LAUNCHER_SHAPES])
    for (const e of [PRO, MAX, SELF]) {
      expect(getPlaygroundCapabilities(e).launcherShapes).toEqual([
        ...FREE_LAUNCHER_SHAPES,
        ...PAID_ONLY_LAUNCHER_SHAPES,
      ])
    }
  })
})

describe('Developer — Free versus paid capabilities', () => {
  test('Free: all anchors + all 10 palettes + tab/rounded, but no precise offsets or custom accent', () => {
    const c = getPlaygroundCapabilities(FREE)
    expect(c.anchors).toHaveLength(3)
    expect(c.paletteIds).toHaveLength(10)
    expect(c.launcherShapes).toEqual(['tab', 'rounded'])
    expect(c.precisePositioning).toBe(false)
    expect(c.customColors).toBe(false)
  })
  test('Paid: pill appears and precise/custom experiments unlock', () => {
    for (const e of [PRO, MAX, SELF]) {
      const c = getPlaygroundCapabilities(e)
      expect(c.launcherShapes).toContain('pill')
      expect(c.precisePositioning).toBe(true)
      expect(c.customColors).toBe(true)
    }
  })
  test('Free drafts can never carry paid-only experiments past the sanitizer', () => {
    const base = createPlaygroundDraft(effective, FREE, 'desktop')
    expect(base.offsetX).toBe(0)
    expect(base.offsetY).toBe(0)
    expect(base.customAccent).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, shape: 'pill' }, FREE)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetX: 12 }, FREE)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetY: -12 }, FREE)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, customAccent: '#663399' }, FREE)).toBeNull()
    // The plain Free draft itself remains perfectly valid.
    expect(sanitizePlaygroundDraft(base, FREE)).toEqual(base)
  })
})

describe('Developer — baseline creation and device separation', () => {
  test('paid desktop baseline reflects the server-effective values exactly', () => {
    expect(paidDraft()).toEqual({
      device: 'desktop', locale: 'en',
      anchor: 'bottom-start', offsetX: 24, offsetY: 32,
      paletteId: 'emerald', shape: 'rounded', customAccent: null, open: false,
    })
  })
  test('mobile baseline is independently derived from the mobile effective values', () => {
    const m = createPlaygroundDraft(effective, PRO, 'mobile')
    expect(m.device).toBe('mobile')
    expect(m.anchor).toBe('bottom-center')
    expect(m.offsetX).toBe(-9)
    expect(m.offsetY).toBe(15)
    // Shared appearance fields are identical across devices.
    expect(m.locale).toBe('en')
    expect(m.paletteId).toBe('emerald')
    expect(m.shape).toBe('rounded')
  })
  test('Free baseline zeroes paid-looking offsets but keeps free-allowed anchor/palette/shape', () => {
    const f = createPlaygroundDraft(effective, FREE, 'desktop')
    expect(f.anchor).toBe('bottom-start') // anchors are Free-allowed
    expect(f.paletteId).toBe('emerald') // palettes are Free-allowed
    expect(f.shape).toBe('rounded') // tab/rounded are Free-allowed
    expect(f.offsetX).toBe(0)
    expect(f.offsetY).toBe(0)
  })
  test('a paid-only stored shape never reactivates on Free (paid-looking input hardening)', () => {
    const paidPill = { ...effective, launcher: { shape: 'pill' as const } }
    expect(createPlaygroundDraft(paidPill, FREE, 'desktop').shape).toBe(PLAYGROUND_DEFAULT_SHAPE)
    expect(createPlaygroundDraft(paidPill, PRO, 'desktop').shape).toBe('pill')
  })
  test('malformed baselines fall back field-by-field to the safe Sukhan defaults', () => {
    expect(createPlaygroundDraft({}, FREE, 'desktop')).toEqual({
      device: 'desktop', locale: PLAYGROUND_DEFAULT_LOCALE,
      anchor: PLAYGROUND_DEFAULT_ANCHOR, offsetX: 0, offsetY: 0,
      paletteId: PLAYGROUND_DEFAULT_PALETTE_ID, shape: PLAYGROUND_DEFAULT_SHAPE,
      customAccent: null, open: false,
    })
    // Each malformed field individually:
    expect(createPlaygroundDraft({ defaultLocale: 'bad' }, PRO, 'desktop').locale).toBe('fa')
    expect(createPlaygroundDraft({ defaultLocale: 'fr' }, PRO, 'desktop').locale).toBe('fa')
    expect(
      createPlaygroundDraft(
        { positioning: { desktop: { anchor: 'top-left', offsetX: 5, offsetY: 5 } } },
        PRO,
        'desktop',
      ).anchor,
    ).toBe('bottom-end')
    // Out-of-bounds offsets never reach the draft even for paid plans.
    expect(
      createPlaygroundDraft(
        { positioning: { desktop: { anchor: 'bottom-start', offsetX: 99999, offsetY: -99999 } } },
        PRO,
        'desktop',
      ),
    ).toMatchObject({ anchor: 'bottom-start', offsetX: 0, offsetY: 0 })
    expect(createPlaygroundDraft({ colors: { mode: 'preset', presetId: 'not-real' } }, PRO, 'desktop').paletteId).toBe('sukhan')
    expect(createPlaygroundDraft({ launcher: { shape: 'dangerous' } }, PRO, 'desktop').shape).toBe('tab')
    expect(createPlaygroundDraft({ launcher: null, colors: null, positioning: null }, PRO, 'desktop').paletteId).toBe('sukhan')
  })
  test('custom-mode effective colors approximate to the default palette baseline', () => {
    // The draft models preset palettes + ONE optional custom accent — a
    // full custom token set is approximated by the default palette.
    const custom = { ...effective, colors: { mode: 'custom' as const, tokens: effective.colors.tokens } }
    expect(createPlaygroundDraft(custom, PRO, 'desktop').paletteId).toBe('sukhan')
    expect(createPlaygroundDraft(custom, PRO, 'desktop').customAccent).toBeNull()
  })
  test('unknown-plan baseline creation fails closed to pure defaults', () => {
    expect(createPlaygroundDraft(effective, null, 'desktop')).toEqual(createPlaygroundDraft({}, FREE, 'desktop'))
    expect(createPlaygroundDraft(effective, UNKNOWN, 'mobile').device).toBe('mobile')
    expect(createPlaygroundDraft(effective, UNKNOWN, 'mobile').anchor).toBe('bottom-end')
  })
  test('baseline creation never mutates the input snapshot', () => {
    const before = structuredClone(effective)
    createPlaygroundDraft(effective, PRO, 'desktop')
    createPlaygroundDraft(effective, FREE, 'mobile')
    createPlaygroundDraft(effective, null, 'desktop')
    expect(effective).toEqual(before)
  })
})

describe('Developer — strict sanitizer and accessor safety', () => {
  test('a fully-paid experiment with every field changed is accepted and returned fresh', () => {
    const v = {
      ...paidDraft(),
      device: 'mobile' as const,
      locale: 'fa' as const,
      anchor: 'bottom-center',
      offsetX: -80,
      offsetY: 42,
      paletteId: 'midnight',
      shape: 'pill',
      customAccent: '#663399',
      open: true,
    }
    const result = sanitizePlaygroundDraft(v, PRO)!
    expect(result).toEqual(v)
    expect(result).not.toBe(v)
  })
  test('non-enumerable extra own properties are also rejected (exact schema)', () => {
    const base = paidDraft()
    const sneaky = { ...base }
    Object.defineProperty(sneaky, 'plan', { value: 'pro', enumerable: false })
    expect(sanitizePlaygroundDraft(sneaky, PRO)).toBeNull()
  })
  test('getters on ANY field are rejected without execution (not just paletteId)', () => {
    let called = 0
    const unsafe = {
      ...paidDraft(),
      get offsetX() {
        called++
        throw Error('must never execute')
      },
    }
    expect(() => sanitizePlaygroundDraft(unsafe, PRO)).not.toThrow()
    expect(sanitizePlaygroundDraft(unsafe, PRO)).toBeNull()
    expect(called).toBe(0)
  })
  test('non-object drafts (arrays, strings, numbers, booleans) are rejected', () => {
    for (const bad of [[], 'draft', 42, true, Symbol('x')]) {
      expect(sanitizePlaygroundDraft(bad, PRO)).toBeNull()
    }
  })
  test('open must be an exact boolean — truthy/falsy values are rejected', () => {
    const base = paidDraft()
    expect(sanitizePlaygroundDraft({ ...base, open: 1 }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, open: 0 }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, open: 'true' }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, open: null }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, open: true }, PRO)?.open).toBe(true)
  })
  test('unknown entitlements reject every experiment (fail closed)', () => {
    expect(sanitizePlaygroundDraft(paidDraft(), null)).toBeNull()
    expect(sanitizePlaygroundDraft(paidDraft(), UNKNOWN)).toBeNull()
    expect(sanitizePlaygroundDraft({}, UNKNOWN)).toBeNull()
    expect(sanitizePlaygroundDraft({}, FREE)).toBeNull() // {} is not a valid draft
  })
})

describe('Developer — custom accent handling', () => {
  const base = paidDraft()
  test('valid six-digit hex accents are accepted for entitled plans', () => {
    for (const good of ['#663399', '#ABCDEF', '#0e1116', '#000000', '#FFFFFF']) {
      expect(sanitizePlaygroundDraft({ ...base, customAccent: good }, PRO)?.customAccent).toBe(good)
    }
  })
  test('malformed accents are rejected (length, characters, schemes, functions)', () => {
    for (const bad of [
      'red', '#12345', '#1234567', '#GGGGGG', 'rgb(1,2,3)',
      'url(javascript:alert(1))', 'javascript:alert(1)', 'expression(alert(1))',
      '#12345\n', 66, { hex: true }, ['663399'],
    ]) {
      expect(sanitizePlaygroundDraft({ ...base, customAccent: bad as unknown as string }, PRO)).toBeNull()
    }
  })
  test('custom accents use the canonical isValidColor validator', () => {
    expect(isValidColor('#663399')).toBe(true)
    expect(isValidColor('#12345')).toBe(false)
  })
  test('a null accent is valid for both free and paid plans', () => {
    expect(sanitizePlaygroundDraft({ ...base, customAccent: null }, PRO)?.customAccent).toBeNull()
    expect(sanitizePlaygroundDraft(createPlaygroundDraft(effective, FREE, 'desktop'), FREE)?.customAccent).toBeNull()
  })
})

describe('Developer — offset bounds and preview geometry', () => {
  const base = paidDraft()
  test('extreme legal offsets are accepted and illegal ones rejected', () => {
    expect(sanitizePlaygroundDraft({ ...base, offsetX: OFFSET_MAX, offsetY: OFFSET_MIN }, PRO)).toMatchObject({
      offsetX: 2000,
      offsetY: -2000,
    })
    expect(sanitizePlaygroundDraft({ ...base, offsetX: OFFSET_MAX + 1 }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetY: OFFSET_MIN - 1 }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetX: 0.5 }, PRO)).toBeNull()
    expect(sanitizePlaygroundDraft({ ...base, offsetY: Number.EPSILON }, PRO)).toBeNull()
  })
  test('the preview launcher stays inside the surface even for max paid offsets (both devices, both dirs)', () => {
    // Mirror the component's bounded simulation constants.
    const SURFACE = { desktop: { w: 640, h: 460 }, mobile: { w: 360, h: 560 } }
    for (const device of ['desktop', 'mobile'] as const) {
      const surface = SURFACE[device]
      for (const dir of ['rtl', 'ltr'] as const) {
        for (const anchor of POSITIONING_ANCHORS) {
          for (const [ox, oy] of [[0, 0], [OFFSET_MAX, OFFSET_MAX], [OFFSET_MIN, OFFSET_MIN], [OFFSET_MAX, OFFSET_MIN], [OFFSET_MIN, OFFSET_MAX]]) {
            for (const shape of ['tab', 'rounded', 'pill'] as const) {
              const dims = shape === 'tab' ? { w: 60, h: 52 } : shape === 'pill' ? { w: 64, h: 48 } : { w: 52, h: 52 }
              const pos = computeLauncherPosition({
                anchor,
                offsetX: ox,
                offsetY: oy,
                dir,
                viewportWidth: surface.w,
                viewportHeight: surface.h,
                launcherWidth: dims.w,
                launcherHeight: dims.h,
                safeAreaBottom: 22, // Free branding strip reservation
                baseMargin: 20,
              })
              expect(pos.left).toBeGreaterThanOrEqual(0)
              expect(pos.left).toBeLessThanOrEqual(surface.w - dims.w)
              expect(pos.bottom).toBeGreaterThanOrEqual(22)
              expect(pos.bottom).toBeLessThanOrEqual(surface.h - dims.h)
            }
          }
        }
      }
    }
  })
  test('the simulated chat panel stays inside the surface for the same geometry sweep', () => {
    const SURFACE = { desktop: { w: 640, h: 460 }, mobile: { w: 360, h: 560 } }
    const PREF = { desktop: { w: 340, h: 360 }, mobile: { w: 300, h: 420 } }
    for (const device of ['desktop', 'mobile'] as const) {
      const surface = SURFACE[device]
      const pref = PREF[device]
      for (const anchor of POSITIONING_ANCHORS) {
        const dims = { w: 60, h: 52 }
        const lp = computeLauncherPosition({
          anchor,
          offsetX: 0,
          offsetY: 0,
          dir: 'rtl',
          viewportWidth: surface.w,
          viewportHeight: surface.h,
          launcherWidth: dims.w,
          launcherHeight: dims.h,
          safeAreaBottom: 0,
          baseMargin: 20,
        })
        const pv = computePanelVerticalPosition({
          rootBottom: lp.bottom,
          launcherHeight: dims.h,
          viewportHeight: surface.h,
          panelGap: 12,
          panelPreferredHeight: pref.h,
          safeAreaBottom: 0,
        })
        const ph = computePanelHorizontalPosition({
          launcherLeft: lp.left,
          launcherWidth: dims.w,
          panelPreferredWidth: pref.w,
          viewportWidth: surface.w,
          panelSide: lp.panelSide,
          viewportMargin: 20,
        })
        const panelLeft = lp.left + ph.left
        const panelBottom = lp.bottom + pv.bottom
        expect(panelLeft).toBeGreaterThanOrEqual(0)
        expect(panelLeft + ph.width).toBeLessThanOrEqual(surface.w)
        expect(panelBottom).toBeGreaterThanOrEqual(-1) // may open below the launcher but never below the surface
        expect(panelBottom + Math.min(pref.h, pv.maxHeight)).toBeLessThanOrEqual(surface.h + 1)
      }
    }
  })
})

describe('Developer — dashboard integration (source wiring)', () => {
  const panelSrc = readFileSync(join(process.cwd(), 'src/components/dashboard/views/widget-panel.tsx'), 'utf8')
  const playgroundSrc = readFileSync(join(process.cwd(), 'src/components/dashboard/views/widget-playground.tsx'), 'utf8')
  const configRouteSrc = readFileSync(join(process.cwd(), 'src/app/api/widget-config/route.ts'), 'utf8')

  // Strip block comments + full-line // comments so NEGATIVE assertions
  // ("never fetches", "never innerHTML", "never storage") inspect CODE,
  // not prose inside documentation comments.
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const playgroundCode = code(playgroundSrc)

  test('widget-panel exposes the accessible playground tab and mounts the panel with server data', () => {
    expect(panelSrc).toContain(`data-testid="playground-tab"`)
    expect(panelSrc).toContain("{tab === 'playground' && config && (")
    expect(panelSrc).toContain('<WidgetPlaygroundPanel')
    // The panel receives ONLY already-authenticated GET data — no fetch props.
    expect(panelSrc).toContain('playground={playground}')
    expect(panelSrc).toContain('positioning={positioning}')
    expect(panelSrc).toContain('colors={colors}')
    expect(panelSrc).toContain('launcher={launcher}')
    // Existing tabs are preserved.
    expect(panelSrc).toContain(`setTab('installation')`)
    expect(panelSrc).toContain(`setTab('customization')`)
    expect(panelSrc).toContain(`setTab('access')`)
  })
  test('the playground panel renders every required data-testid selector', () => {
    for (const id of [
      'playground-panel', 'playground-not-live', 'playground-surface',
      'playground-device-desktop', 'playground-device-mobile',
      'playground-locale-fa', 'playground-locale-en',
      'playground-anchor', 'playground-palette', 'playground-shape',
      'playground-offset-x', 'playground-offset-y', 'playground-custom-accent',
      'playground-launcher', 'playground-chat', 'playground-greeting',
      'playground-message-input', 'playground-send', 'playground-message',
      'playground-reset', 'playground-branding',
    ]) {
      expect(playgroundSrc).toContain(`data-testid="${id}"`)
    }
  })
  test('the surface exposes the diagnostic attributes and dir', () => {
    expect(playgroundSrc).toContain('data-playground-device={view.device}')
    expect(playgroundSrc).toContain('data-playground-palette={view.paletteId}')
    expect(playgroundSrc).toContain('data-playground-shape={view.shape}')
    expect(playgroundSrc).toContain('data-playground-custom-accent={view.customAccent ?? undefined}')
    expect(playgroundSrc).toContain('dir={dir}')
  })
  test('GET /api/widget-config exposes the playground entitlements field additively', () => {
    expect(configRouteSrc).toContain('playground: {')
    expect(configRouteSrc).toContain('entitlements: { enabled: playgroundEntitlementEnabled }')
    expect(configRouteSrc).toContain('entitlements?.playground === true')
    expect(configRouteSrc).toContain('playground: result.result.playground')
  })
  test('the playground component makes ZERO network calls (no fetch/axios/XHR)', () => {
    expect(playgroundCode).not.toContain('fetch(')
    expect(playgroundCode).not.toContain('XMLHttpRequest')
    expect(playgroundCode).not.toContain('/api/')
  })
  test('the playground component never touches browser storage', () => {
    expect(playgroundCode).not.toContain('localStorage')
    expect(playgroundCode).not.toContain('sessionStorage')
    expect(playgroundCode).not.toContain('document.cookie')
  })
  test('the playground component renders text safely (no innerHTML/dangerouslySetInnerHTML)', () => {
    expect(playgroundCode).not.toContain('innerHTML')
    expect(playgroundCode).not.toContain('dangerouslySetInnerHTML')
    // Simulated messages render as React text children.
    expect(playgroundSrc).toMatch(/\{messages\.map\(\(m, i\) =>/)
  })
  test('the playground component is wired through the strict policy module', () => {
    expect(playgroundSrc).toContain('getPlaygroundCapabilities(')
    expect(playgroundSrc).toContain('createPlaygroundDraft(')
    expect(playgroundSrc).toContain('sanitizePlaygroundDraft(')
  })
  test('native controls are used for automation-friendly selects/inputs', () => {
    expect(playgroundSrc).toContain('<select')
    expect(playgroundSrc).toContain('type="number"')
    expect(playgroundSrc).toContain('type="text"')
  })
  test('reset restores the server-effective baseline and clears the local transcript', () => {
    expect(playgroundSrc).toContain('data-testid="playground-reset"')
    expect(playgroundSrc).toContain('setMessages([])')
    expect(playgroundSrc).toContain('setOpen(false)')
    expect(playgroundSrc).toContain("createPlaygroundDraft(baselineSnapshot, entitlements, 'desktop')")
    expect(playgroundSrc).toContain("createPlaygroundDraft(baselineSnapshot, entitlements, 'mobile')")
  })
  test('paid-only controls are disabled from the canonical capabilities', () => {
    expect(playgroundSrc).toContain('disabled={!caps.precisePositioning}')
    expect(playgroundSrc).toContain('disabled={!caps.customColors}')
  })
})

describe('Developer — no regression to existing V2 customization', () => {
  test('the canonical appearanceV2 parser still accepts every sibling key (incl. contextChat)', () => {
    const v2 = parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-start', offsetX: 4, offsetY: 5 } },
      mobile: { positioning: { anchor: 'bottom-center' } },
      colors: { mode: 'preset', presetId: 'emerald' },
      launcher: { shape: 'rounded' },
      attention: { animation: 'pulse' },
      messagePreview: { enabled: true },
      quickReplies: { items: ['Hi'] },
      preChatForm: { fields: [{ key: 'name', required: true }] },
      pageVisibility: { rules: [{ pattern: '/a', match: 'exact', action: 'show' }] },
      alternativeContactButtons: { items: [{ kind: 'email', label: 'Mail', value: 'a@b.c' }] },
      smartAvoidance: { enabled: true },
      contextChat: { enabled: true },
    })
    expect(v2).not.toBeNull()
    expect(v2?.contextChat).toEqual({ enabled: true })
  })
  test('PATCH never recognizes a playground key (unrecognized contract preserved)', () => {
    // A playground key mixed into a recognized PATCH is still unrecognized…
    expect(hasUnrecognizedFields({ positioning: {}, playground: { enabled: true } })).toBe(true)
    // …and the playground is NOT a recognized PATCH field.
    expect(hasUnrecognizedFields({ playground: { enabled: true } })).toBe(true)
  })
  test('sibling patch validators + mergers still behave (contextChat/positioning/colors/launcher)', () => {
    const cc = validateContextChatPatch({ contextChat: { enabled: true } }, PRO)
    expect(cc.ok).toBe(true)
    if (cc.ok) {
      const merged = mergeContextChatPatch(null, cc.data, PRO)
      expect(merged).toMatchObject({ version: 1, contextChat: { enabled: true } })
    }
    const pos = validatePositioningPatch(
      { positioning: { desktop: { anchor: 'bottom-start', offsetX: 10, offsetY: 10 } } },
      PRO,
    )
    expect(pos.ok).toBe(true)
    if (pos.ok) {
      const base = { version: 1 as const, contextChat: { enabled: true } }
      const merged = mergePositioningPatch(base, pos.data, null)
      // True-patch preservation: editing positioning keeps contextChat.
      expect(merged).toMatchObject({ contextChat: { enabled: true } })
    }
    const col = validateColorPatch({ colors: { mode: 'preset', presetId: 'ocean' } }, PRO)
    expect(col.ok).toBe(true)
    if (col.ok) expect(mergeColorPatch(null, col.data)).toMatchObject({ version: 1, colors: { mode: 'preset', presetId: 'ocean' } })
    const lau = validateLauncherPatch({ launcher: { shape: 'pill' } }, PRO)
    expect(lau.ok).toBe(true)
    if (lau.ok) expect(mergeLauncherPatch(null, lau.data, PRO)).toMatchObject({ version: 1, launcher: { shape: 'pill' } })
  })
  test('the playground never persists into appearanceV2 (no merge/patch module exists for it)', () => {
    // The appearanceV2 contract has no playground key — the playground is a
    // local-only simulation and MUST NOT introduce a persisted key.
    const v2 = parseAppearanceV2({ version: 1, playground: { enabled: true } })
    expect((v2 as unknown as Record<string, unknown> | null)?.playground).toBeUndefined()
  })
})
