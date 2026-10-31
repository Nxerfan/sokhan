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
 * Input for computing the chat panel's vertical position.
 * The panel must stay within the usable viewport — if there isn't
 * enough space above the launcher, it opens below; if neither fits
 * fully, the height is clamped.
 */
export interface PanelVerticalInput {
  /** The root element's `bottom` CSS value (distance from viewport bottom). */
  rootBottom: number
  /** Launcher height in px (depends on shape: tab=52, pill=48, rounded=52). */
  launcherHeight: number
  /** Viewport height in px. */
  viewportHeight: number
  /** Gap between panel edge and launcher edge (default 12). */
  panelGap: number
  /** Preferred panel height before clamping (default 500). */
  panelPreferredHeight: number
  /** Safe-area inset bottom (env(safe-area-inset-bottom) or 0). */
  safeAreaBottom: number
}

/**
 * Output: the panel's vertical CSS values relative to the root element.
 */
export interface PanelVerticalOutput {
  /** CSS `bottom` value for the panel (px, relative to root). Positive = above launcher. */
  bottom: number
  /** Clamped maxHeight for the panel (px). */
  maxHeight: number
  /** Whether the panel opens below the launcher (true) or above (false). */
  opensBelow: boolean
}

/**
 * Compute the chat panel's vertical position so it stays within the
 * usable viewport.
 *
 * Decision logic:
 *   1. Try opening ABOVE the launcher (default). If the panel fits
 *      (panelHeight + gap ≤ spaceAbove), open above.
 *   2. If above doesn't fit, try opening BELOW. If it fits, open below.
 *   3. If neither fits fully, pick the side with more space and clamp
 *      the panel height to the available space (no minimum — the panel
 *      stays within the viewport even if the available space is very small).
 *
 * Never throws. Returns clamped values for any finite input.
 */
export function computePanelVerticalPosition(opts: PanelVerticalInput): PanelVerticalOutput {
  const { rootBottom, launcherHeight, viewportHeight, panelGap, panelPreferredHeight, safeAreaBottom } = opts

  // Space above the launcher (from launcher top to viewport top, minus safe area).
  const spaceAbove = Math.max(0, viewportHeight - rootBottom - launcherHeight - safeAreaBottom)
  // Space below the launcher (from root bottom to viewport bottom, minus safe area).
  const spaceBelow = Math.max(0, rootBottom - safeAreaBottom)

  // Preferred panel height clamped to viewport. No minimum — if the
  // viewport is very short, the panel is clamped to whatever space is
  // physically available (the panel may be tiny but must NOT overflow).
  const viewportClampedHeight = Math.min(
    panelPreferredHeight,
    viewportHeight - safeAreaBottom * 2 - panelGap * 2,
  )

  // Try above first (default behavior).
  if (spaceAbove >= viewportClampedHeight + panelGap) {
    return { bottom: launcherHeight + panelGap, maxHeight: viewportClampedHeight, opensBelow: false }
  }

  // Try below.
  if (spaceBelow >= viewportClampedHeight + panelGap) {
    return { bottom: -(viewportClampedHeight + panelGap), maxHeight: viewportClampedHeight, opensBelow: true }
  }

  // Neither fits fully — pick the side with more space + clamp height
  // to available space (no minimum — the panel stays within the viewport
  // even if the available space is very small).
  if (spaceAbove >= spaceBelow) {
    const clampedHeight = Math.max(0, spaceAbove - panelGap)
    return { bottom: launcherHeight + panelGap, maxHeight: clampedHeight, opensBelow: false }
  } else {
    const clampedHeight = Math.max(0, spaceBelow - panelGap)
    return { bottom: -(clampedHeight + panelGap), maxHeight: clampedHeight, opensBelow: true }
  }
}

/**
 * Input for computing the chat panel's horizontal position.
 * The panel must stay within the usable viewport — its left position
 * is clamped so neither edge overflows.
 */
export interface PanelHorizontalInput {
  /** The root element's left position in viewport px (from computeLauncherPosition). */
  launcherLeft: number
  /** Launcher width in px. */
  launcherWidth: number
  /** Preferred panel width before clamping (default 360). */
  panelPreferredWidth: number
  /** Viewport width in px. */
  viewportWidth: number
  /** The side the panel should open toward (from computeLauncherPosition.panelSide). */
  panelSide: 'left' | 'right' | 'center'
  /** Horizontal margin from the viewport edge (default 20, same as baseMargin). */
  viewportMargin: number
}

/**
 * Output: the panel's horizontal CSS values relative to the root element.
 */
export interface PanelHorizontalOutput {
  /** CSS `left` value for the panel (px, relative to root element). */
  left: number
  /** Clamped panel width (px). */
  width: number
}

/**
 * Compute the chat panel's horizontal position so it stays within the
 * usable viewport. The panel's left position is clamped so neither the
 * left nor right edge overflows the viewport.
 *
 * The panel is positioned relative to the root element (which contains
 * the launcher). The `left` value is relative to the root's left edge.
 *
 * Never throws. Returns clamped values for any finite input.
 */
export function computePanelHorizontalPosition(opts: PanelHorizontalInput): PanelHorizontalOutput {
  const { launcherLeft, launcherWidth, panelPreferredWidth, viewportWidth, panelSide, viewportMargin } = opts

  // Clamp panel width to usable viewport (leave margin on both sides).
  const maxPanelWidth = Math.max(0, viewportWidth - viewportMargin * 2)
  const clampedWidth = Math.min(panelPreferredWidth, maxPanelWidth)

  // Compute the panel's desired left position relative to the root element.
  let panelLeft: number
  if (panelSide === 'right') {
    // Panel opens to the right: left edge aligns with root's left edge.
    panelLeft = 0
  } else if (panelSide === 'left') {
    // Panel opens to the left: right edge aligns with root's right edge.
    panelLeft = launcherWidth - clampedWidth
  } else {
    // Center: panel centered on the launcher.
    panelLeft = (launcherWidth - clampedWidth) / 2
  }

  // The panel's absolute left in viewport = launcherLeft + panelLeft.
  // Clamp so the panel stays within [viewportMargin, viewportWidth - viewportMargin - clampedWidth].
  const absLeft = launcherLeft + panelLeft
  const minAbsLeft = viewportMargin
  const maxAbsLeft = Math.max(minAbsLeft, viewportWidth - viewportMargin - clampedWidth)
  const clampedAbsLeft = Math.max(minAbsLeft, Math.min(absLeft, maxAbsLeft))

  // Convert back to relative-to-root.
  const clampedPanelLeft = clampedAbsLeft - launcherLeft

  return { left: clampedPanelLeft, width: clampedWidth }
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
 *
 * The inverse is mathematically consistent with the forward geometry:
 *   forward: left = baseLeft + offsetX
 *   inverse: offsetX = absoluteLeft - baseLeft
 *
 * This is correct for ALL anchors (start/end/center) + RTL/LTR because
 * the forward function always uses `left = baseLeft + offsetX`.
 */
export function offsetXFromAbsoluteLeft(
  anchor: PositioningAnchor,
  absoluteLeft: number,
  dir: 'rtl' | 'ltr',
  viewportWidth: number,
  launcherWidth: number,
  baseMargin: number,
): number {
  // Compute the same baseLeft as computeLauncherPosition.
  let baseLeft: number
  if (anchor === 'bottom-center') {
    baseLeft = (viewportWidth - launcherWidth) / 2
  } else {
    const isStart = anchor === 'bottom-start'
    const startIsLeft = dir === 'ltr' ? isStart : !isStart
    if (startIsLeft) {
      baseLeft = baseMargin
    } else {
      baseLeft = viewportWidth - launcherWidth - baseMargin
    }
  }
  // Inverse: offsetX = absoluteLeft - baseLeft (same for all anchors).
  return absoluteLeft - baseLeft
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
