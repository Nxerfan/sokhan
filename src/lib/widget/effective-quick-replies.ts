/**
 * Widget V2 Quick Replies — effective resolution + entitlement enforcement.
 *
 * Derives the EFFECTIVE quick-reply items from the stored V2 config + the
 * server-authoritative plan entitlements.
 *
 * Entitlement enforcement:
 *   - Free (max 2): only the first `max` stored items are applied.
 *     `paidItems` are NEVER exposed to Free.
 *   - Paid (max 10): if `paidItems` exists AND the plan's max can accommodate
 *     them, restore the paidItems (downgrade/upgrade restoration). Otherwise
 *     use the stored `items` (truncated to `max`).
 *   - Unknown plans (null entitlements) → fail closed to `[]`.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

/**
 * The effective quick-reply items (what the widget actually renders).
 */
export interface EffectiveQuickReplies {
  items: string[]
}

/**
 * Stored quick-replies input — the V2 `appearanceV2` field (raw, untyped —
 * parsed strictly here). Quick Replies has no V1 fallback.
 */
export interface StoredQuickRepliesInput {
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * Resolve the effective quick-reply items from stored config + plan entitlements.
 *
 *   - null entitlements (unknown plan) → fail closed to `[]`.
 *   - Free (max ≤ 2): use stored `items`, truncated to `max`. Never paidItems.
 *   - Paid (max > 2): if paidItems exists and fits within max, restore them.
 *     Otherwise use stored `items` (truncated to max).
 */
export function resolveEffectiveQuickReplies(
  stored: StoredQuickRepliesInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveQuickReplies {
  if (!entitlements) {
    return { items: [] }
  }

  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const qr = appearanceV2?.quickReplies
  if (!qr) {
    return { items: [] }
  }

  const max = entitlements.quickReplies

  // Downgrade/upgrade restoration: if paidItems exist and the plan's max can
  // accommodate them, restore the paid selection. This happens on upgrade
  // (Free → Pro): the paidItems (the full paid selection preserved during the
  // downgrade) are restored as the active items.
  if (qr.paidItems && qr.paidItems.length > 0 && max >= qr.paidItems.length) {
    return { items: qr.paidItems.slice(0, max) }
  }

  // Default: use stored items, truncated to the plan's max.
  const items = Array.isArray(qr.items) ? qr.items : []
  return { items: items.slice(0, max) }
}

/**
 * Get the stored quick-replies config from V2 (without entitlement enforcement).
 * Returns null if no V2 quick-replies selection exists.
 */
export function getStoredQuickReplies(
  stored: StoredQuickRepliesInput,
): { items: string[]; paidItems?: string[] } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.quickReplies ?? null
}
