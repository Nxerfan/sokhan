/**
 * Widget V2 Quick Replies PATCH validation + merge.
 *
 * Handles the isolated quick-replies update contract:
 *   - Free (max 2): accepts 0–2 items. 3+ → `quick_replies_limit_exceeded`.
 *   - Paid (max 10): accepts 0–10 items. 11+ → `quick_replies_limit_exceeded`.
 *   - Unknown plans: every patch rejected.
 *
 * Text rules (per item):
 *   - 1–80 Unicode code points.
 *   - No blank, whitespace-padded, or multiline labels.
 *   - No case-insensitive duplicates within the list.
 *
 * PATCH must NOT contain `paidItems` — it is derived by the merge.
 *
 * Downgrade/upgrade preservation (mirrors the launcher/attention pattern):
 *   - Free edit: set `items` = patch.items. Preserve prior `paidItems`.
 *     If the prior `items` exceed the Free max, preserve them as `paidItems`.
 *   - Pro edit: set `items` = patch.items. Clear `paidItems` (explicit Pro
 *     selection replaces any prior paid preference — no stale-preference bug).
 *
 * True-patch semantics:
 *   - Editing quickReplies does NOT reset positioning, colors, launcher,
 *     attention, or messagePreview.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  FREE_QUICK_REPLIES_MAX,
  isAdvancedQuickRepliesPlan,
  normalizeQuickReplyText,
  hasCaseInsensitiveDuplicate,
} from './quick-replies-types'

/** The quick-replies patch payload shape (from the dashboard PATCH body). */
export interface QuickRepliesPatchBody {
  quickReplies?: unknown
}

/** Result of validating a quick-replies patch. */
export type QuickRepliesValidationResult =
  | { ok: true; data: QuickRepliesPatchData }
  | { ok: false; code: QuickRepliesErrorCode }

/** Error codes for quick-replies PATCH validation. */
export type QuickRepliesErrorCode =
  | 'quick_replies_not_authorized'
  | 'quick_replies_not_object'
  | 'quick_replies_items_missing'
  | 'quick_replies_items_not_array'
  | 'quick_replies_item_invalid'
  | 'quick_replies_limit_exceeded'
  | 'quick_replies_duplicate'
  | 'quick_replies_unexpected_key'
  | 'quick_replies_no_fields'

/** A validated quick-replies patch. */
export interface QuickRepliesPatchData {
  items: string[]
}

/** Allowed keys in the quick-replies patch body. */
const ALLOWED_QUICK_REPLIES_KEYS = new Set(['items'])

/**
 * Validate a quick-replies patch body against the plan entitlements.
 *
 * The `body.quickReplies` field is expected to be:
 *   { items: ['Pricing', 'Features'] }
 *
 * `paidItems` is NEVER accepted from the caller — it can only be derived by
 * the merge during a downgrade.
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validateQuickRepliesPatch(
  body: QuickRepliesPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): QuickRepliesValidationResult {
  // FAIL CLOSED: unknown plans.
  if (!entitlements) {
    return { ok: false, code: 'quick_replies_not_authorized' }
  }

  if (body.quickReplies === undefined || body.quickReplies === null) {
    return { ok: false, code: 'quick_replies_no_fields' }
  }

  const quickReplies = body.quickReplies

  if (typeof quickReplies !== 'object' || quickReplies === null) {
    return { ok: false, code: 'quick_replies_not_object' }
  }
  if (Array.isArray(quickReplies)) {
    return { ok: false, code: 'quick_replies_not_object' }
  }

  // Check for unexpected keys (paidItems, plan, css, etc. are all rejected).
  const keys = Object.keys(quickReplies as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_QUICK_REPLIES_KEYS.has(key)) {
      return { ok: false, code: 'quick_replies_unexpected_key' }
    }
  }

  const obj = quickReplies as Record<string, unknown>

  // items — required, must be an array.
  if (obj.items === undefined || obj.items === null) {
    return { ok: false, code: 'quick_replies_items_missing' }
  }
  if (!Array.isArray(obj.items)) {
    return { ok: false, code: 'quick_replies_items_not_array' }
  }

  // Validate each item: must be a valid string (1-80 code points, non-blank,
  // single-line). Normalize (trim) each item.
  const normalized: string[] = []
  for (const raw of obj.items) {
    const text = normalizeQuickReplyText(raw)
    if (text === null) {
      return { ok: false, code: 'quick_replies_item_invalid' }
    }
    normalized.push(text)
  }

  // Case-insensitive duplicate check.
  if (hasCaseInsensitiveDuplicate(normalized)) {
    return { ok: false, code: 'quick_replies_duplicate' }
  }

  // Plan limit check.
  const max = entitlements.quickReplies
  if (normalized.length > max) {
    return { ok: false, code: 'quick_replies_limit_exceeded' }
  }

  return { ok: true, data: { items: normalized } }
}

/**
 * Merge a validated quick-replies patch into the existing stored appearanceV2.
 *
 * Downgrade/upgrade preservation:
 *   - Free (limited): set items = patch.items. Preserve existing paidItems.
 *     If the existing items exceed the Free max and no paidItems exist yet,
 *     preserve the existing items as paidItems.
 *   - Pro (advanced): set items = patch.items. Clear paidItems — the explicit
 *     Pro selection replaces any prior paid preference (no stale-preference
 *     equality bug).
 *
 * True-patch: preserves colors, launcher, attention, messagePreview,
 * desktop/mobile positioning.
 */
export function mergeQuickRepliesPatch(
  existingAppearanceV2: unknown,
  patch: QuickRepliesPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  const existingQr = existing?.quickReplies
  const newItems = patch.items

  // Build the new quick-replies config.
  const qrConfig: NonNullable<AppearanceV2['quickReplies']> = {
    items: newItems,
  }

  if (entitlements && isAdvancedQuickRepliesPlan(entitlements.quickReplies)) {
    // Pro (advanced): explicit selection. Clear paidItems — the user's
    // explicit choice replaces any prior paid preference, even when the
    // new items equal the stored Free items (no stale-preference bug).
    // No paidItems set.
  } else {
    // Free (limited) or unknown: preserve paid preference for upgrade restore.
    // 1. If existing paidItems exist, carry them forward.
    if (existingQr?.paidItems && existingQr.paidItems.length > 0) {
      qrConfig.paidItems = existingQr.paidItems
    }
    // 2. If the existing items exceed the Free max and we don't already have
    //    paidItems, preserve the existing items as paidItems. This captures
    //    the downgrade from Pro (10 items) to Free (2 items).
    if (!qrConfig.paidItems && existingQr?.items && existingQr.items.length > FREE_QUICK_REPLIES_MAX) {
      qrConfig.paidItems = existingQr.items
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    quickReplies: qrConfig,
    // Preserve all other V2 capabilities.
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
  }
}

/**
 * Check if the PATCH body contains a `quickReplies` field.
 */
export function hasQuickRepliesField(body: Record<string, unknown>): boolean {
  return body.quickReplies !== undefined
}
