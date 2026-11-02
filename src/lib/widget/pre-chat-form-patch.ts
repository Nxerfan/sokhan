/**
 * Widget V2 Pre-chat Form PATCH validation + merge.
 *
 * Handles the isolated pre-chat-form update contract:
 *   - Free (basic): name + email only, max 2 fields.
 *   - Paid (advanced): all four fields, max 4.
 *   - Unknown: reject all.
 *   - paidFields: derived by merge (never client-supplied).
 *
 * Downgrade/upgrade preservation (same pattern as launcher/attention/quick-replies):
 *   - Free edit: set fields = patch.fields, preserve prior paidFields.
 *     If prior fields exceed Free scope, preserve them as paidFields.
 *   - Paid edit: set fields = patch.fields, clear paidFields.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  isValidPreChatFieldKey,
  isFieldKeyAllowed,
  getMaxFields,
  isAdvancedPreChatPlan,
  type PreChatField,
} from './pre-chat-form-types'

export interface PreChatFormPatchBody {
  preChatForm?: unknown
}

export type PreChatFormValidationResult =
  | { ok: true; data: PreChatFormPatchData }
  | { ok: false; code: PreChatFormErrorCode }

export type PreChatFormErrorCode =
  | 'pre_chat_form_not_authorized'
  | 'pre_chat_form_not_object'
  | 'pre_chat_form_fields_missing'
  | 'pre_chat_form_fields_not_array'
  | 'pre_chat_form_field_invalid'
  | 'pre_chat_form_not_allowed'
  | 'pre_chat_form_limit_exceeded'
  | 'pre_chat_form_duplicate_key'
  | 'pre_chat_form_unexpected_key'
  | 'pre_chat_form_no_fields'

export interface PreChatFormPatchData {
  fields: PreChatField[]
}

const ALLOWED_PATCH_KEYS = new Set(['fields'])

/**
 * Validate a pre-chat-form patch body against the plan entitlements.
 */
export function validatePreChatFormPatch(
  body: PreChatFormPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): PreChatFormValidationResult {
  if (!entitlements) {
    return { ok: false, code: 'pre_chat_form_not_authorized' }
  }

  if (body.preChatForm === undefined || body.preChatForm === null) {
    return { ok: false, code: 'pre_chat_form_no_fields' }
  }

  const preChatForm = body.preChatForm
  if (typeof preChatForm !== 'object' || preChatForm === null) {
    return { ok: false, code: 'pre_chat_form_not_object' }
  }
  if (Array.isArray(preChatForm)) {
    return { ok: false, code: 'pre_chat_form_not_object' }
  }

  const keys = Object.keys(preChatForm as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      return { ok: false, code: 'pre_chat_form_unexpected_key' }
    }
  }

  const obj = preChatForm as Record<string, unknown>

  if (obj.fields === undefined || obj.fields === null) {
    return { ok: false, code: 'pre_chat_form_fields_missing' }
  }
  if (!Array.isArray(obj.fields)) {
    return { ok: false, code: 'pre_chat_form_fields_not_array' }
  }

  const capability = entitlements.preChatForm
  if (capability === 'none') {
    return { ok: false, code: 'pre_chat_form_not_authorized' }
  }

  const seenKeys = new Set<string>()
  const validatedFields: PreChatField[] = []

  for (const raw of obj.fields) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, code: 'pre_chat_form_field_invalid' }
    }
    const fieldObj = raw as Record<string, unknown>

    // Check for unexpected keys on the field object.
    const fieldKeys = Object.keys(fieldObj)
    if (fieldKeys.length !== 2 || !fieldKeys.includes('key') || !fieldKeys.includes('required')) {
      return { ok: false, code: 'pre_chat_form_field_invalid' }
    }

    if (!isValidPreChatFieldKey(fieldObj.key)) {
      return { ok: false, code: 'pre_chat_form_field_invalid' }
    }

    if (typeof fieldObj.required !== 'boolean') {
      return { ok: false, code: 'pre_chat_form_field_invalid' }
    }

    // Plan entitlement check (before limit, so the correct error code is returned).
    if (!isFieldKeyAllowed(fieldObj.key, capability as 'basic' | 'advanced')) {
      return { ok: false, code: 'pre_chat_form_not_allowed' }
    }

    // Duplicate key check.
    const keyStr = fieldObj.key as string
    if (seenKeys.has(keyStr)) {
      return { ok: false, code: 'pre_chat_form_duplicate_key' }
    }
    seenKeys.add(keyStr)

    validatedFields.push({
      key: fieldObj.key as PreChatField['key'],
      required: fieldObj.required,
    })
  }

  // Limit check (after field validation so the correct error is returned first).
  const maxFields = getMaxFields(capability as 'basic' | 'advanced')
  if (validatedFields.length > maxFields) {
    return { ok: false, code: 'pre_chat_form_limit_exceeded' }
  }

  return { ok: true, data: { fields: validatedFields } }
}

/**
 * Merge a validated pre-chat-form patch into the existing stored appearanceV2.
 */
export function mergePreChatFormPatch(
  existingAppearanceV2: unknown,
  patch: PreChatFormPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)
  const base: AppearanceV2 = existing ?? { version: 1, desktop: {}, mobile: {} }
  const existingPcf = existing?.preChatForm

  const pcfConfig: NonNullable<AppearanceV2['preChatForm']> = {
    fields: patch.fields,
  }

  if (entitlements && isAdvancedPreChatPlan(entitlements.preChatForm)) {
    // Paid (advanced): clear paidFields — explicit selection.
  } else {
    // Free (basic) or unknown: preserve paidFields.
    if (existingPcf?.paidFields && existingPcf.paidFields.length > 0) {
      pcfConfig.paidFields = existingPcf.paidFields
    }
    // If existing fields exceed Free scope, preserve as paidFields.
    if (!pcfConfig.paidFields && existingPcf?.fields) {
      const hasAdvancedOnly = existingPcf.fields.some(
        f => f.key === 'phone' || f.key === 'company',
      )
      if (hasAdvancedOnly || existingPcf.fields.length > 2) {
        pcfConfig.paidFields = existingPcf.fields
      }
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    preChatForm: pcfConfig,
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.pageVisibility ? { pageVisibility: base.pageVisibility } : {}),
  }
}

export function hasPreChatFormField(body: Record<string, unknown>): boolean {
  return body.preChatForm !== undefined
}
