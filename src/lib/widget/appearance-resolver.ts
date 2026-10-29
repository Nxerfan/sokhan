/**
 * Widget appearance resolver — the shared resolution contract.
 *
 * Takes the stored WidgetConfig (flat V1 fields + the additive V2 appearance
 * field) + the plan entitlements → produces the effective appearance.
 *
 * Phase 1: this is a THIN ADAPTER. If `appearanceV2` is null/absent/malformed,
 * the existing flat fields (accentColor, launcherShape, position, etc.) remain
 * the source of truth (V1 behavior preserved). The resolver does NOT change
 * visible behavior in Phase 1 — no new visual features are implemented.
 *
 * Subsequent phases will extend this resolver to:
 *   - Apply per-capability entitlement enforcement (e.g., Free can only use
 *     preset colors, not arbitrary hex).
 *   - Resolve desktop/mobile appearance independently.
 *   - Merge V2 fields over V1 flat fields (with V1 as the fallback).
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * NPM widget / browser bundle.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

/**
 * The stored appearance input — the V1 flat fields + the additive V2 field.
 * This mirrors the WidgetConfig columns but is a pure interface (no Prisma).
 */
export interface StoredAppearance {
  // V1 flat fields (the current source of truth).
  accentColor: string
  launcherShape: string
  position: string
  avatarUrl: string | null
  logoUrl: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
  // V2 additive field (nullable — existing rows have null).
  appearanceV2?: unknown
}

/**
 * The resolved effective appearance — V1 flat fields + the parsed V2 model
 * (or null if absent/malformed).
 */
export interface ResolvedAppearance {
  // V1 flat fields (always present — the current source of truth).
  accentColor: string
  launcherShape: string
  position: string
  avatarUrl: string | null
  logoUrl: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
  // V2 parsed model (null if absent/malformed — fall back to V1).
  appearanceV2: AppearanceV2 | null
  // The plan entitlements (for future per-capability enforcement).
  entitlements: WidgetEntitlements | null
}

/**
 * Resolve the effective appearance from the stored config + entitlements.
 *
 * Phase 1 behavior:
 *   - Parses `appearanceV2` strictly (null on malformed → fall back to V1).
 *   - Returns the V1 flat fields as-is (no capability enforcement yet).
 *   - Includes the parsed V2 model + the entitlements for future phases.
 *
 * This does NOT change visible behavior. The V1 flat fields remain the
 * effective appearance.
 */
export function resolveAppearance(
  stored: StoredAppearance,
  entitlements: WidgetEntitlements | null,
): ResolvedAppearance {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return {
    accentColor: stored.accentColor,
    launcherShape: stored.launcherShape,
    position: stored.position,
    avatarUrl: stored.avatarUrl,
    logoUrl: stored.logoUrl,
    greetingTexts: stored.greetingTexts,
    defaultLocale: stored.defaultLocale,
    appearanceV2,
    entitlements,
  }
}
