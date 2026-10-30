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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  } catch {
    return false // getPrototypeOf can throw for certain exotic objects
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
 * Check if a property is an own DATA property (not an accessor/getter).
 * Returns true if the property exists as a data descriptor (has `value`,
 * not `get`/`set`). Returns false for accessor properties, inherited
 * properties, or missing properties. Wraps in try/catch for safety.
 */
function isOwnDataProperty(obj: object, key: string): boolean {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) return false // not an own property
    // Must be a data descriptor (has 'value' or 'writable'), not an accessor
    // (has 'get' or 'set'). This rejects getter/setter properties.
    return 'value' in desc
  } catch {
    return false // reflection threw → treat as not a data property
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
  // isOwnDataProperty uses Object.getOwnPropertyDescriptor to verify it's
  // a data descriptor (has 'value', not 'get'/'set'). This rejects accessor
  // properties that could throw or return arbitrary values without actually
  // holding a real value.
  if (!isOwnDataProperty(value, 'version')) return null
  // Safe to read the value — it's a data property, not a getter.
  const versionValue = (value as Record<string, unknown>).version
  if (typeof versionValue !== 'number' || !Number.isInteger(versionValue) || versionValue !== APPEARANCE_V2_VERSION) {
    return null
  }

  // desktop / mobile: if present, must be plain objects with NO unexpected
  // keys (including Symbol + non-enumerable). Also verify they're data
  // properties (not accessors) before reading.
  let desktopValue: unknown = undefined
  let mobileValue: unknown = undefined
  if (ALLOWED_TOP_LEVEL_KEYS.has('desktop') && Object.prototype.hasOwnProperty.call(value, 'desktop')) {
    if (!isOwnDataProperty(value, 'desktop')) return null // accessor → reject
    desktopValue = (value as Record<string, unknown>).desktop
  }
  if (ALLOWED_TOP_LEVEL_KEYS.has('mobile') && Object.prototype.hasOwnProperty.call(value, 'mobile')) {
    if (!isOwnDataProperty(value, 'mobile')) return null // accessor → reject
    mobileValue = (value as Record<string, unknown>).mobile
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
