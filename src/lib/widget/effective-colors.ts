/**
 * Widget V2 Effective Color Resolver.
 *
 * Derives the EFFECTIVE color tokens (what the widget actually renders)
 * from:
 *   1. Stored V2 color theme (parsed strictly).
 *   2. Stored V1 `accentColor` (fallback when V2 absent).
 *   3. Server-authoritative plan entitlements.
 *
 * Entitlement enforcement:
 *   - `presetColors` (Free: true) → palette presets are applied.
 *   - `customColors` (Free: false) → custom color tokens are NOT applied
 *     even if stored (they remain in storage for upgrade restore).
 *   - Unknown plan / null entitlements → fail closed (default palette).
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2, type ColorTheme } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  DEFAULT_PALETTE_ID,
  DEFAULT_COLOR_TOKENS,
  getPaletteById,
  type ColorTokens,
} from './color-palettes'

/**
 * Stored color input — the V1 flat `accentColor` field + the additive V2
 * `appearanceV2` field (raw, untyped — parsed strictly here).
 */
export interface StoredColorInput {
  /** V1 flat accent color (e.g. '#E09A2B'). */
  accentColor?: string | null
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * The effective color tokens (what the widget actually renders).
 */
export interface EffectiveColors {
  /** The effective mode: 'preset' (palette) or 'custom' (custom tokens). */
  mode: 'preset' | 'custom'
  /** The effective palette ID (when mode='preset'). */
  presetId?: string
  /** The resolved color tokens (always present). */
  tokens: ColorTokens
}

/**
 * The default effective colors (Sukhan brand palette).
 */
export const DEFAULT_EFFECTIVE_COLORS: EffectiveColors = {
  mode: 'preset',
  presetId: DEFAULT_PALETTE_ID,
  tokens: DEFAULT_COLOR_TOKENS,
}

/**
 * Resolve the effective colors from stored config + plan entitlements.
 *
 * Resolution order:
 *   1. Stored V2 color theme (if present + valid).
 *      - Preset mode: use the palette tokens (always, if presetColors).
 *      - Custom mode: use custom tokens only if customColors entitled.
 *      - Custom mode without entitlement: fall back to preset (default).
 *   2. V1 `accentColor` fallback (if no V2 colors).
 *      - Derives a minimal palette from the V1 accent color.
 *   3. DEFAULT_EFFECTIVE_COLORS (Sukhan brand).
 *
 * Entitlement enforcement:
 *   - null entitlements (unknown plan) → fail closed to defaults.
 *   - presetColors=false → fail closed to defaults.
 *   - customColors=false → custom tokens NOT applied (fall back to preset).
 */
export function resolveEffectiveColors(
  stored: StoredColorInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveColors {
  // Fail closed for unknown plans / null entitlements.
  if (!entitlements || !entitlements.presetColors) {
    return { ...DEFAULT_EFFECTIVE_COLORS }
  }

  // Parse stored V2 strictly.
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const colors = appearanceV2?.colors ?? null

  if (colors) {
    if (colors.mode === 'preset' && colors.presetId) {
      // Preset mode: always apply (presetColors is checked above).
      const palette = getPaletteById(colors.presetId)
      if (palette) {
        return { mode: 'preset', presetId: palette.id, tokens: palette.tokens }
      }
      // Invalid palette ID → fall back to default.
      return { ...DEFAULT_EFFECTIVE_COLORS }
    }

    if (colors.mode === 'custom' && colors.custom) {
      // Custom mode: apply custom tokens only if entitled.
      if (entitlements.customColors) {
        return { mode: 'custom', tokens: colors.custom }
      }
      // Not entitled → fall back to default preset.
      // Custom tokens remain stored but NOT applied (downgrade preservation).
      return { ...DEFAULT_EFFECTIVE_COLORS }
    }
  }

  // No V2 colors → try V1 accentColor fallback ONLY for paid plans
  // (legacyCustomizationUnlocked). Free tenants without a V2 color
  // selection get the default Sukhan palette — not an arbitrary stored
  // V1 accent from a previous paid period. The stored V1 accent is
  // preserved in the WidgetConfig row for restoration on upgrade.
  if (
    stored.accentColor &&
    /^#[0-9a-fA-F]{6}$/.test(stored.accentColor) &&
    entitlements.legacyCustomizationUnlocked
  ) {
    return deriveFromAccentColor(stored.accentColor)
  }

  // No V2, no V1 (or Free with no V2) → default Sukhan palette.
  return { ...DEFAULT_EFFECTIVE_COLORS }
}

/**
 * Derive a color token set from a single V1 accent color.
 *
 * This preserves the EXACT pre-V2 widget appearance for paid tenants who
 * haven't migrated to V2 colors yet. The pre-V2 runtime hardcodes:
 *   - Header: bg=accent, text=#FFFFFF (white)
 *   - Launcher: bg=#0E1116, fg=#FAF7F2
 *   - Panel: bg=#FFFFFF, text=#0E1116
 *   - Visitor bubbles: bg=#0E1116 (dark), text=#FAF7F2 (light)
 *   - Agent bubbles: bg=#FFFFFF (white), text=#0E1116 (dark)
 *
 * This is NOT a palette — it's a V1 compatibility fallback. The accent
 * color is the only variable; all other tokens are fixed to the pre-V2
 * hardcoded values. This ensures no existing paid tenant's widget
 * appearance changes as a side effect of enabling V2.
 */
function deriveFromAccentColor(accent: string): EffectiveColors {
  return {
    mode: 'preset',
    presetId: undefined, // not a named palette — derived from V1
    tokens: {
      accent,
      launcherBg: '#0E1116',
      launcherFg: '#FAF7F2',
      headerBg: accent,
      headerText: '#FFFFFF',
      panelBg: '#FFFFFF',
      panelText: '#0E1116',
      visitorBubbleBg: '#0E1116',
      visitorBubbleText: '#FAF7F2',
      agentBubbleBg: '#FFFFFF',
      agentBubbleText: '#0E1116',
    },
  }
}

/**
 * Get the stored color theme (without entitlement enforcement).
 * Used by the dashboard to populate controls with the raw stored values
 * (so the user can see their saved custom colors even on Free).
 *
 * Returns null if no V2 or no colors in V2.
 */
export function getStoredColorTheme(stored: StoredColorInput): ColorTheme | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.colors ?? null
}
