/**
 * Smart Avoidance types + validation.
 *
 * Feature 10 — Smart Avoidance (BETA).
 */

/**
 * Validate a smartAvoidance config object.
 * Uses safe own-property descriptor inspection to avoid executing getters.
 */
export function isValidSmartAvoidanceConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 1) return false
    if (ownKeys[0] !== 'enabled') return false
    const desc = Object.getOwnPropertyDescriptor(value, 'enabled')
    if (!desc || !('value' in desc)) return false // accessor — reject
    return typeof desc.value === 'boolean'
  } catch {
    return false
  }
}
