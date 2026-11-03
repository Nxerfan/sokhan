/**
 * AI-Q1 — Strict AI configuration PATCH policy.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for Unit
 * testing and server-side import.
 *
 * ## Problem this solves
 *
 * The original PATCH handler used `body.faqEnabled ?? false` and
 * `body.productQaEnabled ?? false`. The `?? false` fallback RESET an
 * omitted flag to false on every PATCH — so toggling FAQ off silently
 * cleared Product Q&A, and vice versa. This module enforces TRUE-PATCH
 * semantics: only the mutable keys explicitly provided in a validated
 * patch are applied; omitted flags preserve their currently stored value.
 *
 * ## Security
 *
 * - Permits exactly the two mutable keys `faqEnabled` and `productQaEnabled`.
 * - Values MUST be actual booleans (typeof === 'boolean'), never truthy/falsy
 *   coercion.
 * - Rejects null, primitives, arrays, empty objects and unknown keys.
 * - Rejects symbol keys.
 * - Rejects accessor-backed properties WITHOUT invoking the getter
 *   (checked via Object.getOwnPropertyDescriptor before any value access).
 * - Rejects inherited / prototype-backed untrusted payloads (Object.create,
 *   new Boolean, etc.) via a strict prototype check.
 * - Rejects attempts to modify `tenantId`, `aiActionCount`, `aiActionResetAt`
 *   or any other stored field (those are not in the mutable key set).
 * - Returns a fresh, validated object — never the caller's reference.
 * - Never mutates the caller's payload or the saved state.
 * - Any malformed patch returns null; never silently resets another flag.
 */

/** The two AI feature flags owned by the AI config record. */
export type AiConfigFlags = {
  faqEnabled: boolean
  productQaEnabled: boolean
}

/** The only keys a PATCH may legally provide. */
const MUTABLE_KEYS = ['faqEnabled', 'productQaEnabled'] as const
type MutableKey = (typeof MUTABLE_KEYS)[number]

function isMutableKey(key: string): key is MutableKey {
  return (MUTABLE_KEYS as readonly string[]).includes(key)
}

/** Clamp a confidence-like number to [0, 1]; non-numbers → 0. */
function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : 0
}

/**
 * Validate a raw PATCH payload into a partial set of AI config flags.
 *
 * Returns a fresh `Partial<AiConfigFlags>` with ONLY the mutable keys that
 * were present and valid, or `null` if the payload is malformed.
 *
 * Never throws. Never invokes getters. Never mutates the input.
 */
export function validateAiConfigPatch(raw: unknown): Partial<AiConfigFlags> | null {
  // --- Reject non-objects, null, arrays ---
  if (raw === null || typeof raw !== 'object') return null
  if (Array.isArray(raw)) return null

  // --- Reject prototype-backed / non-plain objects ---
  // Only accept objects whose prototype is Object.prototype or null
  // (plain object literals, Object.create(null)). This rejects
  // Object.create({ ... }), new Boolean(true), class instances, etc.
  const proto = Object.getPrototypeOf(raw)
  if (proto !== null && proto !== Object.prototype) return null

  // --- Reject symbol keys ---
  // Object.getOwnPropertySymbols returns own symbol properties
  // (enumerable or not). Any symbol key is untrusted.
  if (Object.getOwnPropertySymbols(raw).length > 0) return null

  // --- Collect own string-keyed properties (enumerable AND non-enumerable) ---
  // Object.getOwnPropertyNames catches non-enumerable own keys too, so a
  // hidden `tenantId` can't sneak through.
  const ownNames = Object.getOwnPropertyNames(raw)
  if (ownNames.length === 0) return null // empty object

  const result: Partial<AiConfigFlags> = {}
  let hasMutable = false

  for (const key of ownNames) {
    // --- Reject accessor-backed properties WITHOUT invoking the getter ---
    // Object.getOwnPropertyDescriptor returns the descriptor object
    // directly; it does NOT invoke the getter. We check for `get`/`set`
    // before any value access.
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    if (!desc) return null // shouldn't happen for own names, but defense
    if ('get' in desc || 'set' in desc) return null // accessor — reject

    // --- Reject unknown / forbidden keys ---
    if (!isMutableKey(key)) return null // tenantId, aiActionCount, extra, …

    // --- Reject non-boolean values (no truthy/falsy coercion) ---
    const value = desc.value
    if (typeof value !== 'boolean') return null

    result[key] = value
    hasMutable = true
  }

  if (!hasMutable) return null // no mutable keys after filtering (shouldn't happen)
  return result
}

/**
 * Merge a validated patch into the currently stored flags using TRUE-PATCH
 * semantics: only the mutable keys explicitly provided in `patch` are
 * applied; omitted flags preserve their `stored` value.
 *
 * Returns a fresh `AiConfigFlags`, or `null` if the patch is malformed
 * (in which case the stored flags are left untouched — never a silent
 * reset of an unrelated flag).
 *
 * Never throws. Never mutates `stored` or `patch`.
 */
export function mergeAiConfigPatch(
  stored: Readonly<AiConfigFlags>,
  patch: unknown,
): AiConfigFlags | null {
  const validated = validateAiConfigPatch(patch)
  if (!validated) return null

  // TRUE-PATCH: omitted flags preserve the stored value. The `??` here is
  // safe because `validated` only contains actual booleans (never
  // undefined for a present key — undefined means the key was omitted).
  return {
    faqEnabled: validated.faqEnabled ?? stored.faqEnabled,
    productQaEnabled: validated.productQaEnabled ?? stored.productQaEnabled,
  }
}

// Re-export clamp01 for callers that need the same confidence clamping
// behaviour (kept internal — not part of the public PATCH API).
export { clamp01 }
