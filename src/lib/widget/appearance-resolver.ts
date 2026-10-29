/**
 * Widget stored appearance normalization — the shared stored-config contract.
 *
 * Takes the stored WidgetConfig (flat V1 fields + the additive V2 appearance
 * field) + the plan entitlements → produces a NORMALIZED representation of
 * what is STORED.
 *
 * IMPORTANT: This is NOT an effective-appearance resolver. It does NOT enforce
 * entitlements (e.g., it does NOT hide advanced settings for Free plans or
 * null entitlements). It merely parses + validates the stored V2 field
 * alongside the V1 flat fields. The PRODUCTION effective config is still
 * resolved by `getEffectiveWidgetConfig` in `src/lib/payments/free-plan.ts`
 * using the legacy `customization: boolean` gate.
 *
 * Later phases will introduce a separate `resolveEffectiveAppearance` that
 * enforces entitlements. This function is the STORED normalization layer
 * that the effective resolver will build on.
 *
 * Phase 1: this is a thin adapter. If `appearanceV2` is null/absent/malformed,
 * the existing flat fields (accentColor, launcherShape, position, etc.) remain
 * the source of truth (V1 behavior preserved). The normalization does NOT
 * change visible behavior — no new visual features are implemented.
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
 * The NORMALIZED stored appearance — V1 flat fields + the parsed V2 model
 * (or null if absent/malformed) + the entitlements reference.
 *
 * This is NOT the effective appearance. It is the stored config after
 * parsing/validation. The effective appearance (what the widget actually
 * renders) is resolved separately, considering entitlement enforcement.
 */
export interface NormalizedStoredAppearance {
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
  // The plan entitlements (for future effective resolution; NOT enforced here).
  entitlements: Readonly<WidgetEntitlements> | null
}

/**
 * Normalize the STORED appearance from the stored config + entitlements.
 *
 * This function parses + validates the stored `appearanceV2` field strictly.
 * It does NOT enforce entitlements — it returns the stored V1 flat fields
 * as-is + the parsed V2 model (or null). The caller (a future effective
 * resolver) is responsible for applying entitlement enforcement.
 *
 * Phase 1 behavior:
 *   - Parses `appearanceV2` strictly (null on malformed/unknown keys → fall
 *     back to V1).
 *   - Returns the V1 flat fields as-is (no capability enforcement).
 *   - Includes the parsed V2 model + the entitlements reference for future
 *     effective resolution.
 *
 * This does NOT change visible behavior. The V1 flat fields remain the
 * stored appearance. The production effective config is still resolved by
 * `getEffectiveWidgetConfig` using the legacy `customization: boolean` gate.
 */
export function normalizeStoredAppearance(
  stored: StoredAppearance,
  entitlements: Readonly<WidgetEntitlements> | null,
): NormalizedStoredAppearance {
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
