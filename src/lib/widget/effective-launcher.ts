/**
 * Widget V2 Launcher Styles — effective resolution + entitlement enforcement.
 *
 * Derives the EFFECTIVE launcher shape from:
 *   1. Stored V2 launcher selection (parsed strictly).
 *   2. Stored V1 `launcherShape` (fallback when V2 absent).
 *   3. DEFAULT_LAUNCHER_SHAPE ('tab') if nothing valid.
 *
 * Entitlement enforcement:
 *   - `launcherSelection: 'limited'` (Free) → only 'tab' and 'rounded'.
 *   - `launcherSelection: 'all'` (paid) → all three shapes.
 *   - Unknown plans → fail closed to 'tab'.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

/** All supported launcher shapes. */
export const LAUNCHER_SHAPES = ['tab', 'rounded', 'pill'] as const
export type LauncherShape = (typeof LAUNCHER_SHAPES)[number]

/** Shapes available to Free (launcherSelection='limited'). */
export const FREE_LAUNCHER_SHAPES: readonly LauncherShape[] = ['tab', 'rounded']

/** Shapes that are paid-only (not available on Free). */
export const PAID_ONLY_LAUNCHER_SHAPES: readonly LauncherShape[] = ['pill']

/**
 * Check if a shape is a paid-only shape (not available on Free).
 */
export function isPaidOnlyLauncherShape(shape: LauncherShape): boolean {
  return PAID_ONLY_LAUNCHER_SHAPES.includes(shape)
}

/** The default launcher shape (fail-closed for unknown plans). */
export const DEFAULT_LAUNCHER_SHAPE: LauncherShape = 'tab'

/**
 * The effective launcher shape (what the widget actually renders).
 */
export interface EffectiveLauncher {
  shape: LauncherShape
}

/**
 * Stored launcher input — the V1 flat `launcherShape` field + the additive
 * V2 `appearanceV2` field (raw, untyped — parsed strictly here).
 */
export interface StoredLauncherInput {
  /** V1 flat launcher shape field (e.g. 'tab', 'rounded', 'pill'). */
  launcherShape?: string | null
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * Check if a shape is valid.
 */
export function isValidLauncherShape(value: unknown): value is LauncherShape {
  if (typeof value !== 'string') return false
  return (LAUNCHER_SHAPES as readonly string[]).includes(value)
}

/**
 * Check if a shape is allowed for a plan's entitlement.
 */
export function isLauncherShapeAllowed(
  shape: LauncherShape,
  entitlements: Readonly<WidgetEntitlements> | null,
): boolean {
  if (!entitlements) return false
  if (entitlements.launcherSelection === 'all') return true
  // 'limited' (Free) → only tab + rounded
  return FREE_LAUNCHER_SHAPES.includes(shape)
}

/**
 * Resolve the effective launcher shape from stored config + plan entitlements.
 *
 * Resolution order:
 *   1. Stored V2 launcher: if the plan is now entitled to the active shape,
 *      apply it. If NOT entitled (e.g. Free after downgrade from Pro):
 *        a. If a paidShape is stored AND the plan is now entitled to it
 *           (e.g. re-upgraded to Pro), restore the paidShape.
 *        b. Otherwise, fall back to the safe default ('tab').
 *   2. V1 `launcherShape` (if valid + entitled).
 *   3. DEFAULT_LAUNCHER_SHAPE ('tab').
 *
 * Entitlement enforcement:
 *   - null entitlements (unknown plan) → fail closed to 'tab'.
 *   - launcherSelection='limited' → only 'tab' and 'rounded' applied.
 *     Paid-only shapes (e.g. 'pill') stored but NOT applied.
 *   - launcherSelection='all' → all shapes applied, including restored
 *     paidShape from prior downgrade.
 */
export function resolveEffectiveLauncher(
  stored: StoredLauncherInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveLauncher {
  // Fail closed for unknown plans.
  if (!entitlements) {
    return { shape: DEFAULT_LAUNCHER_SHAPE }
  }

  // Parse stored V2 strictly.
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const v2Launcher = appearanceV2?.launcher

  if (v2Launcher) {
    // V2 launcher present.
    // BLOCKER 2: When the plan has 'all' entitlement AND a paidShape exists,
    // restore the paidShape. The active shape was forced by a prior
    // downgrade (Free couldn't use the paid-only shape). On upgrade, the
    // user's original paid preference should be restored.
    if (entitlements.launcherSelection === 'all' && v2Launcher.paidShape) {
      return { shape: v2Launcher.paidShape }
    }
    if (isLauncherShapeAllowed(v2Launcher.shape, entitlements)) {
      return { shape: v2Launcher.shape }
    }
    // Active shape NOT entitled (e.g. Free after Pro downgrade).
    if (v2Launcher.paidShape && isLauncherShapeAllowed(v2Launcher.paidShape, entitlements)) {
      return { shape: v2Launcher.paidShape }
    }
    return { shape: DEFAULT_LAUNCHER_SHAPE }
  }

  // No V2 launcher → try V1 launcherShape fallback.
  if (stored.launcherShape && isValidLauncherShape(stored.launcherShape)) {
    if (isLauncherShapeAllowed(stored.launcherShape as LauncherShape, entitlements)) {
      return { shape: stored.launcherShape as LauncherShape }
    }
  }

  // No valid/entitled shape → default.
  return { shape: DEFAULT_LAUNCHER_SHAPE }
}

/**
 * Get the stored launcher shape from V2 (without entitlement enforcement).
 * Returns null if no V2 launcher selection exists.
 */
export function getStoredLauncherShape(stored: StoredLauncherInput): LauncherShape | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.launcher?.shape ?? null
}
