/**
 * Widget V2 Effective Positioning Resolver.
 *
 * Derives the EFFECTIVE positioning (what the widget actually renders)
 * from:
 *   1. Stored V2 positioning (parsed strictly).
 *   2. Stored V1 `position` (fallback when V2 absent).
 *   3. Server-authoritative plan entitlements.
 *   4. The selected device class (desktop/mobile).
 *
 * Entitlement enforcement:
 *   - `presetPositioning` (Free: true) → anchor presets are applied.
 *   - `precisePositioning` (Free: false) → offsetX/offsetY are NOT
 *     applied even if stored (they remain in storage for upgrade restore).
 *   - Unknown plan / null entitlements → fail closed (default bottom-end).
 *
 * This is SEPARATE from `normalizeStoredAppearance()` (which only parses
 * stored config without entitlement enforcement). The effective resolver
 * is the production source of truth for what the widget renders.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2, type AppearanceV2, type DevicePositioning } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  DEFAULT_POSITIONING,
  type EffectivePositioning,
  type PositioningAnchor,
} from './positioning-geometry'

/**
 * Stored positioning input — the V1 flat `position` field + the additive
 * V2 `appearanceV2` field (raw, untyped — parsed strictly here).
 */
export interface StoredPositioningInput {
  /** V1 flat position field (e.g. 'bottom-start' | 'bottom-end'). */
  position: string | null | undefined
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * Map a V1 `position` string to a V2 anchor. V1 only supports
 * 'bottom-start' | 'bottom-end'. Any other value → null (fail closed).
 */
function v1PositionToAnchor(position: string | null | undefined): PositioningAnchor | null {
  if (position === 'bottom-start') return 'bottom-start'
  if (position === 'bottom-end') return 'bottom-end'
  return null // unknown V1 position → fail closed
}

/**
 * Extract the stored positioning for a device from the parsed V2 appearance.
 * Returns null if no V2 config or no positioning for the device.
 */
function getStoredDevicePositioning(
  appearanceV2: AppearanceV2 | null,
  device: 'desktop' | 'mobile',
): DevicePositioning | null {
  if (!appearanceV2) return null
  const deviceConfig = device === 'desktop' ? appearanceV2.desktop : appearanceV2.mobile
  if (!deviceConfig) return null
  return deviceConfig.positioning ?? null
}

/**
 * Resolve the effective positioning for a device.
 *
 * Resolution order:
 *   1. Stored V2 positioning for the device (if present + valid).
 *   2. V1 `position` fallback (if no V2 for this device).
 *   3. DEFAULT_POSITIONING ('bottom-end', no offsets) if nothing valid.
 *
 * Entitlement enforcement:
 *   - `precisePositioning: false` (Free) → offsetX/offsetY are stripped
 *     from the effective output (remain stored, not applied).
 *   - `presetPositioning: false` (no known plan) → fail closed to defaults.
 *   - null entitlements (unknown plan) → fail closed to defaults.
 *
 * Returns a canonical EffectivePositioning with anchor + offsetX + offsetY.
 * Offsets are always present in the output (0 if not entitled or not stored).
 */
export function resolveEffectivePositioning(
  stored: StoredPositioningInput,
  entitlements: Readonly<WidgetEntitlements> | null,
  device: 'desktop' | 'mobile',
): EffectivePositioning {
  // Fail closed for unknown plans / null entitlements.
  if (!entitlements) {
    return { ...DEFAULT_POSITIONING }
  }

  // If the plan doesn't even have preset positioning, fail closed.
  if (!entitlements.presetPositioning) {
    return { ...DEFAULT_POSITIONING }
  }

  // Parse stored V2 strictly.
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const v2Positioning = getStoredDevicePositioning(appearanceV2, device)

  let anchor: PositioningAnchor
  let offsetX = 0
  let offsetY = 0

  if (v2Positioning) {
    // V2 positioning is present + valid for this device.
    anchor = v2Positioning.anchor
    // Offsets are only applied if the plan is entitled to precise positioning.
    if (entitlements.precisePositioning) {
      offsetX = v2Positioning.offsetX ?? 0
      offsetY = v2Positioning.offsetY ?? 0
    }
    // Free: offsets remain stored but are NOT applied (0 in effective output).
  } else {
    // No V2 for this device → fall back to V1 position.
    const v1Anchor = v1PositionToAnchor(stored.position)
    anchor = v1Anchor ?? DEFAULT_POSITIONING.anchor
    // V1 has no offsets → 0.
  }

  return { anchor, offsetX, offsetY }
}

/**
 * Resolve effective positioning for BOTH devices (desktop + mobile).
 *
 * If only one device has V2 positioning, the other falls back to V1
 * (not silently reset). This preserves independent device config.
 */
export function resolveAllEffectivePositioning(
  stored: StoredPositioningInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): {
  desktop: EffectivePositioning
  mobile: EffectivePositioning
} {
  return {
    desktop: resolveEffectivePositioning(stored, entitlements, 'desktop'),
    mobile: resolveEffectivePositioning(stored, entitlements, 'mobile'),
  }
}

/**
 * Get the stored positioning for a device (without entitlement enforcement).
 * Used by the dashboard to populate controls with the raw stored values
 * (so the user can see their saved paid offsets even on Free).
 *
 * Returns null if no V2 or no positioning for the device.
 */
export function getStoredPositioning(
  stored: StoredPositioningInput,
  device: 'desktop' | 'mobile',
): DevicePositioning | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return getStoredDevicePositioning(appearanceV2, device)
}

/**
 * Derive the V1 `position` field for legacy consumers from the effective
 * desktop positioning. V1 only supports bottom-start/bottom-end; if the
 * effective anchor is bottom-center, fall back to bottom-end (the canonical
 * product default).
 */
export function deriveLegacyPosition(
  effectiveDesktop: EffectivePositioning,
): 'bottom-start' | 'bottom-end' {
  if (effectiveDesktop.anchor === 'bottom-start') return 'bottom-start'
  return 'bottom-end' // bottom-end + bottom-center both map to bottom-end for V1
}
