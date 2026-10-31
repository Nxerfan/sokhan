/**
 * Widget V2 Color PATCH validation + merge.
 *
 * Handles the isolated color update contract:
 *   - Free: only `presetId` is allowed (mode='preset'). Custom tokens → reject.
 *   - Paid: preset palette + custom color tokens allowed.
 *   - True-patch: merging colors does NOT reset positioning or other fields.
 *   - Preserves paid custom colors when Free edits only the preset
 *     (downgrade preservation).
 *
 * Pure TS — no Prisma, no Next.js. Used by the API route handler.
 */

import { parseAppearanceV2, type AppearanceV2, type ColorTheme } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  isValidPaletteId,
  isValidColor,
  isValidCustomColors,
  COLOR_TOKEN_NAMES,
  DEFAULT_PALETTE_ID,
  type ColorTokens,
} from './color-palettes'

/** The color patch payload shape (from the dashboard PATCH body). */
export interface ColorPatchBody {
  colors?: unknown
}

/** Result of validating a color patch. */
export type ColorValidationResult =
  | { ok: true; data: ColorPatchData }
  | { ok: false; code: ColorErrorCode }

/** Error codes for color PATCH validation. */
export type ColorErrorCode =
  | 'colors_not_authorized'       // null entitlements or presetColors false
  | 'colors_not_object'
  | 'colors_mode_missing'
  | 'colors_mode_invalid'
  | 'colors_preset_id_missing'
  | 'colors_preset_id_invalid'
  | 'colors_custom_not_allowed'   // Free sent custom tokens
  | 'colors_custom_missing'       // mode='custom' but no custom tokens
  | 'colors_custom_invalid'       // not valid #RRGGBB
  | 'colors_custom_unexpected_key'
  | 'colors_unexpected_key'
  | 'colors_no_fields'

/** A validated color patch. */
export interface ColorPatchData {
  /** The validated color theme to merge. */
  theme: ColorTheme
}

/** Allowed keys in the color patch body. */
const ALLOWED_COLOR_PATCH_KEYS = new Set(['mode', 'presetId', 'custom'])

/**
 * Validate a color patch body against the plan entitlements.
 *
 * The `body.colors` field is expected to be:
 *   { mode: 'preset', presetId: 'sukhan' }
 *   or
 *   { mode: 'custom', custom: { accent: '#...', ... } }
 *
 * Free plan: only `mode: 'preset'` with a valid `presetId` is accepted.
 * Custom tokens → `colors_custom_not_allowed`.
 *
 * Paid plans: both preset and custom modes accepted.
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validateColorPatch(
  body: ColorPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): ColorValidationResult {
  // FAIL CLOSED: unknown plans or plans without preset colors capability.
  if (!entitlements || !entitlements.presetColors) {
    return { ok: false, code: 'colors_not_authorized' }
  }

  if (body.colors === undefined || body.colors === null) {
    return { ok: false, code: 'colors_no_fields' }
  }

  const colors = body.colors

  if (typeof colors !== 'object' || colors === null) {
    return { ok: false, code: 'colors_not_object' }
  }
  if (Array.isArray(colors)) {
    return { ok: false, code: 'colors_not_object' }
  }

  // Check for unexpected keys.
  const keys = Object.keys(colors as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_COLOR_PATCH_KEYS.has(key)) {
      return { ok: false, code: 'colors_unexpected_key' }
    }
  }

  const obj = colors as Record<string, unknown>

  // mode — required, must be 'preset' or 'custom'.
  if (obj.mode === undefined) {
    return { ok: false, code: 'colors_mode_missing' }
  }
  if (obj.mode !== 'preset' && obj.mode !== 'custom') {
    return { ok: false, code: 'colors_mode_invalid' }
  }

  const mode = obj.mode as 'preset' | 'custom'

  // presetId — required when mode='preset'.
  if (mode === 'preset') {
    if (obj.presetId === undefined || obj.presetId === null) {
      return { ok: false, code: 'colors_preset_id_missing' }
    }
    if (!isValidPaletteId(obj.presetId)) {
      return { ok: false, code: 'colors_preset_id_invalid' }
    }
    return { ok: true, data: { theme: { mode: 'preset', presetId: obj.presetId } } }
  }

  // mode === 'custom' — paid only.
  if (!entitlements.customColors) {
    return { ok: false, code: 'colors_custom_not_allowed' }
  }

  // custom tokens required.
  if (obj.custom === undefined || obj.custom === null) {
    return { ok: false, code: 'colors_custom_missing' }
  }
  if (typeof obj.custom !== 'object' || obj.custom === null) {
    return { ok: false, code: 'colors_custom_invalid' }
  }
  if (Array.isArray(obj.custom)) {
    return { ok: false, code: 'colors_custom_invalid' }
  }

  // Check for unexpected keys in custom tokens.
  const customObj = obj.custom as Record<string, unknown>
  const customKeys = Object.keys(customObj)
  for (const key of customKeys) {
    if (!(COLOR_TOKEN_NAMES as readonly string[]).includes(key)) {
      return { ok: false, code: 'colors_custom_unexpected_key' }
    }
  }

  // Validate all tokens are valid #RRGGBB.
  if (!isValidCustomColors(customObj)) {
    return { ok: false, code: 'colors_custom_invalid' }
  }

  // Build canonical copy.
  const tokens: Record<string, string> = {}
  for (const name of COLOR_TOKEN_NAMES) {
    tokens[name] = customObj[name] as string
  }

  return {
    ok: true,
    data: {
      theme: { mode: 'custom', custom: tokens as unknown as ColorTokens },
    },
  }
}

/**
 * Merge a validated color patch into the existing stored appearanceV2.
 *
 * True-patch semantics:
 *   - Editing colors does NOT reset positioning (desktop/mobile preserved).
 *   - Editing colors does NOT reset any other field.
 *   - Paid custom tokens are preserved when Free edits the preset.
 *
 * Returns the new appearanceV2 object (always valid, always canonical).
 */
export function mergeColorPatch(
  existingAppearanceV2: unknown,
  patch: ColorPatchData,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  // Downgrade preservation: if the patch switches to preset mode but the
  // existing stored colors had custom tokens (paid), preserve those custom
  // tokens in storage so they can be restored on upgrade. The effective
  // resolver will ignore them when the plan doesn't have customColors.
  let mergedColors = patch.theme
  if (patch.theme.mode === 'preset' && base.colors?.mode === 'custom' && base.colors.custom) {
    mergedColors = {
      mode: 'preset',
      presetId: patch.theme.presetId,
      // Preserve the paid custom tokens (not applied on Free, but stored).
      custom: base.colors.custom,
    }
  }

  // Preserve existing desktop/mobile (positioning etc.) — only update colors.
  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    colors: mergedColors,
  }
}

/**
 * Check if the PATCH body contains a `colors` field.
 */
export function hasColorField(body: Record<string, unknown>): boolean {
  return body.colors !== undefined
}
