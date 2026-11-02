/**
 * Smart Avoidance geometry — pure deterministic collision computation.
 *
 * Given the launcher's bounding rect and a set of obstacle rects, compute a
 * bounded displacement (dx, dy) that moves the launcher out of collision
 * while keeping it inside the viewport.
 *
 * Pure TS — no DOM, no browser dependencies.
 */

/** An axis-aligned bounding rectangle. */
export type AvoidanceRect = {
  left: number
  top: number
  right: number
  bottom: number
}

/** Default clearance between the launcher and obstacles. */
export const DEFAULT_GAP = 12

/** Default maximum displacement from the configured position. */
export const DEFAULT_MAX_SHIFT = 240

/**
 * Check if a rectangle is a valid usable CSS rect:
 * all four coordinates are finite numbers and right > left, bottom > top.
 */
function isValidRect(r: AvoidanceRect): boolean {
  return (
    Number.isFinite(r.left) && Number.isFinite(r.top) &&
    Number.isFinite(r.right) && Number.isFinite(r.bottom) &&
    r.right > r.left && r.bottom > r.top
  )
}

/**
 * Check if two rects overlap (or are within the given gap of each other).
 */
function overlaps(a: AvoidanceRect, b: AvoidanceRect, gap: number): boolean {
  return a.right + gap > b.left && a.left < b.right + gap &&
    a.bottom + gap > b.top && a.top < b.bottom + gap
}

/**
 * Check if a rect is fully inside the viewport (with gap margin).
 */
function insideViewport(r: AvoidanceRect, viewport: { width: number; height: number }): boolean {
  return r.left >= 0 && r.top >= 0 && r.right <= viewport.width && r.bottom <= viewport.height
}

/**
 * Compute a bounded displacement to avoid obstacles.
 *
 * Strategy: try candidate directions from the original position. For each
 * direction, find the minimum distance needed to clear all obstacles. Pick
 * the direction with the smallest displacement. If no valid displacement is
 * found within maxShift, return { dx: 0, dy: 0 }.
 *
 * Deterministic: the direction order is fixed and obstacles are not iterated
 * in an order-dependent way — each candidate displacement is tested against
 * ALL obstacles, so obstacle order does not affect the result.
 */
export function computeSmartAvoidanceShift(
  launcher: AvoidanceRect,
  obstacles: AvoidanceRect[],
  viewport: { width: number; height: number },
  options?: { gap?: number; maxShift?: number },
): { dx: number; dy: number } {
  const gap = Math.max(0, options?.gap ?? DEFAULT_GAP)
  const maxShift = Math.max(0, options?.maxShift ?? DEFAULT_MAX_SHIFT)

  // Validate launcher rect.
  if (!isValidRect(launcher)) return { dx: 0, dy: 0 }

  // Filter to valid obstacle rects that actually overlap the launcher.
  const active = obstacles.filter(o => isValidRect(o) && overlaps(launcher, o, gap))
  if (active.length === 0) return { dx: 0, dy: 0 }

  // Launcher dimensions.
  const w = launcher.right - launcher.left
  const h = launcher.bottom - launcher.top

  // Candidate directions (deterministic order): up, down, left, right, and
  // the four diagonals. For each direction, find the minimum shift that
  // clears all obstacles.
  const directions: Array<{ x: number; y: number }> = [
    { x: 0, y: -1 },  // up
    { x: 0, y: 1 },   // down
    { x: -1, y: 0 },  // left
    { x: 1, y: 0 },   // right
    { x: -1, y: -1 }, // up-left
    { x: 1, y: -1 },  // up-right
    { x: -1, y: 1 },  // down-left
    { x: 1, y: 1 },   // down-right
  ]

  let bestDx = 0
  let bestDy = 0
  let bestDistance = Infinity
  let found = false

  for (const dir of directions) {
    // Binary search for the minimum shift in this direction.
    let lo = 0
    let hi = maxShift
    let minValid = -1

    // Quick check: is maxShift in this direction sufficient?
    const maxRect: AvoidanceRect = {
      left: launcher.left + dir.x * maxShift,
      top: launcher.top + dir.y * maxShift,
      right: launcher.right + dir.x * maxShift,
      bottom: launcher.bottom + dir.y * maxShift,
    }
    if (!insideViewport(maxRect, viewport)) continue

    // Check if maxShift already clears all obstacles.
    let allClear = true
    for (const o of active) {
      const moved: AvoidanceRect = {
        left: launcher.left + dir.x * maxShift,
        top: launcher.top + dir.y * maxShift,
        right: launcher.right + dir.x * maxShift,
        bottom: launcher.bottom + dir.y * maxShift,
      }
      if (overlaps(moved, o, gap)) { allClear = false; break }
    }
    if (!allClear) continue

    // Binary search for the minimum shift that clears all obstacles.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const moved: AvoidanceRect = {
        left: launcher.left + dir.x * mid,
        top: launcher.top + dir.y * mid,
        right: launcher.right + dir.x * mid,
        bottom: launcher.bottom + dir.y * mid,
      }
      let clear = true
      for (const o of active) {
        if (overlaps(moved, o, gap)) { clear = false; break }
      }
      if (clear) {
        // Check viewport bounds.
        if (insideViewport(moved, viewport)) {
          minValid = mid
          hi = mid - 1
        } else {
          lo = mid + 1
        }
      } else {
        lo = mid + 1
      }
    }

    if (minValid >= 0 && minValid <= maxShift) {
      const dx = dir.x * minValid
      const dy = dir.y * minValid
      const dist = Math.hypot(dx, dy)
      if (dist < bestDistance) {
        bestDistance = dist
        bestDx = dx
        bestDy = dy
        found = true
      }
    }
  }

  if (!found) return { dx: 0, dy: 0 }

  // Verify the best result is valid (viewport bounds + no overlap).
  const finalRect: AvoidanceRect = {
    left: launcher.left + bestDx,
    top: launcher.top + bestDy,
    right: launcher.right + bestDx,
    bottom: launcher.bottom + bestDy,
  }
  if (!insideViewport(finalRect, viewport)) return { dx: 0, dy: 0 }
  for (const o of active) {
    if (overlaps(finalRect, o, gap)) return { dx: 0, dy: 0 }
  }

  return { dx: bestDx, dy: bestDy }
}
