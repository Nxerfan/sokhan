/**
 * Pre-chat Form policy — pure submission validation + requirement logic.
 *
 * Feature 7 — Pre-chat Form.
 *
 * validatePreChatSubmission: validates visitor-submitted form values against
 * the server-authoritative effective form configuration.
 *
 * shouldRequirePreChat: determines whether the form must be displayed.
 *
 * Pure TS — no Prisma, no Next.js, no browser dependencies.
 */

import {
  NAME_MAX_CODE_POINTS,
  EMAIL_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  COMPANY_MAX_CODE_POINTS,
  type PreChatField,
} from './pre-chat-form-types'

/** The effective form shape used for submission validation. */
export interface EffectiveFormConfig {
  fields: PreChatField[]
}

/** Result of validating a pre-chat submission. */
export type PreChatSubmissionResult =
  | { ok: true; data: Record<string, string> }
  | { ok: false; code: string }

// Simple email validation — not RFC-comprehensive but rejects clearly
// malformed addresses. Requires exactly one '@' with non-empty local
// and domain parts, and a domain with at least one dot.
function isValidEmail(value: string): boolean {
  if (value.length > EMAIL_MAX_LENGTH) return false
  const atIdx = value.indexOf('@')
  if (atIdx < 1) return false
  const domain = value.slice(atIdx + 1)
  if (domain.length < 3) return false
  if (domain.indexOf('.') < 1) return false
  // Reject spaces and control chars.
  if (/\s/.test(value)) return false
  return true
}

// Phone validation: allows digits, spaces, +, -, (), and a leading
// international prefix. Bounded length.
function isValidPhone(value: string): boolean {
  if (value.length > PHONE_MAX_LENGTH) return false
  // Allow: +, digits, spaces, hyphens, parentheses.
  return /^[+]?[\d\s\-()]+$/.test(value)
}

/**
 * Validate visitor-submitted pre-chat form values.
 *
 * Only keys configured in the effective server-side form are accepted.
 * Required fields must be present and nonblank.
 * Unknown keys (including privilege-escalation attempts like
 * emailVerifiedAt, identityLevel, role) are rejected.
 */
export function validatePreChatSubmission(
  body: unknown,
  effectiveForm: EffectiveFormConfig,
): PreChatSubmissionResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'pre_chat_invalid_body' }
  }

  const bodyObj = body as Record<string, unknown>
  const values = bodyObj.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, code: 'pre_chat_invalid_values' }
  }

  const valuesObj = values as Record<string, unknown>

  // If no fields are configured, reject all submissions.
  if (!effectiveForm.fields || effectiveForm.fields.length === 0) {
    return { ok: false, code: 'pre_chat_not_configured' }
  }

  // Build the set of allowed keys from the effective form.
  const allowedKeys = new Set(effectiveForm.fields.map(f => f.key))
  const result: Record<string, string> = {}

  // Reject unknown keys (including privilege-escalation attempts).
  for (const key of Object.keys(valuesObj)) {
    if (!allowedKeys.has(key as never)) {
      return { ok: false, code: 'pre_chat_unknown_field' }
    }
  }

  // Validate each configured field.
  for (const field of effectiveForm.fields) {
    const raw = valuesObj[field.key]

    if (raw === undefined || raw === null || raw === '') {
      if (field.required) {
        return { ok: false, code: 'pre_chat_field_required' }
      }
      // Optional field omitted — fine.
      continue
    }

    if (typeof raw !== 'string') {
      return { ok: false, code: 'pre_chat_field_invalid_type' }
    }

    const value = raw.trim()
    if (field.required && value === '') {
      return { ok: false, code: 'pre_chat_field_required' }
    }

    // Field-specific validation.
    switch (field.key) {
      case 'name': {
        if (Array.from(value).length > NAME_MAX_CODE_POINTS) {
          return { ok: false, code: 'pre_chat_field_too_long' }
        }
        break
      }
      case 'email': {
        if (!isValidEmail(value)) {
          return { ok: false, code: 'pre_chat_field_invalid_email' }
        }
        break
      }
      case 'phone': {
        if (!isValidPhone(value)) {
          return { ok: false, code: 'pre_chat_field_invalid_phone' }
        }
        break
      }
      case 'company': {
        if (Array.from(value).length > COMPANY_MAX_CODE_POINTS) {
          return { ok: false, code: 'pre_chat_field_too_long' }
        }
        break
      }
    }

    if (value !== '') {
      result[field.key] = value
    }
  }

  return { ok: true, data: result }
}

/**
 * Determine whether the pre-chat form should be required (displayed).
 *
 * Returns true only when:
 *   1. The effective form has configured fields.
 *   2. The visitor has NOT previously persisted a message.
 *   3. The form has NOT already been completed.
 */
export function shouldRequirePreChat(
  effectiveForm: EffectiveFormConfig,
  hasPersistedVisitorMessage: boolean,
  hasCompletedForm: boolean,
): boolean {
  if (!effectiveForm.fields || effectiveForm.fields.length === 0) return false
  if (hasPersistedVisitorMessage) return false
  if (hasCompletedForm) return false
  return true
}
