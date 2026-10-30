/**
 * Widget V2 Positioning — shared types + geometry computation.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * dashboard (client) + the NPM widget (browser bundle) + server-side
 * effective resolution.
 *
 * ## Coordinate semantics
 *
 * - `anchor` — the base position (logical). RTL/LTR flips start↔end.
 *   - `bottom-start`  → LTR: bottom-left;  RTL: bottom-right
 *   - `bottom-end`    → LTR: bottom-right; RTL: bottom-left
 *   - `bottom-center` → bottom-center (same both dirs)
 * - `offsetX` — horizontal adjustment in PHYSICAL pixels.
 *   Positive = right. Negative = left. Always physical (not logical)
 *   so slider/drag/input are direction-consistent regardless of RTL.
 * - `offsetY` — vertical adjustment in PHYSICAL pixels.
 *   Positive = up. Negative = down.
 *
 * The geometry function computes the final `{ left, bottom }` in pixels
 * from the anchor + offsets + viewport + safe-area, then CLAMPS so the
 * launcher stays visible + tappable (≥44px touch target).
 */

/** The 3 predefined positioning anchors. */
export const POSITIONING_ANCHORS = ['bottom-start', 'bottom-end', 'bottom-center'] as const
export type PositioningAnchor = (typeof POSITIONING_ANCHORS)[number]

/**
 * Per-device positioning config (stored inside `appearanceV2.desktop` /
 * `appearanceV2.mobile`).
 *
 * Free plan: only `anchor` is used. `offsetX`/`offsetY` are rejected on
 * write + not applied on read (but may remain stored for upgrade restore).
 */
export interface DevicePositioning {
  anchor: PositioningAnchor
  /** Horizontal offset in pixels (positive = right). Advanced plans only. */
  offsetX?: number
  /** Vertical offset in pixels (positive = up). Advanced plans only. */
  offsetY?: number
}

/**
 * The effective positioning (what the widget actually renders) — after
 * entitlement enforcement. Offsets are present only when the plan is
 * entitled to precise positioning.
 */
export interface EffectivePositioning {
  anchor: PositioningAnchor
  offsetX: number
  offsetY: number
}

/** Default positioning (fail-closed for unknown plans / missing config). */
export const DEFAULT_POSITIONING: EffectivePositioning = {
  anchor: 'bottom-end',
  offsetX: 0,
  offsetY: 0,
}

/** Bounds for X/Y offsets (finite integers). */
export const OFFSET_MIN = -2000
export const OFFSET_MAX = 2000

/** Default base margin from the viewport edge (pixels). */
export const DEFAULT_BASE_MARGIN = 20

/** Minimum touch-target size (pixels). */
export const MIN_TOUCH_TARGET = 44

/**
 * Input to the geometry computation. All values are physical pixels.
 */
export interface LauncherPositionInput {
  anchor: PositioningAnchor
  offsetX: number
  offsetY: number
  dir: 'rtl' | 'ltr'
  viewportWidth: number
  viewportHeight: number
  launcherWidth: number
  launcherHeight: number
  /** env(safe-area-inset-bottom) or 0 if unsupported. */
  safeAreaBottom: number
  /** Base margin from the edge (default 20). */
  baseMargin: number
}

/**
 * Output: the computed CSS position for the launcher root element.
 * Always uses `left` + `bottom` (never `right` or `transform`) so the
 * value is a pure function of the inputs — recomputed on resize.
 */
export interface LauncherPositionOutput {
  /** Pixels from the left edge of the viewport. */
  left: number
  /** Pixels from the bottom edge of the viewport. */
  bottom: number
  /** The side the panel should open toward (opposite the launcher edge). */
  panelSide: 'left' | 'right' | 'center'
}

/**
 * Compute the launcher position from anchor + offsets + viewport.
 *
 * This is the CANONICAL geometry function. The NPM widget has its own
 * copy (`packages/widget-npm/src/positioning.ts`) that must produce
 * identical output — verified by parity tests.
 *
 * Clamping:
 *   - `left` is clamped to [0, viewportWidth - launcherWidth] so the
 *     launcher never overflows horizontally.
 *   - `bottom` is clamped to [safeAreaBottom, viewportHeight -
 *     launcherHeight - safeAreaBottom] so the launcher stays visible
 *     above the safe area + below the top of the viewport.
 *   - If the viewport is too narrow/short for the launcher, the launcher
 *     is clamped to 0 (top-left) — it remains visible + tappable.
 *
 * Never throws. Returns clamped values for any finite input.
 */
export function computeLauncherPosition(opts: LauncherPositionInput): LauncherPositionOutput {
  const {
    anchor,
    offsetX,
    offsetY,
    dir,
    viewportWidth,
    viewportHeight,
    launcherWidth,
    launcherHeight,
    safeAreaBottom,
    baseMargin,
  } = opts

  // ── Determine the base left position from the anchor + direction ──
  let baseLeft: number
  if (anchor === 'bottom-center') {
    baseLeft = (viewportWidth - launcherWidth) / 2
  } else {
    // bottom-start: LTR → left side; RTL → right side
    // bottom-end:   LTR → right side; RTL → left side
    const isStart = anchor === 'bottom-start'
    const startIsLeft = dir === 'ltr' ? isStart : !isStart
    if (startIsLeft) {
      baseLeft = baseMargin
    } else {
      baseLeft = viewportWidth - launcherWidth - baseMargin
    }
  }

  // Apply offsetX (positive = right, physical).
  let left = baseLeft + offsetX

  // Apply offsetY (positive = up).
  let bottom = baseMargin + offsetY + safeAreaBottom

  // ── Clamp left so launcher stays within the viewport ──
  const maxLeft = Math.max(0, viewportWidth - launcherWidth)
  left = Math.max(0, Math.min(left, maxLeft))

  // ── Clamp bottom so launcher stays visible + above safe area ──
  const minBottom = safeAreaBottom
  const maxBottom = Math.max(minBottom, viewportHeight - launcherHeight - safeAreaBottom)
  bottom = Math.max(minBottom, Math.min(bottom, maxBottom))

  // ── Determine panel side (opposite the launcher edge) ──
  let panelSide: 'left' | 'right' | 'center'
  if (anchor === 'bottom-center') {
    panelSide = 'center'
  } else {
    // If the launcher is in the left half, panel opens to the right;
    // if in the right half, panel opens to the left.
    const launcherCenter = left + launcherWidth / 2
    panelSide = launcherCenter < viewportWidth / 2 ? 'right' : 'left'
  }

  return { left, bottom, panelSide }
}

/**
 * Back-compute the offsetX from a desired absolute left position.
 *
 * Used by the drag handler: the user drags the launcher to a new
 * position → we compute the new desired left → back-compute the
 * offsetX → store it → re-render via `computeLauncherPosition`.
 *
 * This ensures drag, slider, and numeric input all manipulate the SAME
 * `offsetX` state, and the CSS is always computed by the same function.
 */
export function offsetXFromAbsoluteLeft(
  anchor: PositioningAnchor,
  absoluteLeft: number,
  dir: 'rtl' | 'ltr',
  viewportWidth: number,
  launcherWidth: number,
  baseMargin: number,
): number {
  if (anchor === 'bottom-center') {
    const baseLeft = (viewportWidth - launcherWidth) / 2
    return absoluteLeft - baseLeft
  }
  const isStart = anchor === 'bottom-start'
  const startIsLeft = dir === 'ltr' ? isStart : !isStart
  if (startIsLeft) {
    return absoluteLeft - baseMargin
  } else {
    return (viewportWidth - launcherWidth - baseMargin) - absoluteLeft
  }
}

/**
 * Check if a value is a valid finite integer within the offset bounds.
 * Rejects NaN, Infinity, strings, fractions, booleans, objects.
 */
export function isValidOffset(value: unknown): value is number {
  if (typeof value !== 'number') return false
  if (!Number.isFinite(value)) return false
  if (!Number.isInteger(value)) return false
  return value >= OFFSET_MIN && value <= OFFSET_MAX
}

/**
 * Check if a value is a valid positioning anchor.
 */
export function isValidAnchor(value: unknown): value is PositioningAnchor {
  if (typeof value !== 'string') return false
  return (POSITIONING_ANCHORS as readonly string[]).includes(value)
}
