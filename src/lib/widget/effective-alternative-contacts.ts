/**
 * Widget V2 Alternative Contact Buttons — effective resolution.
 *
 *   - Free: first `max` items (2).
 *   - Paid: up to `max` items (5).
 *   - Unknown: empty.
 *   - paidItems: restored on upgrade.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import type { AlternativeContactButton } from './alternative-contact-types'

export interface EffectiveAlternativeContactButtons {
  items: AlternativeContactButton[]
}

export interface StoredAlternativeContactInput {
  appearanceV2?: unknown
}

export function resolveEffectiveAlternativeContactButtons(
  stored: StoredAlternativeContactInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveAlternativeContactButtons {
  if (!entitlements) return { items: [] }

  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const acb = appearanceV2?.alternativeContactButtons
  if (!acb) return { items: [] }

  const max = entitlements.alternativeContactButtons
  if (max === 0) return { items: [] }

  // Paid (advanced): restore paidItems if present.
  if (max > 2 && acb.paidItems && acb.paidItems.length > 0) {
    return { items: acb.paidItems.slice(0, max) }
  }

  // Use stored items, truncated to plan max.
  return { items: acb.items.slice(0, max) }
}

export function getStoredAlternativeContactButtons(
  stored: StoredAlternativeContactInput,
): { items: AlternativeContactButton[]; paidItems?: AlternativeContactButton[] } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.alternativeContactButtons ?? null
}
