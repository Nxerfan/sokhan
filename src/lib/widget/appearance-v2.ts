/**
 * Widget Appearance V2 — versioned appearance model.
 *
 * A typed, versioned appearance configuration that supports independent
 * desktop/mobile configuration. Phase 1 established the version + structure.
 * Phase 2 / Feature 1 adds device-specific positioning (anchor + bounded
 * X/Y offsets) as the first concrete visual field.
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

import {
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
  type PositioningAnchor,
} from './positioning-geometry'
import {
  isValidPaletteId,
  isValidColor,
  isValidCustomColors,
  COLOR_TOKEN_NAMES,
  type ColorTokens,
} from './color-palettes'

/** The appearance schema version. Currently 1. */
export const APPEARANCE_V2_VERSION = 1 as const

/**
 * Device-specific appearance.
 *
 * Phase 2 / Feature 1 adds `positioning` (anchor + bounded X/Y offsets).
 * Future phases add more visual fields (colors, launcherStyle, animations,
 * etc.). The structure is versioned — adding optional fields does NOT bump
 * the schema version (they are additive + nullable).
 */
export interface DeviceAppearance {
  /**
   * Widget positioning for this device. Anchor is always present when
   * positioning is configured; offsetX/offsetY are advanced-plan-only
   * (but may be stored for Free for future upgrade restore).
   */
  positioning?: DevicePositioning
}

/**
 * Per-device positioning config. `anchor` is the 3-preset base position;
 * `offsetX`/`offsetY` are bounded pixel adjustments (advanced plans only).
 *
 * Coordinate semantics (see positioning-geometry.ts for full details):
 *   - offsetX: positive = right (physical pixels)
 *   - offsetY: positive = up (physical pixels)
 */
export interface DevicePositioning {
  anchor: PositioningAnchor
  /** Horizontal offset in pixels (positive = right). Advanced plans only. */
  offsetX?: number
  /** Vertical offset in pixels (positive = up). Advanced plans only. */
  offsetY?: number
}

/**
 * Global color theme (not device-specific — colors are consistent across
 * desktop and mobile per product requirement).
 *
 * - `mode: 'preset'` — use a predefined palette (Free + paid).
 * - `mode: 'custom'` — use custom color tokens (paid only).
 */
export interface ColorTheme {
  mode: 'preset' | 'custom'
  /** Palette ID (required when mode='preset'). Must be a valid stable ID. */
  presetId?: string
  /** Custom color tokens (required when mode='custom'). Paid plans only. */
  custom?: ColorTokens
}

/** The versioned appearance configuration. */
export interface AppearanceV2 {
  version: typeof APPEARANCE_V2_VERSION
  desktop?: DeviceAppearance
  mobile?: DeviceAppearance
  /** Global color theme (Phase 2 / Feature 2). Additive — null = V1 behavior. */
  colors?: ColorTheme
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
 *   - desktop/mobile may contain an optional `positioning` object with
 *     a valid `anchor` + optional bounded integer `offsetX`/`offsetY`.
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
 *   - Unexpected top-level keys (only version, desktop, mobile, colors are allowed).
 *   - Unexpected keys inside desktop/mobile (only `positioning` is allowed).
 *   - positioning present but not a plain object / malformed.
 *   - Invalid anchor (not one of the 3 presets).
 *   - offsetX/offsetY present but not finite integers / out of bounds.
 *   - Unexpected keys inside positioning (only anchor, offsetX, offsetY).
 *   - Getter-based exceptions (caught internally; never escapes).
 *
 * Returns a CANONICAL object (not the raw input reference) so callers never
 * hold an unvalidated object.
 *
 * Never throws. Returns null on any malformed shape so the caller fails closed
 * (falls back to V1 flat-field behavior).
 */

/** Allowed top-level keys in an AppearanceV2 object. */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['version', 'desktop', 'mobile', 'colors'])

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

  // Parse colors if present (read from descriptor to bypass Proxy get).
  const colorsDesc = getOwnDataDescriptor(value, 'colors')
  let colorsValue: unknown = undefined
  if (colorsDesc !== null) {
    colorsValue = colorsDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'colors')) return null
    } catch {
      return null
    }
  }
  let colors: ColorTheme | null | undefined = undefined
  if (colorsValue !== undefined) {
    colors = parseColorTheme(colorsValue)
    if (colors === undefined) return null // malformed → fail closed
  }

  // Return a CANONICAL object (not the raw input reference) so callers
  // never hold an unvalidated object.
  const result: AppearanceV2 = {
    version: APPEARANCE_V2_VERSION,
    desktop: desktop ?? {},
    mobile: mobile ?? {},
  }
  if (colors !== null && colors !== undefined) {
    result.colors = colors
  }
  return result
}

/** Allowed keys inside a color theme object. */
const ALLOWED_COLOR_KEYS = new Set(['mode', 'presetId', 'custom'])

/** Allowed keys inside a custom colors object. */
const ALLOWED_CUSTOM_COLOR_KEYS = new Set(COLOR_TOKEN_NAMES as readonly string[])

/**
 * Parse a color theme object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (colors is null/undefined).
 *   - ColorTheme → valid (canonical object).
 *
 * Validates: mode is 'preset' or 'custom'; presetId is valid when mode='preset';
 * custom tokens are valid #RRGGBB when mode='custom'; no unexpected keys.
 */
function parseColorTheme(value: unknown): ColorTheme | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_COLOR_KEYS.has(key)) return undefined
  }

  // mode — required, must be 'preset' or 'custom'.
  const modeDesc = getOwnDataDescriptor(value, 'mode')
  if (!modeDesc) return undefined
  const modeValue = modeDesc.value
  if (modeValue !== 'preset' && modeValue !== 'custom') return undefined

  // presetId — required when mode='preset'.
  const presetIdDesc = getOwnDataDescriptor(value, 'presetId')
  let presetId: string | undefined
  if (presetIdDesc !== null) {
    const v = presetIdDesc.value
    if (v !== undefined && v !== null) {
      if (!isValidPaletteId(v)) return undefined
      presetId = v
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'presetId')) return undefined
    } catch {
      return undefined
    }
  }

  // custom — required when mode='custom'.
  const customDesc = getOwnDataDescriptor(value, 'custom')
  let custom: ColorTokens | undefined
  if (customDesc !== null) {
    const v = customDesc.value
    if (v !== undefined && v !== null) {
      if (!isPlainObject(v)) return undefined
      const customKeys = safeOwnKeys(v)
      if (customKeys === null) return undefined
      // Check for unexpected keys.
      for (const key of customKeys) {
        if (typeof key !== 'string' || !ALLOWED_CUSTOM_COLOR_KEYS.has(key)) return undefined
      }
      // Validate all tokens are valid colors.
      if (!isValidCustomColors(v)) return undefined
      // Return canonical copy.
      const tokens: Record<string, string> = {}
      for (const name of COLOR_TOKEN_NAMES) {
        tokens[name] = (v as unknown as Record<string, unknown>)[name] as string
      }
      custom = tokens as unknown as ColorTokens
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'custom')) return undefined
    } catch {
      return undefined
    }
  }

  // Validate mode-specific requirements.
  if (modeValue === 'preset' && !presetId) return undefined
  if (modeValue === 'custom' && !custom) return undefined

  const result: ColorTheme = { mode: modeValue }
  if (presetId) result.presetId = presetId
  if (custom) result.custom = custom
  return result
}

/** Allowed keys inside a device appearance object. */
const ALLOWED_DEVICE_KEYS = new Set(['positioning'])

/** Allowed keys inside a positioning object. */
const ALLOWED_POSITIONING_KEYS = new Set(['anchor', 'offsetX', 'offsetY'])

/**
 * Parse a device-specific appearance. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (no device config).
 *   - DeviceAppearance → valid (canonical object with parsed positioning).
 *
 * Phase 2: DeviceAppearance may contain an optional `positioning` object.
 * Any other key is UNEXPECTED and causes rejection (returns undefined).
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
  // Only `positioning` is allowed inside a device object.
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_DEVICE_KEYS.has(key)) return undefined
  }

  const result: DeviceAppearance = {}

  // Parse positioning if present (read from descriptor to bypass Proxy get).
  const positioningDesc = getOwnDataDescriptor(value, 'positioning')
  let positioningValue: unknown = undefined
  if (positioningDesc !== null) {
    positioningValue = positioningDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'positioning')) return undefined
    } catch {
      return undefined
    }
  }

  if (positioningValue !== undefined) {
    const positioning = parsePositioning(positioningValue)
    if (positioning === undefined) return undefined // malformed → fail closed
    if (positioning !== null) {
      result.positioning = positioning
    }
  }

  return result
}

/**
 * Parse a positioning object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (positioning is null/undefined).
 *   - DevicePositioning → valid (canonical object).
 *
 * Validates: anchor is one of the 3 presets; offsetX/offsetY are optional
 * finite integers within [-2000, 2000]; no unexpected keys.
 */
function parsePositioning(value: unknown): DevicePositioning | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  // Only anchor, offsetX, offsetY are allowed.
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_POSITIONING_KEYS.has(key)) return undefined
  }

  // anchor — required, must be a valid preset. Read from descriptor.
  const anchorDesc = getOwnDataDescriptor(value, 'anchor')
  if (!anchorDesc) return undefined // anchor must be an own data property
  const anchorValue = anchorDesc.value
  if (typeof anchorValue !== 'string' || !(POSITIONING_ANCHORS as readonly string[]).includes(anchorValue)) {
    return undefined
  }

  const result: DevicePositioning = { anchor: anchorValue as PositioningAnchor }

  // offsetX — optional, must be a finite integer within bounds.
  const offsetXDesc = getOwnDataDescriptor(value, 'offsetX')
  if (offsetXDesc !== null) {
    const v = offsetXDesc.value
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined
    if (v < OFFSET_MIN || v > OFFSET_MAX) return undefined
    result.offsetX = v
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'offsetX')) return undefined
    } catch {
      return undefined
    }
  }

  // offsetY — optional, must be a finite integer within bounds.
  const offsetYDesc = getOwnDataDescriptor(value, 'offsetY')
  if (offsetYDesc !== null) {
    const v = offsetYDesc.value
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined
    if (v < OFFSET_MIN || v > OFFSET_MAX) return undefined
    result.offsetY = v
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'offsetY')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

/**
 * Whether a WidgetConfig row has a usable V2 appearance.
 * Returns false if the stored value is null/absent/malformed.
 */
export function hasAppearanceV2(value: unknown): boolean {
  return parseAppearanceV2(value) !== null
}
