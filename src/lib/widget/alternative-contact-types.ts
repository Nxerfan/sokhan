/**
 * Alternative Contact Button types + validation helpers.
 *
 * Feature 9 — Alternative Contact Buttons.
 *
 * Supported kinds: phone, email, whatsapp, telegram, website.
 * Each item: { kind, label, value } — the app derives the safe href.
 */

export type AlternativeContactKind = 'phone' | 'email' | 'whatsapp' | 'telegram' | 'website'

export interface AlternativeContactButton {
  kind: AlternativeContactKind
  label: string
  value: string
}

export const ALTERNATIVE_CONTACT_KINDS = ['phone', 'email', 'whatsapp', 'telegram', 'website'] as const

export const LABEL_MAX_CODE_POINTS = 40
export const VALUE_MAX_LENGTH = 500

/**
 * Validate a single alternative contact button.
 * Returns true if the button is structurally valid (does NOT check plan limits).
 *
 * Uses safe own-property descriptor inspection to avoid executing accessor
 * (getter) properties. Rejects accessor-backed properties, symbols, and
 * malformed objects without triggering getters.
 */
export function isValidAlternativeContactButton(value: unknown): value is AlternativeContactButton {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  // Use Reflect.ownKeys to detect symbols (which are always invalid).
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 3) return false
    for (const k of ownKeys) {
      if (typeof k !== 'string') return false // Symbol keys rejected
      if (k !== 'kind' && k !== 'label' && k !== 'value') return false
    }
  } catch {
    return false
  }
  // Read via descriptors to avoid triggering getters.
  const kindDesc = safeGetDataDescriptor(value, 'kind')
  if (!kindDesc) return false
  const kind = kindDesc.value
  if (typeof kind !== 'string' || !(ALTERNATIVE_CONTACT_KINDS as readonly string[]).includes(kind)) return false
  const labelDesc = safeGetDataDescriptor(value, 'label')
  if (!labelDesc) return false
  const label = labelDesc.value
  if (typeof label !== 'string') return false
  // Label: 1-40 code points, non-blank, no whitespace padding, single line.
  if (label.trim() === '') return false
  if (label !== label.trim()) return false
  if (label.includes('\n') || label.includes('\r')) return false
  if (Array.from(label).length > LABEL_MAX_CODE_POINTS) return false
  // Value: read via descriptor, then validate.
  const valueDesc = safeGetDataDescriptor(value, 'value')
  if (!valueDesc) return false
  const val = valueDesc.value
  if (typeof val !== 'string') return false
  if (val.length === 0 || val.length > VALUE_MAX_LENGTH) return false
  return validateContactValue(kind as AlternativeContactKind, val)
}

/**
 * Safely get an own DATA property descriptor (not an accessor).
 * Returns { value } if the property exists as a data descriptor, or null
 * if it's an accessor, missing, or if reflection throws.
 */
function safeGetDataDescriptor(obj: object, key: string): { value: unknown } | null {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) return null // not an own property
    if (!('value' in desc)) return null // accessor property (getter/setter) — reject
    return desc as { value: unknown }
  } catch {
    return null
  }
}

/**
 * Validate the value field for a specific contact kind.
 */
export function validateContactValue(kind: AlternativeContactKind, value: string): boolean {
  switch (kind) {
    case 'phone':
      // International phone: starts with +, digits, spaces, hyphens allowed.
      // Must NOT contain 'tel:' prefix or scripts.
      if (value.startsWith('tel:')) return false
      if (value.includes('<') || value.includes('>')) return false
      return /^\+[\d\s\-()]+$/.test(value) && value.replace(/[\s\-()]/g, '').length >= 8
    case 'email':
      // Valid email ADDRESS only — reject mailto: prefix, query parameters,
      // fragments, percent-encoded sequences, and control characters.
      if (value.startsWith('mailto:')) return false
      if (value.includes(' ') || value.includes('<') || value.includes('>')) return false
      // Reject query parameters (?subject=, ?body=, ?bcc=, etc.) and fragments.
      if (value.includes('?') || value.includes('#')) return false
      // Reject percent-encoded sequences (could encode CR/LF or other control chars).
      if (value.includes('%')) return false
      // Reject raw control characters.
      if (/[\r\n\0]/.test(value)) return false
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200
    case 'whatsapp':
      // International phone number (same as phone, without the '+' requirement
      // — WhatsApp accepts both +98912... and 98912...).
      if (value.startsWith('http') || value.includes('wa.me')) return false
      if (value.includes('<') || value.includes('>')) return false
      const waClean = value.replace(/[\s\-()]/g, '')
      return /^\+?\d{8,}$/.test(waClean)
    case 'telegram':
      // Telegram username: alphanumeric + underscores, no @ prefix.
      if (value.startsWith('http') || value.includes('t.me')) return false
      if (value.startsWith('@')) return false
      if (value.includes('/') || value.includes('\\') || value.includes(' ')) return false
      if (value.includes('<') || value.includes('>')) return false
      return /^[a-zA-Z0-9_]{3,}$/.test(value)
    case 'website':
      // Must be HTTPS, no credentials, no dangerous schemes.
      if (!value.startsWith('https://')) return false
      // Reject newlines, control characters, and trailing whitespace.
      if (!/^https:\/\/[^\s\n\r\t\\]+$/.test(value)) return false
      // Reject credentials in URL.
      try {
        const url = new URL(value)
        if (url.username || url.password) return false
        if (url.protocol !== 'https:') return false
      } catch {
        return false
      }
      return true
    default:
      return false
  }
}

/**
 * Build a safe href destination from a validated contact button.
 * The href is derived from kind + value — never from a client-supplied href.
 */
export function buildAlternativeContactHref(button: AlternativeContactButton): string {
  switch (button.kind) {
    case 'phone':
      return 'tel:' + button.value
    case 'email':
      return 'mailto:' + button.value
    case 'whatsapp': {
      // Strip leading + and non-digits for wa.me.
      const digits = button.value.replace(/[^\d]/g, '')
      return 'https://wa.me/' + digits
    }
    case 'telegram':
      return 'https://t.me/' + button.value
    case 'website':
      return button.value // Already validated as HTTPS.
    default:
      return '#'
  }
}

/**
 * Get the max items for a plan's alternativeContactButtons entitlement.
 */
export function getMaxAlternativeContactButtons(max: number): number {
  return max
}
