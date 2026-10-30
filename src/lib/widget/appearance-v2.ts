/**
 * Widget Appearance V2 — versioned appearance model.
 *
 * A minimal, typed, versioned appearance configuration that supports
 * independent desktop/mobile configuration. This is the FOUNDATION for
 * Customization V2 — later phases add individual visual fields (positioning,
 * colors, launcher styles, animations, message preview, etc.) to this model.
 *
 * Phase 1 keeps this minimal: only the version + the desktop/mobile structure.
 * No new visual fields are implemented in this phase.
 *
 * Design:
 *   - Explicit schema version (currently 1).
 *   - Strict parsing at trust boundaries (parseAppearanceV2).
 *   - Defined defaults (DEFAULT_APPEARANCE_V2).
 *   - Backward compat: if `appearanceV2` is null/absent on a WidgetConfig row,
 *     the existing flat fields (accentColor, launcherShape, position, etc.)
 *     remain the source of truth. The V2 model is ADDITIVE.
 *   - No accidental override of visitor access or identity configuration.
 *   - No unapproved arbitrary styles or CSS.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * NPM widget / browser bundle to import.
 */

/** The appearance schema version. Currently 1. */
export const APPEARANCE_V2_VERSION = 1 as const

/**
 * Device-specific appearance. Phase 1 is an empty structure (no fields yet).
 * Later phases add: position, colors, launcherStyle, animations, dimensions,
 * etc. The structure is defined now so the version + parsing are stable.
 */
// Phase 1: DeviceAppearance has no fields yet. Future phases add visual
// fields (position, colors, launcherStyle, etc.). The empty interface is
// intentional — it establishes the structure for future extension.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DeviceAppearance {
  // Phase 1: no fields. Future phases add visual fields here.
  // Example (NOT implemented yet):
  //   position?: string
  //   accentColor?: string
  //   launcherShape?: string
}

/** The versioned appearance configuration. */
export interface AppearanceV2 {
  version: typeof APPEARANCE_V2_VERSION
  desktop?: DeviceAppearance
  mobile?: DeviceAppearance
}

/** The canonical default appearance (V2). */
export const DEFAULT_APPEARANCE_V2: AppearanceV2 = {
  version: APPEARANCE_V2_VERSION,
  desktop: {},
  mobile: {},
}

/**
 * Strictly parse an unknown value as an AppearanceV2 config.
 *
 * Accepts ONLY:
 *   - null / undefined → null (no V2 config; fall back to V1 flat fields).
 *   - A PLAIN object (prototype === Object.prototype or null) with EXACTLY
 *     an own-property `version === 1` + optional desktop/mobile plain objects.
 *
 * Rejects (returns null):
 *   - Non-object values (numbers, strings, booleans).
 *   - Arrays.
 *   - Non-plain objects (Date, Map, Set, class instances, etc.).
 *   - Objects with inherited `version` (must be an own property).
 *   - Missing or non-integer version.
 *   - Unknown version (version !== 1).
 *   - Fractional version.
 *   - desktop/mobile present but not plain objects.
 *   - Unexpected top-level keys (only version, desktop, mobile are allowed).
 *   - Unexpected keys inside desktop/mobile (Phase 1 defines no device fields).
 *   - Getter-based exceptions (caught internally; never escapes).
 *
 * Returns a CANONICAL object (not the raw input reference) so callers never
 * hold an unvalidated object.
 *
 * Never throws. Returns null on any malformed shape so the caller fails closed
 * (falls back to V1 flat-field behavior).
 */

/** Allowed top-level keys in an AppearanceV2 object. */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['version', 'desktop', 'mobile'])

/**
 * Check if a value is a plain JSON-compatible object — prototype is exactly
 * `Object.prototype` or `null` (Object.create(null)). Rejects Date, Map, Set,
 * class instances, arrays, and primitives.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  try {
    // Array.isArray can throw for a revoked Proxy — guard inside try/catch.
    if (Array.isArray(value)) return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  } catch {
    return false // getPrototypeOf / isArray can throw for exotic objects
  }
}

/**
 * Safely get ALL own property keys (enumerable + non-enumerable, string +
 * Symbol) of a plain object. Uses Reflect.ownKeys which catches properties
 * that Object.keys misses (non-enumerable own properties, Symbol keys).
 * Wraps in try/catch to handle getter-based exceptions. Returns null if
 * the operation fails.
 */
function safeOwnKeys(obj: object): (string | symbol)[] | null {
  try {
    return Reflect.ownKeys(obj)
  } catch {
    return null // reflection threw → fail closed
  }
}

/**
 * Get the own DATA property descriptor for a key. Returns the descriptor
 * (with `value`) if the property exists as a data property (not an
 * accessor). Returns null for accessor properties, inherited properties,
 * missing properties, or if reflection throws.
 *
 * By reading from the descriptor's `value` field instead of direct property
 * access, callers avoid triggering a Proxy `get` trap that could throw even
 * after getOwnPropertyDescriptor returns a valid data descriptor.
 */
function getOwnDataDescriptor(obj: object, key: string): { value: unknown } | null {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) return null // not an own property
    // Must be a data descriptor (has 'value'), not an accessor (has 'get'/'set').
    if (!('value' in desc)) return null
    // Return the descriptor so the caller reads desc.value (bypasses get trap).
    return desc as { value: unknown }
  } catch {
    return null // reflection threw → treat as not a data property
  }
}

export function parseAppearanceV2(value: unknown): AppearanceV2 | null {
  if (value === null || value === undefined) return null
  // Must be a plain object — reject Date, Map, Set, class instances, etc.
  if (!isPlainObject(value)) return null

  // Safely get ALL own keys (enumerable + non-enumerable, string + Symbol).
  const keys = safeOwnKeys(value)
  if (keys === null) return null // reflection threw → fail closed

  // Reject unexpected top-level keys — only version, desktop, mobile are
  // allowed. This includes Symbol keys + non-enumerable own properties.
  // Reflect.ownKeys returns (string | symbol)[] — Symbols are always
  // unexpected (our schema uses only string keys).
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_TOP_LEVEL_KEYS.has(key)) return null
  }

  // version must be an OWN DATA property (not an accessor/getter) + exactly 1.
  // getOwnDataDescriptor returns the descriptor with `value` so we read
  // desc.value instead of direct property access — this bypasses a Proxy
  // `get` trap that could throw even after getOwnPropertyDescriptor succeeds.
  const versionDesc = getOwnDataDescriptor(value, 'version')
  if (!versionDesc) return null // not an own data property → reject
  const versionValue = versionDesc.value
  if (typeof versionValue !== 'number' || !Number.isInteger(versionValue) || versionValue !== APPEARANCE_V2_VERSION) {
    return null
  }

  // desktop / mobile: if present, must be plain objects with NO unexpected
  // keys. Read values from descriptors to bypass Proxy get traps.
  let desktopValue: unknown = undefined
  let mobileValue: unknown = undefined
  const desktopDesc = getOwnDataDescriptor(value, 'desktop')
  if (desktopDesc !== null) {
    desktopValue = desktopDesc.value
  } else {
    // desktop is either absent (fine) or an accessor/non-own (reject).
    // Check if the key exists at all — if it does but isn't a data prop, reject.
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'desktop')) return null
    } catch {
      return null // hasOwnProperty threw on exotic object → fail closed
    }
  }
  const mobileDesc = getOwnDataDescriptor(value, 'mobile')
  if (mobileDesc !== null) {
    mobileValue = mobileDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'mobile')) return null
    } catch {
      return null // hasOwnProperty threw → fail closed
    }
  }
  const desktop = parseDeviceAppearance(desktopValue)
  if (desktop === undefined) return null // malformed → fail closed
  const mobile = parseDeviceAppearance(mobileValue)
  if (mobile === undefined) return null

  // Return a CANONICAL object (not the raw input reference) so callers
  // never hold an unvalidated object.
  return {
    version: APPEARANCE_V2_VERSION,
    desktop: desktop ?? {},
    mobile: mobile ?? {},
  }
}

/**
 * Parse a device-specific appearance. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (no device config).
 *   - {} → valid (canonical empty object — Phase 1 defines no device fields).
 *
 * Phase 1: DeviceAppearance has NO fields. Any key inside a device object
 * is UNEXPECTED and causes rejection (returns undefined). This enforces
 * strict parsing — no arbitrary unvalidated object references pass through.
 * Non-plain objects (Date, Map, Set, class instances) are rejected.
 * Getter-based exceptions are caught (never escape).
 */
function parseDeviceAppearance(value: unknown): DeviceAppearance | null | undefined {
  if (value === null || value === undefined) return null
  // Must be a plain object — reject Date, Map, Set, class instances, etc.
  if (!isPlainObject(value)) return undefined // malformed
  // Safely get ALL own keys (enumerable + non-enumerable, string + Symbol).
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined // reflection threw → fail closed
  // Phase 1: DeviceAppearance has no fields. Reject ANY keys (including
  // non-enumerable + Symbol) — only an empty object (or absent) is valid.
  // Future phases will add + validate specific device fields here.
  if (keys.length > 0) return undefined // unexpected keys → fail closed
  // Return a canonical empty object (not the raw input reference).
  return {}
}

/**
 * Whether a WidgetConfig row has a usable V2 appearance.
 * Returns false if the stored value is null/absent/malformed.
 */
export function hasAppearanceV2(value: unknown): boolean {
  return parseAppearanceV2(value) !== null
}
