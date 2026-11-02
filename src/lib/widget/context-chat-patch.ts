/**
 * Widget V2 Context Chat PATCH validation + merge (Feature 11 — BETA).
 *
 *   - Free (contextChat: false) → rejects BOTH true AND false toggles
 *     (403 context_chat_not_allowed — the specific entitlement error, not
 *     the legacy 402 plan lock).
 *   - Paid (contextChat: true) → accepts `{ enabled: boolean }` exactly.
 *   - Unknown / null entitlements → rejects (fail closed).
 *
 * True-patch: merging a Context Chat patch preserves every neighboring V2
 * capability (colors, launcher, attention, messagePreview, quickReplies,
 * preChatForm, pageVisibility, alternativeContactButtons, smartAvoidance,
 * positioning) and vice versa.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

export interface ContextChatPatchBody {
  contextChat?: unknown
}

export type ContextChatValidationResult =
  | { ok: true; data: ContextChatPatchData }
  | { ok: false; code: ContextChatErrorCode }

export type ContextChatErrorCode =
  | 'context_chat_not_authorized'
  | 'context_chat_not_object'
  | 'context_chat_enabled_missing'
  | 'context_chat_enabled_invalid'
  | 'context_chat_not_allowed'
  | 'context_chat_unexpected_key'
  | 'context_chat_no_fields'

export interface ContextChatPatchData {
  enabled: boolean
}

/**
 * Validate a context-chat patch body against the plan entitlements.
 * Uses safe property descriptor inspection to avoid executing getters.
 */
export function validateContextChatPatch(
  body: ContextChatPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): ContextChatValidationResult {
  if (!entitlements) {
    return { ok: false, code: 'context_chat_not_authorized' }
  }

  if (body.contextChat === undefined || body.contextChat === null) {
    return { ok: false, code: 'context_chat_no_fields' }
  }

  const cc = body.contextChat
  if (typeof cc !== 'object' || cc === null || Array.isArray(cc)) {
    return { ok: false, code: 'context_chat_not_object' }
  }

  // Use descriptors to safely read keys without triggering getters.
  try {
    const ownKeys = Reflect.ownKeys(cc)
    if (ownKeys.length !== 1 || ownKeys[0] !== 'enabled') {
      return { ok: false, code: 'context_chat_unexpected_key' }
    }

    const desc = Object.getOwnPropertyDescriptor(cc, 'enabled')
    if (!desc || !('value' in desc)) {
      return { ok: false, code: 'context_chat_enabled_invalid' }
    }

    const enabledValue = desc.value
    if (enabledValue === undefined || enabledValue === null) {
      return { ok: false, code: 'context_chat_enabled_missing' }
    }
    if (typeof enabledValue !== 'boolean') {
      return { ok: false, code: 'context_chat_enabled_invalid' }
    }

    // Only paid plans may toggle Context Chat. The stored preference of a
    // downgraded tenant is preserved (restore-on-upgrade) but never
    // writable on Free.
    if (!entitlements.contextChat) {
      return { ok: false, code: 'context_chat_not_allowed' }
    }

    return { ok: true, data: { enabled: enabledValue } }
  } catch {
    return { ok: false, code: 'context_chat_not_object' }
  }
}

export function mergeContextChatPatch(
  existingAppearanceV2: unknown,
  patch: ContextChatPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)
  const base: AppearanceV2 = existing ?? { version: 1, desktop: {}, mobile: {} }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    contextChat: { enabled: patch.enabled },
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
    ...(base.alternativeContactButtons ? { alternativeContactButtons: base.alternativeContactButtons } : {}),
    ...(base.smartAvoidance ? { smartAvoidance: base.smartAvoidance } : {}),
  }
}

export function hasContextChatField(body: Record<string, unknown>): boolean {
  return body.contextChat !== undefined
}
