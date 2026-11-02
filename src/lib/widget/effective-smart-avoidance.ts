/**
 * Widget V2 Smart Avoidance — effective resolution + entitlement enforcement.
 *
 *   - Free (smartAvoidance: false) → always false, even if stored true.
 *   - Paid (smartAvoidance: true) → stored preference (default false).
 *   - Unknown → false.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

export interface EffectiveSmartAvoidance {
  enabled: boolean
}

export interface StoredSmartAvoidanceInput {
  appearanceV2?: unknown
}

export function resolveEffectiveSmartAvoidance(
  stored: StoredSmartAvoidanceInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveSmartAvoidance {
  if (!entitlements) return { enabled: false }
  if (!entitlements.smartAvoidance) return { enabled: false }
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const sa = appearanceV2?.smartAvoidance
  return { enabled: sa?.enabled ?? false }
}

export function getStoredSmartAvoidance(
  stored: StoredSmartAvoidanceInput,
): { enabled: boolean } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.smartAvoidance ?? null
}
