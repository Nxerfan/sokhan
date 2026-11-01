/**
 * Launcher shape types + validation — standalone module to avoid circular
 * imports between appearance-v2.ts and effective-launcher.ts.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

/** All supported launcher shapes. */
export const LAUNCHER_SHAPES = ['tab', 'rounded', 'pill'] as const
export type LauncherShape = (typeof LAUNCHER_SHAPES)[number]

/** Shapes available to Free (launcherSelection='limited'). */
export const FREE_LAUNCHER_SHAPES: readonly LauncherShape[] = ['tab', 'rounded']

/** Shapes that are paid-only (not available on Free). */
export const PAID_ONLY_LAUNCHER_SHAPES: readonly LauncherShape[] = ['pill']

/** The default launcher shape (fail-closed for unknown plans). */
export const DEFAULT_LAUNCHER_SHAPE: LauncherShape = 'tab'

/**
 * Check if a value is a valid launcher shape.
 */
export function isValidLauncherShape(value: unknown): value is LauncherShape {
  if (typeof value !== 'string') return false
  return (LAUNCHER_SHAPES as readonly string[]).includes(value)
}

/**
 * Check if a shape is a paid-only shape (not available on Free).
 */
export function isPaidOnlyLauncherShape(shape: LauncherShape): boolean {
  return PAID_ONLY_LAUNCHER_SHAPES.includes(shape)
}
