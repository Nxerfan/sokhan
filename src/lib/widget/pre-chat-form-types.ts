/**
 * Pre-chat Form types + validation helpers — standalone module.
 *
 * Feature 7 — Pre-chat Form.
 *
 * Field keys: 'name' | 'email' | 'phone' | 'company'
 * Plan limits:
 *   Free (preChatForm: 'basic'): name + email, max 2 fields.
 *   Pro/Max/Self-hosted (preChatForm: 'advanced'): all four, max 4 fields.
 *   Unknown: fail closed (no form).
 */

/** Allowed pre-chat field keys. */
export const PRE_CHAT_FIELD_KEYS = ['name', 'email', 'phone', 'company'] as const
export type PreChatFieldKey = (typeof PRE_CHAT_FIELD_KEYS)[number]

/** Fields available on the Free (basic) plan. */
export const BASIC_PRE_CHAT_FIELDS: readonly PreChatFieldKey[] = ['name', 'email']

/** Fields that are advanced-only (not available on Free). */
export const ADVANCED_ONLY_PRE_CHAT_FIELDS: readonly PreChatFieldKey[] = ['phone', 'company']

/** A single pre-chat field configuration. */
export interface PreChatField {
  key: PreChatFieldKey
  required: boolean
}

/** Max Unicode code points per field value. */
export const NAME_MAX_CODE_POINTS = 100
export const EMAIL_MAX_LENGTH = 200
export const PHONE_MAX_LENGTH = 50
export const COMPANY_MAX_CODE_POINTS = 100

/**
 * Check if a field key is valid.
 */
export function isValidPreChatFieldKey(value: unknown): value is PreChatFieldKey {
  if (typeof value !== 'string') return false
  return (PRE_CHAT_FIELD_KEYS as readonly string[]).includes(value)
}

/**
 * Check if a field key is available on the Free (basic) plan.
 */
export function isBasicPreChatField(key: PreChatFieldKey): boolean {
  return BASIC_PRE_CHAT_FIELDS.includes(key)
}

/**
 * Check if the plan's preChatForm capability is 'advanced' (paid).
 */
export function isAdvancedPreChatPlan(capability: string): boolean {
  return capability === 'advanced'
}

/**
 * Validate a field key against the plan capability.
 * Returns true if the key is allowed for the given plan.
 */
export function isFieldKeyAllowed(
  key: PreChatFieldKey,
  capability: 'basic' | 'advanced',
): boolean {
  if (capability === 'advanced') return true
  return isBasicPreChatField(key)
}

/**
 * Get the maximum number of fields for a plan capability.
 */
export function getMaxFields(capability: 'basic' | 'advanced'): number {
  return capability === 'advanced' ? 4 : 2
}
