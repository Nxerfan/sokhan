/**
 * Widget V2 Alternative Contact Buttons PATCH validation + merge.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  isValidAlternativeContactButton,
  type AlternativeContactButton,
  type AlternativeContactKind,
} from './alternative-contact-types'

export interface AlternativeContactButtonsPatchBody {
  alternativeContactButtons?: unknown
}

export type AlternativeContactButtonsValidationResult =
  | { ok: true; data: AlternativeContactButtonsPatchData }
  | { ok: false; code: AlternativeContactButtonsErrorCode }

export type AlternativeContactButtonsErrorCode =
  | 'alt_contact_not_authorized'
  | 'alt_contact_not_object'
  | 'alt_contact_items_missing'
  | 'alt_contact_items_not_array'
  | 'alt_contact_item_invalid'
  | 'alt_contact_limit_exceeded'
  | 'alt_contact_duplicate_kind'
  | 'alt_contact_unexpected_key'
  | 'alt_contact_no_fields'

export interface AlternativeContactButtonsPatchData {
  items: AlternativeContactButton[]
}

const ALLOWED_PATCH_KEYS = new Set(['items'])

export function validateAlternativeContactButtonsPatch(
  body: AlternativeContactButtonsPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): AlternativeContactButtonsValidationResult {
  if (!entitlements) {
    return { ok: false, code: 'alt_contact_not_authorized' }
  }

  if (body.alternativeContactButtons === undefined || body.alternativeContactButtons === null) {
    return { ok: false, code: 'alt_contact_no_fields' }
  }

  const acb = body.alternativeContactButtons
  if (typeof acb !== 'object' || acb === null || Array.isArray(acb)) {
    return { ok: false, code: 'alt_contact_not_object' }
  }

  // Use getOwnPropertyDescriptors to safely check keys without triggering getters.
  const obj = acb as Record<string, unknown>
  const ownKeys = Reflect.ownKeys(obj)
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !ALLOWED_PATCH_KEYS.has(key)) {
      return { ok: false, code: 'alt_contact_unexpected_key' }
    }
  }

  // Safely read items via descriptor to bypass getter traps.
  let itemsValue: unknown
  try {
    const itemsDesc = Object.getOwnPropertyDescriptor(obj, 'items')
    if (!itemsDesc) {
      return { ok: false, code: 'alt_contact_items_missing' }
    }
    if ('value' in itemsDesc) {
      itemsValue = itemsDesc.value
    } else {
      // Accessor property — treat as invalid (no getters allowed).
      return { ok: false, code: 'alt_contact_unexpected_key' }
    }
  } catch {
    return { ok: false, code: 'alt_contact_item_invalid' }
  }

  if (itemsValue === undefined || itemsValue === null) {
    return { ok: false, code: 'alt_contact_items_missing' }
  }
  if (!Array.isArray(itemsValue)) {
    return { ok: false, code: 'alt_contact_items_not_array' }
  }

  const max = entitlements.alternativeContactButtons
  if (max === 0) {
    return { ok: false, code: 'alt_contact_not_authorized' }
  }

  const seenKinds = new Set<string>()
  const validatedItems: AlternativeContactButton[] = []

  for (const raw of itemsValue) {
    if (!isValidAlternativeContactButton(raw)) {
      return { ok: false, code: 'alt_contact_item_invalid' }
    }
    const item = raw as AlternativeContactButton
    // Duplicate kind check.
    if (seenKinds.has(item.kind)) {
      return { ok: false, code: 'alt_contact_duplicate_kind' }
    }
    seenKinds.add(item.kind)
    validatedItems.push(item)
  }

  if (validatedItems.length > max) {
    return { ok: false, code: 'alt_contact_limit_exceeded' }
  }

  return { ok: true, data: { items: validatedItems } }
}

export function mergeAlternativeContactButtonsPatch(
  existingAppearanceV2: unknown,
  patch: AlternativeContactButtonsPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)
  const base: AppearanceV2 = existing ?? { version: 1, desktop: {}, mobile: {} }
  const existingAcb = existing?.alternativeContactButtons

  const acbConfig: NonNullable<AppearanceV2['alternativeContactButtons']> = {
    items: patch.items,
  }

  const max = entitlements?.alternativeContactButtons ?? 0
  const isPaid = max > 2

  if (isPaid) {
    // Paid: clear paidItems.
  } else {
    // Free or unknown: preserve paidItems.
    if (existingAcb?.paidItems && existingAcb.paidItems.length > 0) {
      acbConfig.paidItems = existingAcb.paidItems
    }
    // If existing items exceed Free scope, preserve as paidItems.
    if (!acbConfig.paidItems && existingAcb?.items && existingAcb.items.length > max) {
      acbConfig.paidItems = existingAcb.items
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    alternativeContactButtons: acbConfig,
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
    ...(base.smartAvoidance ? { smartAvoidance: base.smartAvoidance } : {}),
    ...(base.contextChat ? { contextChat: base.contextChat } : {}),
  }
}

export function hasAlternativeContactButtonsField(body: Record<string, unknown>): boolean {
  return body.alternativeContactButtons !== undefined
}
