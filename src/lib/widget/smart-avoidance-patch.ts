/**
 * Widget V2 Smart Avoidance PATCH validation + merge.
 *
 *   - Free (smartAvoidance: false) → rejects both true AND false.
 *   - Paid (smartAvoidance: true) → accepts { enabled: boolean }.
 *   - Unknown → rejects.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

export interface SmartAvoidancePatchBody {
  smartAvoidance?: unknown
}

export type SmartAvoidanceValidationResult =
  | { ok: true; data: SmartAvoidancePatchData }
  | { ok: false; code: SmartAvoidanceErrorCode }

export type SmartAvoidanceErrorCode =
  | 'smart_avoidance_not_authorized'
  | 'smart_avoidance_not_object'
  | 'smart_avoidance_enabled_missing'
  | 'smart_avoidance_enabled_invalid'
  | 'smart_avoidance_not_allowed'
  | 'smart_avoidance_unexpected_key'
  | 'smart_avoidance_no_fields'

export interface SmartAvoidancePatchData {
  enabled: boolean
}

/**
 * Validate a smart-avoidance patch body against the plan entitlements.
 * Uses safe property descriptor inspection to avoid executing getters.
 */
export function validateSmartAvoidancePatch(
  body: SmartAvoidancePatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): SmartAvoidanceValidationResult {
  if (!entitlements) {
    return { ok: false, code: 'smart_avoidance_not_authorized' }
  }

  if (body.smartAvoidance === undefined || body.smartAvoidance === null) {
    return { ok: false, code: 'smart_avoidance_no_fields' }
  }

  const sa = body.smartAvoidance
  if (typeof sa !== 'object' || sa === null || Array.isArray(sa)) {
    return { ok: false, code: 'smart_avoidance_not_object' }
  }

  // Use descriptors to safely read keys without triggering getters.
  try {
    const ownKeys = Reflect.ownKeys(sa)
    if (ownKeys.length !== 1 || ownKeys[0] !== 'enabled') {
      return { ok: false, code: 'smart_avoidance_unexpected_key' }
    }

    const desc = Object.getOwnPropertyDescriptor(sa, 'enabled')
    if (!desc || !('value' in desc)) {
      return { ok: false, code: 'smart_avoidance_enabled_invalid' }
    }

    const enabledValue = desc.value
    if (enabledValue === undefined || enabledValue === null) {
      return { ok: false, code: 'smart_avoidance_enabled_missing' }
    }
    if (typeof enabledValue !== 'boolean') {
      return { ok: false, code: 'smart_avoidance_enabled_invalid' }
    }

    // Only paid plans may toggle smart avoidance.
    if (!entitlements.smartAvoidance) {
      return { ok: false, code: 'smart_avoidance_not_allowed' }
    }

    return { ok: true, data: { enabled: enabledValue } }
  } catch {
    return { ok: false, code: 'smart_avoidance_not_object' }
  }
}

export function mergeSmartAvoidancePatch(
  existingAppearanceV2: unknown,
  patch: SmartAvoidancePatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)
  const base: AppearanceV2 = existing ?? { version: 1, desktop: {}, mobile: {} }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    smartAvoidance: { enabled: patch.enabled },
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
    ...(base.alternativeContactButtons ? { alternativeContactButtons: base.alternativeContactButtons } : {}),
    ...(base.contextChat ? { contextChat: base.contextChat } : {}),
  }
}

export function hasSmartAvoidanceField(body: Record<string, unknown>): boolean {
  return body.smartAvoidance !== undefined
}
