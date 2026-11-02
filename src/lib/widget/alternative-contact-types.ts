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
 */
export function isValidAlternativeContactButton(value: unknown): value is AlternativeContactButton {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  // Must have exactly kind, label, value — no extra keys.
  const keys = Object.keys(obj)
  if (keys.length !== 3 || !keys.includes('kind') || !keys.includes('label') || !keys.includes('value')) return false
  if (typeof obj.kind !== 'string' || !(ALTERNATIVE_CONTACT_KINDS as readonly string[]).includes(obj.kind)) return false
  if (typeof obj.label !== 'string' || typeof obj.value !== 'string') return false
  // Label: 1-40 code points, non-blank, no whitespace padding, single line.
  if (obj.label.trim() === '') return false
  if (obj.label !== obj.label.trim()) return false
  if (obj.label.includes('\n') || obj.label.includes('\r')) return false
  if (Array.from(obj.label).length > LABEL_MAX_CODE_POINTS) return false
  // Value: non-empty, bounded.
  if (obj.value.length === 0 || obj.value.length > VALUE_MAX_LENGTH) return false
  return validateContactValue(obj.kind as AlternativeContactKind, obj.value)
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
      // Valid email, must NOT contain 'mailto:' prefix.
      if (value.startsWith('mailto:')) return false
      if (value.includes(' ') || value.includes('<') || value.includes('>')) return false
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
