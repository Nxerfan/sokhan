/**
 * Widget V2 Positioning PATCH validation + merge.
 *
 * Handles the isolated positioning update contract:
 *   - Free: only `anchor` per device is allowed. offsetX/offsetY → reject.
 *   - Paid: anchor + bounded offsetX/offsetY.
 *   - True-patch: editing desktop doesn't reset mobile (or vice versa).
 *   - Preserves paid offsets when Free edits only the anchor (downgrade
 *     preservation): the merge reads existing V2, updates only the
 *     specified device/fields, keeps everything else.
 *   - No prototype pollution, no unsafe merging.
 *
 * Pure TS — no Prisma, no Next.js. Used by the API route handler.
 */

import { parseAppearanceV2, type AppearanceV2, type DevicePositioning } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
  type PositioningAnchor,
} from './positioning-geometry'

/** The positioning patch payload shape (from the dashboard PATCH body). */
export interface PositioningPatchBody {
  positioning?: unknown
}

/** Result of validating a positioning patch. */
export type PositioningValidationResult =
  | { ok: true; data: PositioningPatchData }
  | { ok: false; code: PositioningErrorCode }

/** Error codes for positioning PATCH validation. */
export type PositioningErrorCode =
  | 'positioning_not_authorized'     // null entitlements or presetPositioning false
  | 'positioning_not_object'
  | 'positioning_device_not_object'
  | 'positioning_anchor_missing'
  | 'positioning_anchor_invalid'
  | 'positioning_offset_not_allowed' // Free sent offsets
  | 'positioning_offset_invalid'     // not a finite integer
  | 'positioning_offset_out_of_bounds'
  | 'positioning_unexpected_key'
  | 'positioning_no_fields'

/** A validated positioning patch for one device. */
export interface DevicePositioningPatch {
  anchor?: PositioningAnchor
  offsetX?: number
  offsetY?: number
  /** Whether any field is present. */
  hasFields: boolean
}

/** A validated positioning patch (desktop +/or mobile). */
export interface PositioningPatchData {
  desktop?: DevicePositioningPatch
  mobile?: DevicePositioningPatch
  hasAny: boolean
}

/** Allowed keys in the positioning patch body. */
const ALLOWED_POSITIONING_PATCH_KEYS = new Set(['desktop', 'mobile'])

/** Allowed keys in a device positioning patch. */
const ALLOWED_DEVICE_PATCH_KEYS = new Set(['anchor', 'offsetX', 'offsetY'])

/**
 * Validate a positioning patch body against the plan entitlements.
 *
 * The `body.positioning` field is expected to be:
 *   {
 *     desktop?: { anchor?, offsetX?, offsetY? },
 *     mobile?:  { anchor?, offsetX?, offsetY? }
 *   }
 *
 * Free plan: only `anchor` is accepted. offsetX/offsetY →
 * `positioning_offset_not_allowed`.
 *
 * Paid plans: anchor + bounded offsetX/offsetY accepted.
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validatePositioningPatch(
  body: PositioningPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): PositioningValidationResult {
  // FAIL CLOSED: unknown plans (null entitlements) or plans without
  // preset positioning capability cannot write positioning at all.
  // This is the server-authoritative gate — no client-supplied plan info.
  if (!entitlements || !entitlements.presetPositioning) {
    return { ok: false, code: 'positioning_not_authorized' }
  }

  if (body.positioning === undefined || body.positioning === null) {
    return { ok: false, code: 'positioning_no_fields' }
  }

  const positioning = body.positioning

  // Must be a plain object.
  if (typeof positioning !== 'object' || positioning === null) {
    return { ok: false, code: 'positioning_not_object' }
  }
  if (Array.isArray(positioning)) {
    return { ok: false, code: 'positioning_not_object' }
  }

  // Check for unexpected keys.
  const keys = Object.keys(positioning as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_POSITIONING_PATCH_KEYS.has(key)) {
      return { ok: false, code: 'positioning_unexpected_key' }
    }
  }

  const positioningObj = positioning as Record<string, unknown>
  let hasAny = false
  const result: PositioningPatchData = { hasAny: false }

  for (const device of ['desktop', 'mobile'] as const) {
    const deviceBody = positioningObj[device]
    if (deviceBody === undefined || deviceBody === null) continue

    if (typeof deviceBody !== 'object' || deviceBody === null) {
      return { ok: false, code: 'positioning_device_not_object' }
    }
    if (Array.isArray(deviceBody)) {
      return { ok: false, code: 'positioning_device_not_object' }
    }

    // Check for unexpected keys in the device patch.
    const deviceKeys = Object.keys(deviceBody as Record<string, unknown>)
    for (const key of deviceKeys) {
      if (!ALLOWED_DEVICE_PATCH_KEYS.has(key)) {
        return { ok: false, code: 'positioning_unexpected_key' }
      }
    }

    const deviceObj = deviceBody as Record<string, unknown>
    const patch: DevicePositioningPatch = { hasFields: false }

    // anchor — must be a valid preset if present.
    if (deviceObj.anchor !== undefined) {
      if (typeof deviceObj.anchor !== 'string' || !(POSITIONING_ANCHORS as readonly string[]).includes(deviceObj.anchor)) {
        return { ok: false, code: 'positioning_anchor_invalid' }
      }
      patch.anchor = deviceObj.anchor as PositioningAnchor
      patch.hasFields = true
    }

    // offsetX — Free: reject. Paid: validate bounded integer.
    if (deviceObj.offsetX !== undefined) {
      if (!entitlements?.precisePositioning) {
        return { ok: false, code: 'positioning_offset_not_allowed' }
      }
      if (typeof deviceObj.offsetX !== 'number' || !Number.isFinite(deviceObj.offsetX) || !Number.isInteger(deviceObj.offsetX)) {
        return { ok: false, code: 'positioning_offset_invalid' }
      }
      if (deviceObj.offsetX < OFFSET_MIN || deviceObj.offsetX > OFFSET_MAX) {
        return { ok: false, code: 'positioning_offset_out_of_bounds' }
      }
      patch.offsetX = deviceObj.offsetX
      patch.hasFields = true
    }

    // offsetY — same as offsetX.
    if (deviceObj.offsetY !== undefined) {
      if (!entitlements?.precisePositioning) {
        return { ok: false, code: 'positioning_offset_not_allowed' }
      }
      if (typeof deviceObj.offsetY !== 'number' || !Number.isFinite(deviceObj.offsetY) || !Number.isInteger(deviceObj.offsetY)) {
        return { ok: false, code: 'positioning_offset_invalid' }
      }
      if (deviceObj.offsetY < OFFSET_MIN || deviceObj.offsetY > OFFSET_MAX) {
        return { ok: false, code: 'positioning_offset_out_of_bounds' }
      }
      patch.offsetY = deviceObj.offsetY
      patch.hasFields = true
    }

    if (patch.hasFields) {
      if (device === 'desktop') result.desktop = patch
      else result.mobile = patch
      hasAny = true
    }
  }

  if (!hasAny) {
    return { ok: false, code: 'positioning_no_fields' }
  }

  result.hasAny = true
  return { ok: true, data: result }
}

/**
 * Merge a validated positioning patch into the existing stored appearanceV2.
 *
 * True-patch semantics:
 *   - Editing desktop does NOT reset mobile (or vice versa).
 *   - Editing anchor does NOT reset offsets (or vice versa).
 *   - Paid offsets are preserved when Free edits only the anchor.
 *   - When creating V2 positioning for the first time (no existing V2 for
 *     the device), the anchor defaults to the stored V1 `position` — NOT
 *     a hardcoded `bottom-end`. This preserves the historical V1 anchor
 *     when the first V2 edit is offset-only.
 *
 * The merge reads the existing V2 (parsed strictly), applies the patch
 * to the specified device/fields, and returns the new canonical V2 object.
 *
 * `v1Position` is the stored V1 `position` field ('bottom-start' | 'bottom-end'
 * | other). It is used as the default anchor when creating new V2 positioning
 * for a device that has no existing V2 positioning. This ensures the first
 * offset-only V2 edit preserves the V1 anchor rather than silently
 * introducing `bottom-end`.
 *
 * Returns the new appearanceV2 object (always valid, always canonical).
 */
export function mergePositioningPatch(
  existingAppearanceV2: unknown,
  patch: PositioningPatchData,
  v1Position?: string | null,
): AppearanceV2 {
  // Parse existing V2 (null if absent/malformed → start fresh).
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  // Derive the V1 anchor fallback (preserves historical V1 position).
  const v1Anchor: PositioningAnchor = v1Position === 'bottom-start'
    ? 'bottom-start'
    : 'bottom-end' // bottom-end + unknown → bottom-end (canonical default)

  // Ensure desktop/mobile objects exist.
  const desktop = { ...(base.desktop ?? {}) }
  const mobile = { ...(base.mobile ?? {}) }

  // Apply desktop patch.
  if (patch.desktop) {
    const existingPos = desktop.positioning
    // If no existing positioning, default the anchor to the V1 position
    // (NOT a hardcoded bottom-end). This preserves the historical V1
    // anchor when the first V2 edit is offset-only.
    const newPos: DevicePositioning = existingPos
      ? { ...existingPos }
      : { anchor: v1Anchor }

    if (patch.desktop.anchor !== undefined) newPos.anchor = patch.desktop.anchor
    if (patch.desktop.offsetX !== undefined) newPos.offsetX = patch.desktop.offsetX
    if (patch.desktop.offsetY !== undefined) newPos.offsetY = patch.desktop.offsetY

    desktop.positioning = newPos
  }

  // Apply mobile patch.
  if (patch.mobile) {
    const existingPos = mobile.positioning
    const newPos: DevicePositioning = existingPos
      ? { ...existingPos }
      : { anchor: v1Anchor }

    if (patch.mobile.anchor !== undefined) newPos.anchor = patch.mobile.anchor
    if (patch.mobile.offsetX !== undefined) newPos.offsetX = patch.mobile.offsetX
    if (patch.mobile.offsetY !== undefined) newPos.offsetY = patch.mobile.offsetY

    mobile.positioning = newPos
  }

  return {
    version: 1,
    desktop,
    mobile,
  }
}

/**
 * Check whether a PATCH body contains ONLY positioning fields (no other
 * customization fields like accentColor, launcherShape, etc.).
 *
 * This is used to determine whether the Free plan gate (402) should apply:
 *   - Body has ONLY positioning → allowed for Free (positioning is the
 *     one Free capability).
 *   - Body has positioning + other customization → reject Free with 402
 *     (no bypass by mixing allowed + forbidden fields).
 *   - Body has only other customization (no positioning) → existing
 *     behavior (402 for Free, validate+apply for paid).
 *
 * The "other customization fields" are the existing PATCH contract:
 * accentColor, launcherShape, position, avatarUrl, logoUrl, greetingTexts,
 * defaultLocale.
 */
const OTHER_CUSTOMIZATION_KEYS = new Set([
  'accentColor',
  'launcherShape',
  'position',
  'avatarUrl',
  'logoUrl',
  'greetingTexts',
  'defaultLocale',
])

/** All recognized top-level PATCH fields (customization + positioning). */
const ALL_RECOGNIZED_KEYS = new Set([...OTHER_CUSTOMIZATION_KEYS, 'positioning'])

/**
 * Check if the PATCH body contains any non-positioning customization fields.
 */
export function hasOtherCustomizationFields(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    if (OTHER_CUSTOMIZATION_KEYS.has(key)) return true
  }
  return false
}

/**
 * Check if the PATCH body contains a positioning field.
 */
export function hasPositioningField(body: Record<string, unknown>): boolean {
  return body.positioning !== undefined
}

/**
 * Check if the PATCH body contains any UNRECOGNIZED top-level fields
 * (not in the customization set + not `positioning`). Unrecognized fields
 * are rejected to prevent silent acceptance of unsupported payloads.
 */
export function hasUnrecognizedFields(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    if (!ALL_RECOGNIZED_KEYS.has(key)) return true
  }
  return false
}
