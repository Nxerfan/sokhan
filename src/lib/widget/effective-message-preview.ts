/**
 * Widget V2 Message Preview — effective resolution + entitlement enforcement.
 *
 * Derives the EFFECTIVE messagePreview state from the stored V2 config +
 * the server-authoritative plan entitlements.
 *
 * Entitlement enforcement:
 *   - `messagePreview: false` (Free) → always effective `false`, even if the
 *     stored V2 preference is `true` (preserved from a prior paid period).
 *   - `messagePreview: true` (Pro/Max/Self-hosted) → the stored preference
 *     is applied (defaults to `false` when no V2 selection exists).
 *   - Unknown plans (null entitlements) → fail closed to `false`.
 *
 * Downgrade/upgrade preservation:
 *   - A Pro-enabled preference `{ enabled: true }` remains stored after
 *     downgrade to Free, but Free visitors see effective `false`.
 *   - On re-upgrade, the resolver restores the stored `true`.
 *   - An explicit Pro disable `{ enabled: false }` persists and overrides
 *     the earlier preference (no stale `true` after explicit disable).
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

/**
 * The effective message preview state (what the widget actually enforces).
 */
export interface EffectiveMessagePreview {
  enabled: boolean
}

/**
 * Stored message preview input — the V2 `appearanceV2` field (raw, untyped —
 * parsed strictly here). Message Preview has no V1 fallback.
 */
export interface StoredMessagePreviewInput {
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * Resolve the effective message preview from stored config + plan entitlements.
 *
 *   - null entitlements (unknown plan) → fail closed to `false`.
 *   - `messagePreview: false` (Free) → always `false` (stored preference
 *     preserved but NOT applied).
 *   - `messagePreview: true` (paid) → the stored preference (default `false`).
 */
export function resolveEffectiveMessagePreview(
  stored: StoredMessagePreviewInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveMessagePreview {
  // Fail closed for unknown plans.
  if (!entitlements) {
    return { enabled: false }
  }

  // Free (and any plan without messagePreview capability) → always false.
  // The stored preference is preserved in the DB but never exposed as
  // effective to Free visitors.
  if (!entitlements.messagePreview) {
    return { enabled: false }
  }

  // Paid: apply the stored preference (default false when no V2 selection).
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const storedPreview = appearanceV2?.messagePreview
  return { enabled: storedPreview?.enabled ?? false }
}

/**
 * Get the stored message preview config from V2 (without entitlement enforcement).
 * Returns null if no V2 message preview selection exists.
 */
export function getStoredMessagePreview(
  stored: StoredMessagePreviewInput,
): { enabled: boolean } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.messagePreview ?? null
}
