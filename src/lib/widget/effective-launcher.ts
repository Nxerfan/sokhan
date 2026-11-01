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
 *   1. Stored V2 launcher shape (if present + valid + entitled).
 *   2. V1 `launcherShape` (if valid + entitled for paid plans, or 'tab'/'rounded' for Free).
 *   3. DEFAULT_LAUNCHER_SHAPE ('tab').
 *
 * Entitlement enforcement:
 *   - null entitlements (unknown plan) → fail closed to 'tab'.
 *   - launcherSelection='limited' → only 'tab' and 'rounded' applied.
 *     Paid-only shapes (e.g. 'pill') stored but NOT applied.
 *   - launcherSelection='all' → all shapes applied.
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
  const v2Launcher = appearanceV2?.launcher?.shape ?? null

  if (v2Launcher) {
    // V2 launcher present — apply if entitled.
    if (isLauncherShapeAllowed(v2Launcher, entitlements)) {
      return { shape: v2Launcher }
    }
    // Not entitled → fall back to safe default.
    return { shape: DEFAULT_LAUNCHER_SHAPE }
  }

  // No V2 launcher → try V1 launcherShape fallback.
  if (stored.launcherShape && isValidLauncherShape(stored.launcherShape)) {
    // For paid plans, V1 shapes are always allowed.
    // For Free, only 'tab' and 'rounded' are allowed; 'pill' falls back.
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
