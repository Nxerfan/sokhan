/**
 * Widget V2 Message Preview PATCH validation + merge.
 *
 * Handles the isolated message-preview update contract:
 *   - Free (messagePreview: false) → EVERY patch is rejected with 403
 *     `message_preview_not_allowed` (even `enabled: false`).
 *   - Paid (messagePreview: true) → accepts `enabled: true | false`.
 *   - Unknown plans → every patch rejected.
 *
 * True-patch semantics:
 *   - Editing messagePreview does NOT reset positioning, colors, launcher,
 *     or attention.
 *   - The stored preference is a plain `{ enabled: boolean }` — no paid-
 *     preservation field is needed (the resolver enforces the entitlement,
 *     so a stored `true` is simply ignored on Free and restored on upgrade).
 *
 * Pure TS — no Prisma, no Next.js. Used by the API route handler.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

/** The message-preview patch payload shape (from the dashboard PATCH body). */
export interface MessagePreviewPatchBody {
  messagePreview?: unknown
}

/** Result of validating a message-preview patch. */
export type MessagePreviewValidationResult =
  | { ok: true; data: MessagePreviewPatchData }
  | { ok: false; code: MessagePreviewErrorCode }

/** Error codes for message-preview PATCH validation. */
export type MessagePreviewErrorCode =
  | 'message_preview_not_authorized'
  | 'message_preview_not_object'
  | 'message_preview_enabled_missing'
  | 'message_preview_enabled_invalid'
  | 'message_preview_not_allowed'
  | 'message_preview_unexpected_key'
  | 'message_preview_no_fields'

/** A validated message-preview patch. */
export interface MessagePreviewPatchData {
  enabled: boolean
}

/** Allowed keys in the message-preview patch body. */
const ALLOWED_MESSAGE_PREVIEW_KEYS = new Set(['enabled'])

/**
 * Validate a message-preview patch body against the plan entitlements.
 *
 * The `body.messagePreview` field is expected to be:
 *   { enabled: true }  or  { enabled: false }
 *
 * Free plan: EVERY patch (enable or disable) is rejected with 403
 * `message_preview_not_allowed` — Free cannot modify the preference at all.
 *
 * Paid plans: accepts `enabled: boolean`. Unknown plans: rejected.
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validateMessagePreviewPatch(
  body: MessagePreviewPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): MessagePreviewValidationResult {
  // FAIL CLOSED: unknown plans or plans without messagePreview capability.
  if (!entitlements) {
    return { ok: false, code: 'message_preview_not_authorized' }
  }

  if (body.messagePreview === undefined || body.messagePreview === null) {
    return { ok: false, code: 'message_preview_no_fields' }
  }

  const messagePreview = body.messagePreview

  if (typeof messagePreview !== 'object' || messagePreview === null) {
    return { ok: false, code: 'message_preview_not_object' }
  }
  if (Array.isArray(messagePreview)) {
    return { ok: false, code: 'message_preview_not_object' }
  }

  // Check for unexpected keys (text, plan, css, etc. are all rejected).
  const keys = Object.keys(messagePreview as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_MESSAGE_PREVIEW_KEYS.has(key)) {
      return { ok: false, code: 'message_preview_unexpected_key' }
    }
  }

  const obj = messagePreview as Record<string, unknown>

  // enabled — required, must be a strict boolean.
  if (obj.enabled === undefined || obj.enabled === null) {
    return { ok: false, code: 'message_preview_enabled_missing' }
  }
  if (typeof obj.enabled !== 'boolean') {
    return { ok: false, code: 'message_preview_enabled_invalid' }
  }

  // Entitlement gate: Free cannot patch messagePreview at all (even false).
  // The stored preference is managed exclusively by paid plans.
  if (!entitlements.messagePreview) {
    return { ok: false, code: 'message_preview_not_allowed' }
  }

  return { ok: true, data: { enabled: obj.enabled } }
}

/**
 * Merge a validated message-preview patch into the existing stored appearanceV2.
 *
 * True-patch semantics:
 *   - Editing messagePreview does NOT reset positioning, colors, launcher,
 *     or attention.
 *   - The stored preference is a plain `{ enabled: boolean }` — no
 *     paid-preservation field (the resolver enforces the entitlement).
 *
 * Returns the new appearanceV2 object (always valid, always canonical).
 */
export function mergeMessagePreviewPatch(
  existingAppearanceV2: unknown,
  patch: MessagePreviewPatchData,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    messagePreview: { enabled: patch.enabled },
    // Preserve all other V2 capabilities.
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
    ...(base.alternativeContactButtons ? { alternativeContactButtons: base.alternativeContactButtons } : {}),
  }
}

/**
 * Check if the PATCH body contains a `messagePreview` field.
 */
export function hasMessagePreviewField(body: Record<string, unknown>): boolean {
  return body.messagePreview !== undefined
}
