/**
 * Widget V2 Pre-chat Form — effective resolution + entitlement enforcement.
 *
 * Derives the EFFECTIVE pre-chat form fields from stored V2 + plan entitlements.
 *
 *   - Free (basic): only name + email fields from the stored config.
 *   - Paid (advanced): all stored fields.
 *   - Unknown: empty (no form).
 *   - paidFields: restored on upgrade (same pattern as paidShape/paidItems).
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import type { PreChatField } from './pre-chat-form-types'

export interface EffectivePreChatForm {
  fields: PreChatField[]
}

export interface StoredPreChatFormInput {
  appearanceV2?: unknown
}

/**
 * Resolve the effective pre-chat form fields.
 *
 *   - null entitlements → empty.
 *   - 'basic' (Free): filter stored fields to name/email only; truncate to 2.
 *   - 'advanced' (paid): if paidFields exists + plan can use them → restore.
 *     Otherwise use stored fields (truncated to 4).
 */
export function resolveEffectivePreChatForm(
  stored: StoredPreChatFormInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectivePreChatForm {
  if (!entitlements) return { fields: [] }

  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const pcf = appearanceV2?.preChatForm
  if (!pcf) return { fields: [] }

  const capability = entitlements.preChatForm
  if (capability === 'none') return { fields: [] }

  // Advanced (paid): restore paidFields if present and plan can use them.
  if (capability === 'advanced' && pcf.paidFields && pcf.paidFields.length > 0) {
    return { fields: pcf.paidFields.slice(0, 4) }
  }

  // Basic (Free): filter to allowed keys + truncate to max.
  if (capability === 'basic') {
    const allowed = pcf.fields.filter(f => f.key === 'name' || f.key === 'email')
    return { fields: allowed.slice(0, 2) }
  }

  // Advanced without paidFields: use stored fields.
  if (capability === 'advanced') {
    return { fields: pcf.fields.slice(0, 4) }
  }

  return { fields: [] }
}

/**
 * Get the stored pre-chat form config (without entitlement enforcement).
 */
export function getStoredPreChatForm(
  stored: StoredPreChatFormInput,
): { fields: PreChatField[]; paidFields?: PreChatField[] } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.preChatForm ?? null
}
