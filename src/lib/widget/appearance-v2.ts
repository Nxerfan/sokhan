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
 *   - An object with version === 1 + optional desktop/mobile objects.
 *
 * Rejects (returns null):
 *   - Non-object values.
 *   - Arrays.
 *   - Missing or non-integer version.
 *   - Unknown version (version !== 1).
 *   - desktop/mobile present but not objects.
 *
 * Never throws. Returns null on any malformed shape so the caller fails closed
 * (falls back to V1 flat-field behavior).
 */
export function parseAppearanceV2(value: unknown): AppearanceV2 | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null

  const v = value as Record<string, unknown>

  // version must be exactly 1 (the current version).
  if (typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version !== APPEARANCE_V2_VERSION) {
    return null
  }

  // desktop / mobile: if present, must be plain objects (or null/undefined).
  const desktop = parseDeviceAppearance(v.desktop)
  if (desktop === undefined) return null // malformed → fail closed
  const mobile = parseDeviceAppearance(v.mobile)
  if (mobile === undefined) return null

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
 *   - DeviceAppearance → valid (possibly empty).
 */
function parseDeviceAppearance(value: unknown): DeviceAppearance | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined // malformed
  // Phase 1: DeviceAppearance has no fields, so any plain object is valid
  // (future fields will be validated here). Return the object as-is (typed).
  return value as DeviceAppearance
}

/**
 * Whether a WidgetConfig row has a usable V2 appearance.
 * Returns false if the stored value is null/absent/malformed.
 */
export function hasAppearanceV2(value: unknown): boolean {
  return parseAppearanceV2(value) !== null
}
