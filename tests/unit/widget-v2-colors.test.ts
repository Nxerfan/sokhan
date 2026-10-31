/// <reference types="bun-types" />
/**
 * Widget V2 Color Customization — unit tests.
 *
 * Tests the pure TS color modules (no DB, no browser):
 *   - src/lib/widget/color-palettes.ts (10 palettes, ColorTokens, validation, contrast)
 *   - src/lib/widget/appearance-v2.ts (strict parser with `colors?: ColorTheme` field)
 *   - src/lib/widget/effective-colors.ts (effective resolver + entitlement enforcement)
 *   - src/lib/widget/color-patch.ts (PATCH validation + true-patch merge)
 *   - src/lib/payments/widget-entitlements.ts (plan entitlements: presetColors / customColors)
 */

import { test, expect, describe } from 'bun:test'
import {
  COLOR_PALETTES,
  DEFAULT_PALETTE_ID,
  DEFAULT_COLOR_TOKENS,
  PALETTE_IDS,
  COLOR_TOKEN_NAMES,
  getPaletteById,
  isValidPaletteId,
  isValidColor,
  isValidCustomColors,
  contrastRatio,
  meetsContrastAA,
  type ColorTokens,
} from '../../src/lib/widget/color-palettes'
import {
  parseAppearanceV2,
  type AppearanceV2,
} from '../../src/lib/widget/appearance-v2'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import {
  resolveEffectiveColors,
  getStoredColorTheme,
  DEFAULT_EFFECTIVE_COLORS,
  type StoredColorInput,
} from '../../src/lib/widget/effective-colors'
import {
  validateColorPatch,
  mergeColorPatch,
  hasColorField,
} from '../../src/lib/widget/color-patch'

// ─── Test fixtures ────────────────────────────────────────────────────────

/** A complete, valid set of custom color tokens (all 11, all #RRGGBB). */
const VALID_CUSTOM_TOKENS: ColorTokens = {
  accent: '#FF5733',
  launcherBg: '#1A1A2E',
  launcherFg: '#FFFFFF',
  headerBg: '#FF5733',
  headerText: '#FFFFFF',
  panelBg: '#F8F9FA',
  panelText: '#1A1A2E',
  visitorBubbleBg: '#E9ECEF',
  visitorBubbleText: '#1A1A2E',
  agentBubbleBg: '#FF5733',
  agentBubbleText: '#FFFFFF',
}

// ─── Palette catalog tests ───────────────────────────────────────────────

describe('Palette catalog — COLOR_PALETTES', () => {
  test('exactly 10 palettes', () => {
    expect(COLOR_PALETTES.length).toBe(10)
  })

  test('each palette has a stable ID', () => {
    for (const p of COLOR_PALETTES) {
      expect(typeof p.id).toBe('string')
      expect(p.id.length).toBeGreaterThan(0)
    }
  })

  test('all palette IDs are unique', () => {
    const ids = COLOR_PALETTES.map((p) => p.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(COLOR_PALETTES.length)
  })

  test('default palette is sukhan', () => {
    expect(DEFAULT_PALETTE_ID).toBe('sukhan')
    expect(COLOR_PALETTES[0].id).toBe('sukhan')
    expect(DEFAULT_COLOR_TOKENS).toEqual(COLOR_PALETTES[0].tokens)
  })

  test('each palette has all 11 color tokens', () => {
    expect(COLOR_TOKEN_NAMES.length).toBe(11)
    for (const p of COLOR_PALETTES) {
      for (const name of COLOR_TOKEN_NAMES) {
        expect(p.tokens).toHaveProperty(name)
        expect(typeof p.tokens[name]).toBe('string')
      }
    }
  })

  test('all colors are valid #RRGGBB', () => {
    for (const p of COLOR_PALETTES) {
      for (const name of COLOR_TOKEN_NAMES) {
        expect(isValidColor(p.tokens[name])).toBe(true)
      }
    }
  })

  test('isValidPaletteId accepts valid IDs, rejects invalid ones', () => {
    // accepts all canonical IDs
    for (const id of PALETTE_IDS) {
      expect(isValidPaletteId(id)).toBe(true)
    }
    // rejects invalid / non-strings
    expect(isValidPaletteId('not-a-palette')).toBe(false)
    expect(isValidPaletteId('')).toBe(false)
    expect(isValidPaletteId('SUKHAN')).toBe(false) // case-sensitive
    expect(isValidPaletteId(null)).toBe(false)
    expect(isValidPaletteId(undefined)).toBe(false)
    expect(isValidPaletteId(123)).toBe(false)
    expect(isValidPaletteId({})).toBe(false)
    expect(isValidPaletteId([])).toBe(false)
  })

  test('getPaletteById returns the palette or null', () => {
    const sukhan = getPaletteById('sukhan')
    expect(sukhan).not.toBeNull()
    expect(sukhan?.id).toBe('sukhan')
    expect(sukhan?.tokens).toBeDefined()
    const midnight = getPaletteById('midnight')
    expect(midnight).not.toBeNull()
    expect(midnight?.id).toBe('midnight')
    // unknown IDs return null
    expect(getPaletteById('nonexistent')).toBeNull()
    expect(getPaletteById('')).toBeNull()
  })
})

// ─── Color validation tests ──────────────────────────────────────────────

describe('Color validation — isValidColor', () => {
  test('accepts #RRGGBB; rejects #RGB, named, rgba, non-strings, undefined, null', () => {
    // valid #RRGGBB (mixed case)
    expect(isValidColor('#FFFFFF')).toBe(true)
    expect(isValidColor('#000000')).toBe(true)
    expect(isValidColor('#E09A2B')).toBe(true)
    expect(isValidColor('#abcdef')).toBe(true)
    expect(isValidColor('#ABCDEF')).toBe(true)
    expect(isValidColor('#012345')).toBe(true)
    // rejects #RGB shorthand
    expect(isValidColor('#FFF')).toBe(false)
    expect(isValidColor('#000')).toBe(false)
    expect(isValidColor('#AbC')).toBe(false)
    // rejects named colors
    expect(isValidColor('red')).toBe(false)
    expect(isValidColor('white')).toBe(false)
    expect(isValidColor('blue')).toBe(false)
    expect(isValidColor('transparent')).toBe(false)
    expect(isValidColor('currentColor')).toBe(false)
    // rejects rgba / hsl / rgb
    expect(isValidColor('rgba(255,0,0,1)')).toBe(false)
    expect(isValidColor('rgb(255,0,0)')).toBe(false)
    expect(isValidColor('hsl(0,100%,50%)')).toBe(false)
    expect(isValidColor('hsla(0,100%,50%,0.5)')).toBe(false)
    // rejects non-strings
    expect(isValidColor(123)).toBe(false)
    expect(isValidColor(true)).toBe(false)
    expect(isValidColor(false)).toBe(false)
    expect(isValidColor({})).toBe(false)
    expect(isValidColor([])).toBe(false)
    expect(isValidColor({ color: '#FFFFFF' })).toBe(false)
    // rejects undefined / null
    expect(isValidColor(undefined)).toBe(false)
    expect(isValidColor(null)).toBe(false)
    // rejects wrong length / format
    expect(isValidColor('#FFFFF')).toBe(false) // 5 hex digits
    expect(isValidColor('#FFFFFFF')).toBe(false) // 7 hex digits
    expect(isValidColor('#')).toBe(false)
    expect(isValidColor('FFFFFF')).toBe(false) // missing #
    expect(isValidColor('#GGGGGG')).toBe(false) // non-hex chars
    expect(isValidColor('#FF FF FF')).toBe(false) // spaces
    expect(isValidColor('#ffffff ')).toBe(false) // trailing space
  })
})

describe('Color validation — isValidCustomColors', () => {
  test('accepts complete valid tokens; rejects missing tokens, invalid colors, extra keys', () => {
    // accepts complete valid tokens
    expect(isValidCustomColors(VALID_CUSTOM_TOKENS)).toBe(true)
    // rejects missing tokens
    expect(isValidCustomColors({ ...VALID_CUSTOM_TOKENS, accent: undefined })).toBe(false)
    expect(isValidCustomColors({ accent: '#FFFFFF' })).toBe(false)
    expect(isValidCustomColors({})).toBe(false)
    // rejects invalid colors within tokens
    expect(isValidCustomColors({ ...VALID_CUSTOM_TOKENS, accent: '#FFF' })).toBe(false)
    expect(isValidCustomColors({ ...VALID_CUSTOM_TOKENS, accent: 'red' })).toBe(false)
    expect(isValidCustomColors({ ...VALID_CUSTOM_TOKENS, accent: null })).toBe(false)
    expect(isValidCustomColors({ ...VALID_CUSTOM_TOKENS, accent: 'rgba(0,0,0,1)' })).toBe(false)
    // rejects non-objects
    expect(isValidCustomColors(null)).toBe(false)
    expect(isValidCustomColors(undefined)).toBe(false)
    expect(isValidCustomColors('string')).toBe(false)
    expect(isValidCustomColors(123)).toBe(false)
    expect(isValidCustomColors([])).toBe(false)
    // rejects extra keys (the helper must reject token sets with unknown keys
    // so the validator stays a complete gatekeeper — verified by strict equality
    // of the token set against the 11 canonical names)
    const withExtra = { ...VALID_CUSTOM_TOKENS, evil: '#000000' }
    expect(isValidCustomColors(withExtra)).toBe(false)
  })
})

describe('Color contrast — contrastRatio', () => {
  test('returns correct values (white/black = 21, same color = 1)', () => {
    // max contrast: white on black = 21:1
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    // symmetric: black on white = 21:1
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    // same color = 1:1 (no contrast)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1)
    expect(contrastRatio('#000000', '#000000')).toBe(1)
    expect(contrastRatio('#E09A2B', '#E09A2B')).toBe(1)
    // ratio is always >= 1
    expect(contrastRatio('#808080', '#FFFFFF')).toBeGreaterThanOrEqual(1)
    expect(contrastRatio('#808080', '#FFFFFF')).toBeLessThanOrEqual(21)
  })
})

describe('Color contrast — meetsContrastAA', () => {
  test('correctly identifies WCAG AA pass/fail', () => {
    // black on white: 21:1 → passes AA (normal + large)
    expect(meetsContrastAA('#000000', '#FFFFFF')).toBe(true)
    expect(meetsContrastAA('#000000', '#FFFFFF', true)).toBe(true)
    // white on black: same
    expect(meetsContrastAA('#FFFFFF', '#000000')).toBe(true)
    // same color: 1:1 → fails AA
    expect(meetsContrastAA('#000000', '#000000')).toBe(false)
    expect(meetsContrastAA('#FFFFFF', '#FFFFFF')).toBe(false)
    // gray (#808080) on white ≈ 3.95:1 → fails normal (≥4.5), passes large (≥3)
    expect(meetsContrastAA('#808080', '#FFFFFF')).toBe(false)
    expect(meetsContrastAA('#808080', '#FFFFFF', true)).toBe(true)
    // high-contrast pair passes both
    expect(meetsContrastAA('#1A1A2E', '#FFFFFF')).toBe(true)
    expect(meetsContrastAA('#1A1A2E', '#FFFFFF', true)).toBe(true)
  })
})

// ─── V2 parser tests (colors) ────────────────────────────────────────────

describe('Appearance V2 parser — colors field', () => {
  test('valid: version 1 + colors with preset mode + valid presetId', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset', presetId: 'sukhan' },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.colors?.mode).toBe('preset')
    expect(parsed!.colors?.presetId).toBe('sukhan')
    expect(parsed!.colors?.custom).toBeUndefined()
  })

  test('valid: version 1 + colors with custom mode + all 11 valid tokens', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.colors?.mode).toBe('custom')
    expect(parsed!.colors?.custom).toEqual(VALID_CUSTOM_TOKENS)
    expect(parsed!.colors?.presetId).toBeUndefined()
  })

  test('rejects: invalid palette ID', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset', presetId: 'not-a-palette' },
    })).toBeNull()
  })

  test('rejects: custom mode without custom tokens', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom' },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: null },
    })).toBeNull()
  })

  test('rejects: preset mode without presetId', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset' },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset', presetId: null },
    })).toBeNull()
  })

  test('rejects: invalid mode (not preset or custom)', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'automatic' },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'PRESET' },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 123 },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: null },
    })).toBeNull()
  })

  test('rejects: invalid color format (#RGB, named, rgba)', () => {
    // #RGB shorthand in one token
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, accent: '#FFF' } },
    })).toBeNull()
    // named color
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, accent: 'red' } },
    })).toBeNull()
    // rgba
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, accent: 'rgba(0,0,0,1)' } },
    })).toBeNull()
    // missing # prefix
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, accent: 'FFFFFF' } },
    })).toBeNull()
  })

  test('rejects: missing color tokens in custom mode', () => {
    // only 1 of 11 tokens
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { accent: '#FFFFFF' } },
    })).toBeNull()
    // 10 of 11 tokens (missing one)
    const incomplete = { ...VALID_CUSTOM_TOKENS }
    delete (incomplete as Record<string, string>).agentBubbleText
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: incomplete },
    })).toBeNull()
  })

  test('rejects: unexpected keys in colors object', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset', presetId: 'sukhan', evil: true },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'preset', presetId: 'sukhan', extra: '#000000' },
    })).toBeNull()
  })

  test('rejects: unexpected keys in custom tokens', () => {
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, evil: '#000000' } },
    })).toBeNull()
    expect(parseAppearanceV2({
      version: 1,
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, extraToken: '#FFFFFF' } },
    })).toBeNull()
  })

  test('preserves positioning when colors are present (both in same AppearanceV2)', () => {
    const parsed = parseAppearanceV2({
      version: 1,
      desktop: { positioning: { anchor: 'bottom-center', offsetX: 100 } },
      mobile: { positioning: { anchor: 'bottom-start' } },
      colors: { mode: 'preset', presetId: 'sukhan' },
    })
    expect(parsed).not.toBeNull()
    // positioning preserved on both devices
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-center')
    expect(parsed!.desktop?.positioning?.offsetX).toBe(100)
    expect(parsed!.mobile?.positioning?.anchor).toBe('bottom-start')
    // colors present + valid
    expect(parsed!.colors?.mode).toBe('preset')
    expect(parsed!.colors?.presetId).toBe('sukhan')
  })
})

// ─── Effective color resolver tests ──────────────────────────────────────

describe('Effective color resolver — resolveEffectiveColors', () => {
  const freeEnt = getEntitlements('free')
  const proEnt = getEntitlements('pro')

  test('Free + preset palette → palette tokens applied', () => {
    const stored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'preset', presetId: 'midnight' } },
    }
    const eff = resolveEffectiveColors(stored, freeEnt)
    expect(eff.mode).toBe('preset')
    expect(eff.presetId).toBe('midnight')
    const palette = getPaletteById('midnight')
    expect(eff.tokens).toEqual(palette!.tokens)
  })

  test('Pro + preset palette → palette tokens applied', () => {
    const stored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'preset', presetId: 'emerald' } },
    }
    const eff = resolveEffectiveColors(stored, proEnt)
    expect(eff.mode).toBe('preset')
    expect(eff.presetId).toBe('emerald')
    const palette = getPaletteById('emerald')
    expect(eff.tokens).toEqual(palette!.tokens)
  })

  test('Pro + custom colors → custom tokens applied', () => {
    const stored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS } },
    }
    const eff = resolveEffectiveColors(stored, proEnt)
    expect(eff.mode).toBe('custom')
    expect(eff.tokens).toEqual(VALID_CUSTOM_TOKENS)
  })

  test('Free + custom colors stored → custom NOT applied (fallback to default), but stored preserved', () => {
    const stored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS } },
    }
    // Free effective: custom NOT applied → falls back to default Sukhan palette
    const eff = resolveEffectiveColors(stored, freeEnt)
    expect(eff.mode).toBe('preset')
    expect(eff.presetId).toBe(DEFAULT_PALETTE_ID)
    expect(eff.tokens).toEqual(DEFAULT_EFFECTIVE_COLORS.tokens)
    // But the stored custom theme is preserved (accessible for dashboard display + upgrade restore)
    const storedTheme = getStoredColorTheme(stored)
    expect(storedTheme).not.toBeNull()
    expect(storedTheme!.mode).toBe('custom')
    expect(storedTheme!.custom).toEqual(VALID_CUSTOM_TOKENS)
  })

  test('Unknown plan (null entitlements) → fail closed to defaults', () => {
    const stored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS } },
    }
    const eff = resolveEffectiveColors(stored, null)
    expect(eff.mode).toBe('preset')
    expect(eff.presetId).toBe(DEFAULT_PALETTE_ID)
    expect(eff.tokens).toEqual(DEFAULT_EFFECTIVE_COLORS.tokens)
  })

  test('No V2 colors + V1 accentColor → derive from accent', () => {
    const stored: StoredColorInput = {
      accentColor: '#AABBCC',
      appearanceV2: { version: 1, desktop: {} },
    }
    const eff = resolveEffectiveColors(stored, freeEnt)
    expect(eff.mode).toBe('preset')
    // Derived: default tokens with accent/headerBg/agentBubbleBg replaced
    expect(eff.tokens.accent).toBe('#AABBCC')
    expect(eff.tokens.headerBg).toBe('#AABBCC')
    expect(eff.tokens.agentBubbleBg).toBe('#AABBCC')
    // Other tokens stay default
    expect(eff.tokens.launcherBg).toEqual(DEFAULT_COLOR_TOKENS.launcherBg)
    expect(eff.tokens.panelBg).toEqual(DEFAULT_COLOR_TOKENS.panelBg)
  })

  test('No V2 + no V1 → default Sukhan palette', () => {
    const stored: StoredColorInput = {
      accentColor: null,
      appearanceV2: null,
    }
    const eff = resolveEffectiveColors(stored, freeEnt)
    expect(eff.mode).toBe('preset')
    expect(eff.presetId).toBe(DEFAULT_PALETTE_ID)
    expect(eff.tokens).toEqual(DEFAULT_COLOR_TOKENS)
    // also verify against DEFAULT_EFFECTIVE_COLORS
    expect(eff).toEqual(DEFAULT_EFFECTIVE_COLORS)
  })

  test('Malformed V2 → V1 fallback', () => {
    const stored: StoredColorInput = {
      accentColor: '#ABCDEF',
      appearanceV2: { version: 999 }, // unknown version → parser returns null
    }
    const eff = resolveEffectiveColors(stored, proEnt)
    // V2 malformed → fall back to V1 accentColor derivation
    expect(eff.tokens.accent).toBe('#ABCDEF')
    expect(eff.tokens.headerBg).toBe('#ABCDEF')
    expect(eff.tokens.agentBubbleBg).toBe('#ABCDEF')
  })

  test('Downgrade/upgrade: Free edits preset, paid custom tokens preserved in storage', () => {
    // 1. Pro saves custom colors
    const proStored: StoredColorInput = {
      appearanceV2: { version: 1, colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS } },
    }
    const proEff = resolveEffectiveColors(proStored, proEnt)
    expect(proEff.mode).toBe('custom')
    expect(proEff.tokens).toEqual(VALID_CUSTOM_TOKENS)

    // 2. Downgrade to Free; Free edits preset (allowed for Free)
    const freePatch = validateColorPatch(
      { colors: { mode: 'preset', presetId: 'sukhan' } },
      freeEnt,
    )
    expect(freePatch.ok).toBe(true)
    if (freePatch.ok) {
      const merged = mergeColorPatch(proStored.appearanceV2, freePatch.data)
      const downgradedStored: StoredColorInput = { appearanceV2: merged }

      // 3. Free effective: preset applied (custom NOT applied)
      const freeEff = resolveEffectiveColors(downgradedStored, freeEnt)
      expect(freeEff.mode).toBe('preset')
      expect(freeEff.presetId).toBe('sukhan')

      // 4. Paid custom tokens preserved in storage (per documented contract —
      //    mergeColorPatch JSDoc: "Paid custom tokens are preserved when Free
      //    edits the preset"). Verified via getStoredColorTheme.
      const storedTheme = getStoredColorTheme(downgradedStored)
      expect(storedTheme?.custom).toEqual(VALID_CUSTOM_TOKENS)

      // 5. Upgrade back to Pro: preset is still applied (mode was set to
      //    'preset' during Free period). Custom tokens are PRESERVED in
      //    storage — the user can switch back to custom mode to restore.
      const proEff2 = resolveEffectiveColors(downgradedStored, proEnt)
      expect(proEff2.mode).toBe('preset') // mode unchanged from Free edit
      expect(proEff2.presetId).toBe('sukhan')
      // Custom tokens are preserved in storage (available for restore).
      expect(storedTheme?.custom).toEqual(VALID_CUSTOM_TOKENS)
    }
  })
})

// ─── Color PATCH validation tests ────────────────────────────────────────

describe('Color PATCH validation — validateColorPatch', () => {
  const freeEnt = getEntitlements('free')
  const proEnt = getEntitlements('pro')

  test('Free: valid preset save → ok', () => {
    const result = validateColorPatch({
      colors: { mode: 'preset', presetId: 'sukhan' },
    }, freeEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.theme.mode).toBe('preset')
      expect(result.data.theme.presetId).toBe('sukhan')
    }
  })

  test('Free: custom tokens → rejected (colors_custom_not_allowed)', () => {
    const result = validateColorPatch({
      colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS },
    }, freeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_custom_not_allowed')
  })

  test('Free: invalid palette ID → rejected', () => {
    const result = validateColorPatch({
      colors: { mode: 'preset', presetId: 'not-a-palette' },
    }, freeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_preset_id_invalid')
  })

  test('Free: missing mode → rejected', () => {
    const result = validateColorPatch({
      colors: { presetId: 'sukhan' },
    }, freeEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_mode_missing')
  })

  test('Pro: valid preset save → ok', () => {
    const result = validateColorPatch({
      colors: { mode: 'preset', presetId: 'midnight' },
    }, proEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.theme.mode).toBe('preset')
      expect(result.data.theme.presetId).toBe('midnight')
    }
  })

  test('Pro: valid custom save → ok', () => {
    const result = validateColorPatch({
      colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS },
    }, proEnt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.theme.mode).toBe('custom')
      expect(result.data.theme.custom).toEqual(VALID_CUSTOM_TOKENS)
    }
  })

  test('Pro: invalid color in custom → rejected', () => {
    const result = validateColorPatch({
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, accent: '#FFF' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_custom_invalid')
  })

  test('Pro: missing token in custom → rejected', () => {
    const result = validateColorPatch({
      colors: { mode: 'custom', custom: { accent: '#FFFFFF' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_custom_invalid')
  })

  test('Pro: unexpected key in custom → rejected', () => {
    const result = validateColorPatch({
      colors: { mode: 'custom', custom: { ...VALID_CUSTOM_TOKENS, evil: '#000000' } },
    }, proEnt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_custom_unexpected_key')
  })

  test('Unknown plan: all color writes → rejected (colors_not_authorized)', () => {
    // null entitlements (unknown plan) → all color writes fail closed
    const presetResult = validateColorPatch({
      colors: { mode: 'preset', presetId: 'sukhan' },
    }, null)
    expect(presetResult.ok).toBe(false)
    if (!presetResult.ok) expect(presetResult.code).toBe('colors_not_authorized')

    const customResult = validateColorPatch({
      colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS },
    }, null)
    expect(customResult.ok).toBe(false)
    if (!customResult.ok) expect(customResult.code).toBe('colors_not_authorized')
  })

  test('null entitlements: rejected', () => {
    // Explicit null check (complements the unknown-plan test above)
    const result = validateColorPatch({
      colors: { mode: 'preset', presetId: 'sukhan' },
    }, null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('colors_not_authorized')
  })
})

// ─── Color PATCH merge tests (true-patch + positioning preservation) ─────

describe('Color PATCH merge — true-patch + positioning preservation', () => {
  const proEnt = getEntitlements('pro')

  test('editing colors does NOT reset positioning', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-end', offsetX: 100, offsetY: 50 } },
      mobile: { positioning: { anchor: 'bottom-start' } },
    }
    const patch = validateColorPatch(
      { colors: { mode: 'preset', presetId: 'sukhan' } },
      proEnt,
    )
    expect(patch.ok).toBe(true)
    if (!patch.ok) return
    const merged = mergeColorPatch(existing, patch.data)
    // positioning fully preserved
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-end')
    expect(merged.desktop?.positioning?.offsetX).toBe(100)
    expect(merged.desktop?.positioning?.offsetY).toBe(50)
    expect(merged.mobile?.positioning?.anchor).toBe('bottom-start')
    // colors updated
    expect(merged.colors?.mode).toBe('preset')
    expect(merged.colors?.presetId).toBe('sukhan')
  })

  test('editing colors does NOT reset desktop/mobile', () => {
    const existing = {
      version: 1,
      desktop: { positioning: { anchor: 'bottom-center' } },
      mobile: { positioning: { anchor: 'bottom-center', offsetX: 25 } },
    }
    const patch = validateColorPatch(
      { colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS } },
      proEnt,
    )
    expect(patch.ok).toBe(true)
    if (!patch.ok) return
    const merged = mergeColorPatch(existing, patch.data)
    // both device blocks preserved
    expect(merged.desktop?.positioning?.anchor).toBe('bottom-center')
    expect(merged.mobile?.positioning?.anchor).toBe('bottom-center')
    expect(merged.mobile?.positioning?.offsetX).toBe(25)
    // colors updated to custom
    expect(merged.colors?.mode).toBe('custom')
    expect(merged.colors?.custom).toEqual(VALID_CUSTOM_TOKENS)
  })

  test('Free edits preset → existing custom tokens preserved (downgrade preservation)', () => {
    // Existing V2 has custom tokens (saved previously by Pro).
    const existing = {
      version: 1,
      colors: { mode: 'custom', custom: VALID_CUSTOM_TOKENS },
    }
    // Free edits preset (downgrade scenario — Free can only save presets).
    const freeEnt = getEntitlements('free')
    const patch = validateColorPatch(
      { colors: { mode: 'preset', presetId: 'sukhan' } },
      freeEnt,
    )
    expect(patch.ok).toBe(true)
    if (!patch.ok) return
    const merged = mergeColorPatch(existing, patch.data)
    // New preset applied
    expect(merged.colors?.mode).toBe('preset')
    expect(merged.colors?.presetId).toBe('sukhan')
    // Per the documented contract (mergeColorPatch JSDoc):
    //   "Paid custom tokens are preserved when Free edits the preset."
    // The existing custom tokens must survive the merge so an upgrade
    // back to Pro can restore them.
    expect(merged.colors?.custom).toEqual(VALID_CUSTOM_TOKENS)
  })

  test('no existing V2 → creates fresh with colors only', () => {
    const patch = validateColorPatch(
      { colors: { mode: 'preset', presetId: 'sukhan' } },
      proEnt,
    )
    expect(patch.ok).toBe(true)
    if (!patch.ok) return
    const merged = mergeColorPatch(null, patch.data)
    expect(merged.version).toBe(1)
    expect(merged.colors?.mode).toBe('preset')
    expect(merged.colors?.presetId).toBe('sukhan')
    // desktop/mobile created empty (no positioning to preserve)
    expect(merged.desktop).toEqual({})
    expect(merged.mobile).toEqual({})
  })

  test('malformed existing V2 → starts fresh', () => {
    const patch = validateColorPatch(
      { colors: { mode: 'preset', presetId: 'midnight' } },
      proEnt,
    )
    expect(patch.ok).toBe(true)
    if (!patch.ok) return
    // existing is malformed (unknown version) → parser returns null → fresh start
    const merged = mergeColorPatch({ version: 999 }, patch.data)
    expect(merged.version).toBe(1)
    expect(merged.colors?.mode).toBe('preset')
    expect(merged.colors?.presetId).toBe('midnight')
    expect(merged.desktop).toEqual({})
    expect(merged.mobile).toEqual({})
  })
})

// ─── Entitlement tests ───────────────────────────────────────────────────

describe('Entitlements — getEntitlements', () => {
  test("getEntitlements('free') returns presetColors: true, customColors: false", () => {
    const e = getEntitlements('free')
    expect(e).not.toBeNull()
    expect(e!.presetColors).toBe(true)
    expect(e!.customColors).toBe(false)
  })

  test("getEntitlements('pro') returns presetColors: true, customColors: true", () => {
    const e = getEntitlements('pro')
    expect(e).not.toBeNull()
    expect(e!.presetColors).toBe(true)
    expect(e!.customColors).toBe(true)
  })

  test("getEntitlements('max') returns presetColors: true, customColors: true", () => {
    const e = getEntitlements('max')
    expect(e).not.toBeNull()
    expect(e!.presetColors).toBe(true)
    expect(e!.customColors).toBe(true)
  })

  test("getEntitlements('self-hosted') returns presetColors: true, customColors: true", () => {
    const e = getEntitlements('self-hosted')
    expect(e).not.toBeNull()
    expect(e!.presetColors).toBe(true)
    expect(e!.customColors).toBe(true)
  })

  test("getEntitlements('unknown') returns null", () => {
    expect(getEntitlements('unknown')).toBeNull()
    expect(getEntitlements('')).toBeNull()
    expect(getEntitlements(null)).toBeNull()
    expect(getEntitlements(undefined)).toBeNull()
    expect(getEntitlements(123 as unknown as string)).toBeNull()
  })

  test("getEntitlements('constructor') returns null (prototype-safe)", () => {
    // The catalog is a Map (prototype-free) — inherited Object properties
    // must NEVER resolve to an entitlement set.
    expect(getEntitlements('constructor')).toBeNull()
    expect(getEntitlements('toString')).toBeNull()
    expect(getEntitlements('hasOwnProperty')).toBeNull()
    expect(getEntitlements('valueOf')).toBeNull()
  })

  test("getEntitlements('__proto__') returns null", () => {
    expect(getEntitlements('__proto__')).toBeNull()
    expect(getEntitlements('prototype')).toBeNull()
  })
})
