/**
 * Sukhan Widget — V2 Positioning geometry (NPM package self-contained copy).
 *
 * This is the CANONICAL geometry logic for the NPM widget. The server-side
 * copy lives in `src/lib/widget/positioning-geometry.ts`. Both MUST produce
 * identical output — verified by parity tests.
 *
 * ## Coordinate semantics
 *
 * - `anchor` — the base position (logical). RTL/LTR flips start↔end.
 * - `offsetX` — horizontal pixels, positive = right (physical).
 * - `offsetY` — vertical pixels, positive = up (physical).
 *
 * The function computes `{ left, bottom }` in pixels from anchor + offsets
 * + viewport + safe-area, then CLAMPS so the launcher stays visible +
 * tappable.
 */

export const POSITIONING_ANCHORS = ['bottom-start', 'bottom-end', 'bottom-center'] as const
export type PositioningAnchor = (typeof POSITIONING_ANCHORS)[number]

export interface DevicePositioning {
  anchor: PositioningAnchor
  offsetX?: number
  offsetY?: number
}

export interface EffectivePositioning {
  anchor: PositioningAnchor
  offsetX: number
  offsetY: number
}

export const DEFAULT_POSITIONING: EffectivePositioning = {
  anchor: 'bottom-end',
  offsetX: 0,
  offsetY: 0,
}

export const OFFSET_MIN = -2000
export const OFFSET_MAX = 2000
export const DEFAULT_BASE_MARGIN = 20
export const MIN_TOUCH_TARGET = 44

export interface LauncherPositionInput {
  anchor: PositioningAnchor
  offsetX: number
  offsetY: number
  dir: 'rtl' | 'ltr'
  viewportWidth: number
  viewportHeight: number
  launcherWidth: number
  launcherHeight: number
  safeAreaBottom: number
  baseMargin: number
}

export interface LauncherPositionOutput {
  left: number
  bottom: number
  panelSide: 'left' | 'right' | 'center'
}

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

  let left = baseLeft + offsetX
  let bottom = baseMargin + offsetY + safeAreaBottom

  const maxLeft = Math.max(0, viewportWidth - launcherWidth)
  left = Math.max(0, Math.min(left, maxLeft))

  const minBottom = safeAreaBottom
  const maxBottom = Math.max(minBottom, viewportHeight - launcherHeight - safeAreaBottom)
  bottom = Math.max(minBottom, Math.min(bottom, maxBottom))

  let panelSide: 'left' | 'right' | 'center'
  if (anchor === 'bottom-center') {
    panelSide = 'center'
  } else {
    const launcherCenter = left + launcherWidth / 2
    panelSide = launcherCenter < viewportWidth / 2 ? 'right' : 'left'
  }

  return { left, bottom, panelSide }
}

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

export function isValidOffset(value: unknown): value is number {
  if (typeof value !== 'number') return false
  if (!Number.isFinite(value)) return false
  if (!Number.isInteger(value)) return false
  return value >= OFFSET_MIN && value <= OFFSET_MAX
}

export function isValidAnchor(value: unknown): value is PositioningAnchor {
  if (typeof value !== 'string') return false
  return (POSITIONING_ANCHORS as readonly string[]).includes(value)
}
