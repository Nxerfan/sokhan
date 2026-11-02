/**
 * Widget V2 Page Visibility — effective resolution + entitlement enforcement.
 *
 *   - Free (basic): up to 3 rules, exact match only.
 *   - Paid (advanced): up to 10 rules, exact + prefix, device-specific.
 *   - Unknown: empty (no rules).
 *   - paidRules: restored on upgrade (same pattern as paidFields/paidItems).
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import type { PageVisibilityRule } from './page-visibility-types'
import { isAdvancedPageVisibilityPlan } from './page-visibility-types'

export interface EffectivePageVisibility {
  rules: PageVisibilityRule[]
}

export interface StoredPageVisibilityInput {
  appearanceV2?: unknown
}

export function resolveEffectivePageVisibility(
  stored: StoredPageVisibilityInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectivePageVisibility {
  if (!entitlements) return { rules: [] }

  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const pv = appearanceV2?.pageVisibility
  if (!pv) return { rules: [] }

  const capability = entitlements.pageVisibility
  if (capability === 'none') return { rules: [] }

  // Advanced (paid): restore paidRules if present.
  if (isAdvancedPageVisibilityPlan(capability) && pv.paidRules && pv.paidRules.length > 0) {
    return { rules: pv.paidRules.slice(0, 10) }
  }

  // Basic (Free): filter to exact-match rules only + truncate to 3.
  if (capability === 'basic') {
    const basicRules = pv.rules.filter(r => r.match === 'exact')
    return { rules: basicRules.slice(0, 3) }
  }

  // Advanced without paidRules: use stored rules.
  if (isAdvancedPageVisibilityPlan(capability)) {
    return { rules: pv.rules.slice(0, 10) }
  }

  return { rules: [] }
}

export function getStoredPageVisibility(
  stored: StoredPageVisibilityInput,
): { rules: PageVisibilityRule[]; paidRules?: PageVisibilityRule[] } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.pageVisibility ?? null
}
