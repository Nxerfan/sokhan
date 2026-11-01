/**
 * Widget V2 Launcher PATCH validation + merge.
 *
 * Handles the isolated launcher update contract:
 *   - Free: only 'tab' and 'rounded' are allowed.
 *   - Paid: all three shapes allowed.
 *   - True-patch: editing launcher does NOT reset positioning or colors.
 *   - Preserves paid-only shapes when Free edits an allowed shape.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  LAUNCHER_SHAPES,
  FREE_LAUNCHER_SHAPES,
  DEFAULT_LAUNCHER_SHAPE,
  isLauncherShapeAllowed,
  isPaidOnlyLauncherShape,
  type LauncherShape,
} from './effective-launcher'

/** The launcher patch payload shape. */
export interface LauncherPatchBody {
  launcher?: unknown
}

/** Result of validating a launcher patch. */
export type LauncherValidationResult =
  | { ok: true; data: LauncherPatchData }
  | { ok: false; code: LauncherErrorCode }

/** Error codes for launcher PATCH validation. */
export type LauncherErrorCode =
  | 'launcher_not_authorized'
  | 'launcher_not_object'
  | 'launcher_shape_missing'
  | 'launcher_shape_invalid'
  | 'launcher_shape_not_allowed'
  | 'launcher_unexpected_key'
  | 'launcher_no_fields'

/** A validated launcher patch. */
export interface LauncherPatchData {
  shape: LauncherShape
}

/** Allowed keys in the launcher patch body. */
const ALLOWED_LAUNCHER_KEYS = new Set(['shape'])

/**
 * Validate a launcher patch body against the plan entitlements.
 *
 * The `body.launcher` field is expected to be:
 *   { shape: 'tab' | 'rounded' | 'pill' }
 *
 * Free plan: only 'tab' and 'rounded' accepted. 'pill' →
 * `launcher_shape_not_allowed`.
 *
 * Paid plans: all three shapes accepted.
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validateLauncherPatch(
  body: LauncherPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): LauncherValidationResult {
  // FAIL CLOSED: unknown plans or plans without launcher selection.
  if (!entitlements) {
    return { ok: false, code: 'launcher_not_authorized' }
  }

  if (body.launcher === undefined || body.launcher === null) {
    return { ok: false, code: 'launcher_no_fields' }
  }

  const launcher = body.launcher

  if (typeof launcher !== 'object' || launcher === null) {
    return { ok: false, code: 'launcher_not_object' }
  }
  if (Array.isArray(launcher)) {
    return { ok: false, code: 'launcher_not_object' }
  }

  // Check for unexpected keys.
  const keys = Object.keys(launcher as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_LAUNCHER_KEYS.has(key)) {
      return { ok: false, code: 'launcher_unexpected_key' }
    }
  }

  const obj = launcher as Record<string, unknown>

  // shape — required, must be a valid launcher shape.
  if (obj.shape === undefined || obj.shape === null) {
    return { ok: false, code: 'launcher_shape_missing' }
  }
  if (typeof obj.shape !== 'string' || !(LAUNCHER_SHAPES as readonly string[]).includes(obj.shape)) {
    return { ok: false, code: 'launcher_shape_invalid' }
  }

  const shape = obj.shape as LauncherShape

  // Entitlement check: Free can't use 'pill'.
  if (!isLauncherShapeAllowed(shape, entitlements)) {
    return { ok: false, code: 'launcher_shape_not_allowed' }
  }

  return { ok: true, data: { shape } }
}

/**
 * Merge a validated launcher patch into the existing stored appearanceV2.
 *
 * True-patch semantics:
 *   - Editing launcher does NOT reset positioning (desktop/mobile preserved).
 *   - Editing launcher does NOT reset colors.
 *   - Paid-only shapes preserved when Free edits an allowed shape
 *     (downgrade preservation): the stored paid shape remains in the
 *     V2 launcher's `paidShape` field for upgrade restore.
 *
 * Returns the new appearanceV2 object (always valid, always canonical).
 */
export function mergeLauncherPatch(
  existingAppearanceV2: unknown,
  patch: LauncherPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  // Determine the stored paid shape for preservation.
  // If the existing V2 has a launcher with a paid-only shape, and the
  // new patch is an allowed Free shape, preserve the paid shape.
  const existingLauncher = existing?.launcher
  const newShape = patch.shape

  // If the new shape is the same as the existing shape, no change needed.
  if (existingLauncher?.shape === newShape) {
    return {
      version: 1,
      desktop: { ...(base.desktop ?? {}) },
      mobile: { ...(base.mobile ?? {}) },
      launcher: existingLauncher,
      ...(base.colors ? { colors: base.colors } : {}),
    }
  }

  // Build the new launcher config.
  const launcherConfig: NonNullable<AppearanceV2['launcher']> = {
    shape: newShape,
  }

  // BLOCKER 2: When the plan has 'all' entitlement (Pro), the user is
  // explicitly choosing a shape on a paid plan. Clear paidShape — the
  // user's explicit choice replaces any prior paid preference. There is
  // no need to preserve a paid preference when the plan can already use
  // all shapes.
  if (entitlements?.launcherSelection === 'all') {
    // No paidShape — explicit Pro choice.
  } else {
    // Plan is 'limited' (Free). Preserve paid-only shape for restore.
    // BLOCKER 4: Only paid-only shapes (pill) are valid as paidShape.
    if (existingLauncher?.shape && existingLauncher.shape !== newShape) {
      const existingShape = existingLauncher.shape as LauncherShape
      if (isPaidOnlyLauncherShape(existingShape)) {
        launcherConfig.paidShape = existingShape
      }
    }
    // Also preserve any existing paidShape from the existing config.
    if (existingLauncher?.paidShape && !launcherConfig.paidShape) {
      launcherConfig.paidShape = existingLauncher.paidShape
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    launcher: launcherConfig,
    // BLOCKER 1: Preserve colors + any other existing V2 fields.
    ...(base.colors ? { colors: base.colors } : {}),
  }
}

/**
 * Check if the PATCH body contains a `launcher` field.
 */
export function hasLauncherField(body: Record<string, unknown>): boolean {
  return body.launcher !== undefined
}
