/**
 * Widget V2 Playground policy (Feature 12) — LOCAL-ONLY simulation.
 *
 * The Playground is a private, in-dashboard dry-run environment for
 * exploring how the Sukhan widget WOULD look and behave before the owner
 * changes the actual tenant configuration. It never writes production
 * settings, never persists drafts into `appearanceV2`, never creates a
 * widget embed or a visitor session, and never issues a PATCH/POST to
 * `/api/widget-config` or any visitor-facing API.
 *
 * This module is the pure TypeScript policy core:
 *   - `getPlaygroundCapabilities` — the per-plan capability view derived
 *     from the canonical `WidgetEntitlements` model (fail closed for
 *     unknown/null plans; Free never sees paid-only options).
 *   - `createPlaygroundDraft` — the initial draft built from the
 *     SERVER-EFFECTIVE baseline (what the public widget actually renders
 *     today — never stored paid-era values when the tenant is currently
 *     Free), with safe Sukhan fallbacks for missing/malformed baselines.
 *   - `sanitizePlaygroundDraft` — the strict local draft validator used
 *     at the rendering boundary: exact schema, no unknown/missing keys,
 *     no Symbol keys, no accessor-backed properties (getters are never
 *     executed), canonical catalogs only, offsets zero on Free, custom
 *     accent only for entitled plans. Returns a FRESH canonical copy —
 *     never the input reference, never a mutation of the baseline.
 *
 * Canonical catalogs (anchors / palettes / launcher shapes) are imported
 * from their single sources of truth — no duplicated lists.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * dashboard client bundle.
 */

import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  POSITIONING_ANCHORS,
  isValidAnchor,
  isValidOffset,
  type PositioningAnchor,
} from './positioning-geometry'
import {
  COLOR_PALETTES,
  DEFAULT_PALETTE_ID,
  isValidPaletteId,
  isValidColor,
} from './color-palettes'
import {
  FREE_LAUNCHER_SHAPES,
  PAID_ONLY_LAUNCHER_SHAPES,
  DEFAULT_LAUNCHER_SHAPE,
  isValidLauncherShape,
  type LauncherShape,
} from './launcher-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The simulated preview device. */
export type PlaygroundDevice = 'desktop' | 'mobile'

/** The simulated widget locale (also drives the preview direction). */
export type PlaygroundLocale = 'fa' | 'en'

/**
 * The simulated launcher shape (same canonical set as production).
 *
 * NOTE: the draft's `anchor`/`shape` fields are deliberately typed as
 * `string` (not the narrow literal unions) so that widened object
 * literals — the shape every JavaScript/TS caller produces when spreading
 * a draft with overrides — remains assignable to the draft contract.
 * Canonical values are enforced at RUNTIME by `sanitizePlaygroundDraft`
 * (unknown anchors/shapes are rejected); the static type is intentionally
 * permissive for ergonomics, exactly like `paletteId`.
 */
export type PlaygroundShape = string

/**
 * The LOCAL-ONLY experiment draft. This is browser memory only — it is
 * never persisted to the database, `appearanceV2`, or browser storage.
 *
 * `anchor` and `shape` are plain strings at the type level; the strict
 * sanitizer validates them against the canonical catalogs.
 */
export type PlaygroundDraft = {
  device: PlaygroundDevice
  locale: PlaygroundLocale
  anchor: string
  offsetX: number
  offsetY: number
  paletteId: string
  shape: string
  customAccent: string | null
  open: boolean
}

/**
 * The per-plan Playground capability view.
 */
export interface PlaygroundCapabilities {
  enabled: boolean
  anchors: PositioningAnchor[]
  paletteIds: string[]
  launcherShapes: LauncherShape[]
  precisePositioning: boolean
  customColors: boolean
}

/**
 * The SERVER-EFFECTIVE baseline snapshot the draft is created from — the
 * same shape the dashboard already receives from
 * `GET /api/widget-config` (`positioning.effective`, `colors.effective`,
 * `launcher.effective`, `effective.defaultLocale`).
 *
 * Treated as UNTRUSTED input: every field is validated before it can
 * influence a draft, and malformed values fall back to safe Sukhan
 * defaults. `tokens` is accepted but never read (the draft models preset
 * palette ids, not full custom token sets).
 */
export interface PlaygroundBaselineInput {
  defaultLocale?: string
  positioning?: {
    desktop?: { anchor: string; offsetX: number; offsetY: number }
    mobile?: { anchor: string; offsetX: number; offsetY: number }
  } | null
  colors?: {
    mode: string
    presetId?: string
    tokens?: object
  } | null
  launcher?: { shape: string } | null
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

/** Safe fail-closed capabilities (unknown plan / null entitlements). */
const DISABLED_CAPABILITIES: PlaygroundCapabilities = {
  enabled: false,
  anchors: [],
  paletteIds: [],
  launcherShapes: [],
  precisePositioning: false,
  customColors: false,
}

/**
 * Resolve the Playground capability view from the canonical entitlements.
 *
 * - `playground` gates the whole feature. Free, Pro, Max and Self-hosted
 *   all have it enabled; unknown/invalid plans fail closed.
 * - Anchors come from the canonical positioning catalog (all 3 presets
 *   for every plan that has preset positioning).
 * - Palettes come from the canonical 10-color catalog (every plan that
 *   has preset colors — no invented palettes).
 * - Launcher shapes: `tab` + `rounded` for everyone; `pill` is paid-only
 *   (`launcherSelection: 'all'`).
 * - Precise X/Y offset experiments + custom accent experiments use the
 *   canonical `precisePositioning` / `customColors` entitlements.
 *
 * Never infers capabilities from a price, a client-supplied plan flag, or
 * a legacy `isLocked` boolean.
 */
export function getPlaygroundCapabilities(
  entitlements: Readonly<WidgetEntitlements> | null,
): PlaygroundCapabilities {
  if (!entitlements || entitlements.playground !== true) {
    return { ...DISABLED_CAPABILITIES }
  }

  // Anchors: canonical preset list for plans with preset positioning.
  const anchors: PositioningAnchor[] =
    entitlements.presetPositioning === true ? [...POSITIONING_ANCHORS] : []

  // Palettes: canonical catalog ids for plans with preset colors.
  const paletteIds: string[] =
    entitlements.presetColors === true ? COLOR_PALETTES.map((p) => p.id) : []

  // Launcher shapes: canonical Free set, extended by the paid-only set.
  const launcherShapes: LauncherShape[] =
    entitlements.launcherSelection === 'all'
      ? [...FREE_LAUNCHER_SHAPES, ...PAID_ONLY_LAUNCHER_SHAPES]
      : entitlements.launcherSelection === 'limited'
        ? [...FREE_LAUNCHER_SHAPES]
        : []

  return {
    enabled: true,
    anchors,
    paletteIds,
    launcherShapes,
    precisePositioning: entitlements.precisePositioning === true,
    customColors: entitlements.customColors === true,
  }
}

// ---------------------------------------------------------------------------
// Baseline → draft
// ---------------------------------------------------------------------------

/** The safe Sukhan fallback values for missing or invalid baselines. */
export const PLAYGROUND_DEFAULT_LOCALE: PlaygroundLocale = 'fa'
export const PLAYGROUND_DEFAULT_ANCHOR: PositioningAnchor = 'bottom-end'
export const PLAYGROUND_DEFAULT_PALETTE_ID: string = DEFAULT_PALETTE_ID // 'sukhan'
export const PLAYGROUND_DEFAULT_SHAPE: PlaygroundShape = DEFAULT_LAUNCHER_SHAPE // 'tab'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A fresh fail-closed draft (all safe Sukhan defaults, chat closed). */
function fallbackDraft(device: PlaygroundDevice): PlaygroundDraft {
  return {
    device,
    locale: PLAYGROUND_DEFAULT_LOCALE,
    anchor: PLAYGROUND_DEFAULT_ANCHOR,
    offsetX: 0,
    offsetY: 0,
    paletteId: PLAYGROUND_DEFAULT_PALETTE_ID,
    shape: PLAYGROUND_DEFAULT_SHAPE,
    customAccent: null,
    open: false,
  }
}

/**
 * Create the initial Playground draft from the SERVER-EFFECTIVE baseline.
 *
 * - Uses the actual effective current position, palette and launcher —
 *   never stored paid-era values when the tenant is currently Free (the
 *   dashboard passes the already-entitlement-filtered effective values;
 *   this function additionally hardens Free independently: paid-only
 *   offsets and shapes in a "paid-looking" input are never reactivated).
 * - Per-device positioning: `device` selects which effective baseline
 *   (desktop or mobile) seeds the draft's anchor + offsets.
 * - Every field is validated; malformed baselines fall back to the safe
 *   Sukhan defaults (locale fa, anchor bottom-end, offsets 0, palette
 *   sukhan, shape tab, custom accent null, chat closed).
 * - Never mutates the input snapshot.
 *
 * Custom-mode effective colors are approximated by the default palette —
 * the draft models preset palettes plus ONE optional custom accent
 * experiment, not a full custom token set (the baseline custom accent is
 * always null).
 */
export function createPlaygroundDraft(
  effective: PlaygroundBaselineInput,
  entitlements: Readonly<WidgetEntitlements> | null,
  device: PlaygroundDevice = 'desktop',
): PlaygroundDraft {
  const caps = getPlaygroundCapabilities(entitlements)
  // Unknown/invalid plan: fail closed to the safe Sukhan defaults.
  if (!caps.enabled) {
    return fallbackDraft(device)
  }

  const draft = fallbackDraft(device)

  // Malformed/absent baseline input → pure defaults.
  if (!isRecord(effective)) {
    return draft
  }

  // Locale — exactly 'fa' or 'en'; anything else falls back to 'fa'.
  const rawLocale = effective.defaultLocale
  if (rawLocale === 'fa' || rawLocale === 'en') {
    draft.locale = rawLocale
  }

  // Positioning — the device-specific SERVER-EFFECTIVE baseline.
  const positioning = effective.positioning
  if (isRecord(positioning)) {
    const devicePos =
      device === 'desktop'
        ? (positioning as Record<string, unknown>).desktop
        : (positioning as Record<string, unknown>).mobile
    if (isRecord(devicePos)) {
      const anchor = devicePos.anchor
      if (isValidAnchor(anchor) && caps.anchors.includes(anchor)) {
        draft.anchor = anchor
      }
      // Precise offsets are a paid-only EXPERIMENT. Free never reactivates
      // paid-era stored offsets, even when the caller passes paid-looking
      // effective values (the effective resolver already strips them —
      // this is independent hardening at the policy boundary).
      if (caps.precisePositioning) {
        if (isValidOffset(devicePos.offsetX)) draft.offsetX = devicePos.offsetX
        if (isValidOffset(devicePos.offsetY)) draft.offsetY = devicePos.offsetY
      }
    }
  }

  // Colors — the effective preset palette when it is canonical.
  const colors = effective.colors
  if (isRecord(colors)) {
    const presetId = colors.presetId
    if (isValidPaletteId(presetId) && caps.paletteIds.includes(presetId)) {
      draft.paletteId = presetId
    }
    // Custom-mode effective colors (or an unknown preset) keep the safe
    // default palette baseline — see the doc comment above.
  }

  // Launcher — the effective shape when the plan is entitled to it.
  const launcher = effective.launcher
  if (isRecord(launcher)) {
    const shape = launcher.shape
    if (isValidLauncherShape(shape) && caps.launcherShapes.includes(shape)) {
      draft.shape = shape
    }
  }

  return draft
}

// ---------------------------------------------------------------------------
// Strict draft sanitizer
// ---------------------------------------------------------------------------

/** The exact local draft schema — nothing more, nothing less. */
const DRAFT_KEYS = [
  'device',
  'locale',
  'anchor',
  'offsetX',
  'offsetY',
  'paletteId',
  'shape',
  'customAccent',
  'open',
] as const

/**
 * Strictly validate a local Playground draft.
 *
 * Requirements enforced:
 *   - Exact expected draft properties only (own properties, enumerable or
 *     not — no unknown fields, no missing fields, no arrays, no null).
 *   - Symbol keys are rejected.
 *   - Accessor-backed properties are rejected WITHOUT executing getters
 *     (values are read from property descriptors only).
 *   - Malformed types, invalid locale/device, unknown palette/anchor/shape
 *     are rejected (canonical catalogs only).
 *   - Offsets must be finite integers within the canonical bounds, and
 *     exactly ZERO for plans without precise positioning (Free).
 *   - Custom accent must be null or a valid `#RRGGBB`, and is only
 *     permitted for plans entitled to custom colors.
 *   - The `open` flag must be a boolean.
 *   - Unknown plans cannot accept forged experiment state (null result).
 *
 * Returns a FRESH canonical copy — never the input reference — or null
 * when the draft is rejected. Never mutates any input.
 */
export function sanitizePlaygroundDraft(
  draft: unknown,
  entitlements: Readonly<WidgetEntitlements> | null,
): PlaygroundDraft | null {
  const caps = getPlaygroundCapabilities(entitlements)
  // Unknown/invalid plan: reject experiments (fail closed).
  if (!caps.enabled) {
    return null
  }

  // Must be a plain object — arrays, null, primitives are rejected.
  if (!isRecord(draft)) {
    return null
  }

  // Exact own-property set (getOwnPropertyNames includes non-enumerable
  // own properties — nothing can hide outside the schema).
  const ownNames = Object.getOwnPropertyNames(draft)
  if (ownNames.length !== DRAFT_KEYS.length) {
    return null
  }
  for (const key of DRAFT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(draft, key)) {
      return null
    }
  }

  // Symbol keys are rejected outright.
  if (Object.getOwnPropertySymbols(draft).length > 0) {
    return null
  }

  // Read values via property descriptors — an accessor-backed property is
  // rejected without ever executing its getter.
  const values: Record<string, unknown> = {}
  for (const key of DRAFT_KEYS) {
    const desc = Object.getOwnPropertyDescriptor(draft, key)
    if (!desc) return null
    if (desc.get !== undefined || desc.set !== undefined) return null
    values[key] = desc.value
  }

  // device / locale — exact literals only.
  const device = values.device
  if (device !== 'desktop' && device !== 'mobile') return null
  const locale = values.locale
  if (locale !== 'fa' && locale !== 'en') return null

  // anchor — canonical list + plan capability.
  const anchor = values.anchor
  if (typeof anchor !== 'string' || !isValidAnchor(anchor)) return null
  if (!caps.anchors.includes(anchor)) return null

  // offsets — finite integers within canonical bounds; exactly zero on
  // plans without precise positioning (Free).
  const offsetX = values.offsetX
  const offsetY = values.offsetY
  if (!isValidOffset(offsetX)) return null
  if (!isValidOffset(offsetY)) return null
  if (!caps.precisePositioning && (offsetX !== 0 || offsetY !== 0)) {
    return null
  }

  // palette — canonical catalog only.
  const paletteId = values.paletteId
  if (typeof paletteId !== 'string' || !isValidPaletteId(paletteId)) return null
  if (!caps.paletteIds.includes(paletteId)) return null

  // shape — canonical + plan capability (Free never simulates pill).
  const shape = values.shape
  if (typeof shape !== 'string' || !isValidLauncherShape(shape)) return null
  if (!caps.launcherShapes.includes(shape)) return null

  // custom accent — null, or a valid #RRGGBB for entitled plans only.
  const customAccent = values.customAccent
  if (customAccent !== null) {
    if (typeof customAccent !== 'string') return null
    if (!isValidColor(customAccent)) return null
    if (!caps.customColors) return null
  }

  // open — exact boolean.
  const open = values.open
  if (typeof open !== 'boolean') return null

  // Fresh canonical copy — never the input reference.
  return {
    device,
    locale,
    anchor,
    offsetX,
    offsetY,
    paletteId,
    shape,
    customAccent,
    open,
  }
}
