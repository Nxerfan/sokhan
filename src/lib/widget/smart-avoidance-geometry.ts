/**
 * Smart Avoidance geometry — pure deterministic collision computation.
 *
 * Given the launcher's bounding rect and a set of obstacle rects, compute a
 * bounded displacement (dx, dy) that moves the launcher out of collision
 * while keeping it inside the viewport.
 *
 * Search algorithm (bounded interval solver):
 *   1. No initial collision (with the clearance gap) → { dx: 0, dy: 0 }.
 *   2. Relevant obstacles are ALL valid obstacles the launcher could hit at
 *      ANY bounded destination — the launcher rect expanded by maxShift on
 *      every side — NOT only obstacles overlapping the initial position.
 *      A nearby obstacle that only becomes reachable after moving is fully
 *      considered.
 *   3. Eight candidate directions (4 cardinals + 4 exact 45° diagonals with
 *      unit components, so the maxShift limit is a Euclidean distance bound
 *      including diagonal moves). Per direction the reachable magnitude is
 *      capped analytically by the viewport edges AND maxShift — a short
 *      legal move is considered even when the full maxShift endpoint would
 *      leave the viewport.
 *   4. Along a direction, the set of magnitudes that collide with a given
 *      obstacle is an open interval (each of the four separation conditions
 *      is linear in the magnitude). The union of blocked intervals is NOT
 *      monotonic — an escape can be followed by another obstacle — so the
 *      solver collects every interval endpoint as a candidate magnitude,
 *      sorts them, and verifies each in ascending order against EVERY
 *      relevant obstacle. Touching an obstacle at exactly the clearance
 *      gap counts as clear.
 *   5. The verified minimum per direction wins globally; ties keep the
 *      first direction in the fixed order. Every accepted magnitude is
 *      verified exactly: translated launcher inside the viewport,
 *      Euclidean displacement ≤ maxShift, and clear of all relevant
 *      obstacles. { dx: 0, dy: 0 } only when no valid bounded solution
 *      exists.
 *
 * Deterministic and order-independent: fixed direction order, sorted
 * candidate magnitudes, and verification over the whole obstacle set mean
 * obstacle ordering can never change the result. Small upward nudges
 * (≤1px) recover endpoint candidates that float round-trips would
 * otherwise reject by an ulp; nudges never skip past the next candidate,
 * so the minimal solution is never overshot.
 *
 * Pure TS — no DOM, no browser dependencies. The three runtimes
 * (slug script, v1 script, NPM widget) inline this exact algorithm.
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
 * Touching at exactly the gap distance is NOT an overlap (it is clear).
 */
function overlaps(a: AvoidanceRect, b: AvoidanceRect, gap: number): boolean {
  return a.right + gap > b.left && a.left < b.right + gap &&
    a.bottom + gap > b.top && a.top < b.bottom + gap
}

/**
 * Check if a rect is fully inside the viewport.
 */
function insideViewport(r: AvoidanceRect, viewport: { width: number; height: number }): boolean {
  return r.left >= 0 && r.top >= 0 && r.right <= viewport.width && r.bottom <= viewport.height
}

/**
 * Compute a bounded displacement to avoid obstacles.
 *
 * Always measured from the ORIGINAL configured position (the caller passes
 * the un-shifted launcher rect) — no cumulative drift. Never returns
 * non-finite values; invalid inputs fail closed to { dx: 0, dy: 0 }.
 */
export function computeSmartAvoidanceShift(
  launcher: AvoidanceRect,
  obstacles: AvoidanceRect[],
  viewport: { width: number; height: number },
  options?: { gap?: number; maxShift?: number },
): { dx: number; dy: number } {
  const rawGap = options?.gap
  const rawMaxShift = options?.maxShift
  const gap = typeof rawGap === 'number' && Number.isFinite(rawGap) ? Math.max(0, rawGap) : DEFAULT_GAP
  const maxShift = typeof rawMaxShift === 'number' && Number.isFinite(rawMaxShift) ? Math.max(0, rawMaxShift) : DEFAULT_MAX_SHIFT

  // Reject invalid launcher / viewport / obstacle-list inputs (fail closed).
  if (!launcher || !isValidRect(launcher)) return { dx: 0, dy: 0 }
  if (!viewport ||
    typeof viewport.width !== 'number' || !Number.isFinite(viewport.width) || viewport.width < 0 ||
    typeof viewport.height !== 'number' || !Number.isFinite(viewport.height) || viewport.height < 0) {
    return { dx: 0, dy: 0 }
  }
  if (!Array.isArray(obstacles)) return { dx: 0, dy: 0 }

  // All valid obstacle rects — invalid rectangles (NaN / Infinity /
  // degenerate) are ignored so they can never produce invalid CSS.
  const all: AvoidanceRect[] = []
  for (const o of obstacles) {
    if (o && isValidRect(o)) all.push(o)
  }

  // No initial collision → keep the configured placement (zero shift).
  let collides = false
  for (const o of all) {
    if (overlaps(launcher, o, gap)) { collides = true; break }
  }
  if (!collides) return { dx: 0, dy: 0 }

  // Relevant obstacles: anything the launcher could collide with at ANY
  // bounded destination — the launcher expanded by maxShift on every side
  // (checked with the clearance gap). This includes obstacles that do NOT
  // overlap the initial position but sit in the path of a candidate move.
  const reach: AvoidanceRect = {
    left: launcher.left - maxShift,
    top: launcher.top - maxShift,
    right: launcher.right + maxShift,
    bottom: launcher.bottom + maxShift,
  }
  const relevant: AvoidanceRect[] = []
  for (const o of all) {
    if (overlaps(reach, o, gap)) relevant.push(o)
  }

  // Eight candidate directions in a fixed order: up, down, left, right,
  // then the four exact 45° diagonals. Diagonal components are unit-length
  // (Math.SQRT1_2) so the maxShift bound stays Euclidean for diagonals.
  const SQ = Math.SQRT1_2
  const directions: Array<{ x: number; y: number }> = [
    { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -SQ, y: -SQ }, { x: SQ, y: -SQ }, { x: -SQ, y: SQ }, { x: SQ, y: SQ },
  ]

  // Nudge ladder for endpoint candidates that float round-trips reject by
  // an ulp. Ascending and tiny — never skips past the next candidate.
  const NUDGES = [0, 0.000001, 0.001, 0.01, 0.1, 0.5, 1]

  // Verify a magnitude exactly: translated launcher inside the viewport,
  // Euclidean displacement within maxShift, and clear of EVERY relevant
  // obstacle (not only the initially overlapping ones).
  const clearAt = (dirX: number, dirY: number, m: number, mCap: number): boolean => {
    if (!(m >= 0) || m > mCap) return false
    const dx = dirX * m
    const dy = dirY * m
    const moved: AvoidanceRect = {
      left: launcher.left + dx,
      top: launcher.top + dy,
      right: launcher.right + dx,
      bottom: launcher.bottom + dy,
    }
    if (!insideViewport(moved, viewport)) return false
    if (Math.sqrt(dx * dx + dy * dy) > maxShift) return false
    for (const o of relevant) {
      if (overlaps(moved, o, gap)) return false
    }
    return true
  }

  let bestDx = 0
  let bestDy = 0
  let bestDistance = Infinity
  let found = false

  for (const dir of directions) {
    // Reachable magnitude cap: the analytic per-axis bound that keeps the
    // translated launcher inside the viewport, and maxShift. A direction is
    // NOT rejected because its full maxShift endpoint exits the viewport —
    // only the reachable in-viewport interval is searched.
    let mCap = maxShift
    if (dir.x > 0) {
      const bound = (viewport.width - launcher.right) / dir.x
      if (bound < mCap) mCap = bound
    } else if (dir.x < 0) {
      const bound = launcher.left / -dir.x
      if (bound < mCap) mCap = bound
    }
    if (dir.y > 0) {
      const bound = (viewport.height - launcher.bottom) / dir.y
      if (bound < mCap) mCap = bound
    } else if (dir.y < 0) {
      const bound = launcher.top / -dir.y
      if (bound < mCap) mCap = bound
    }
    if (!(mCap > 0)) continue

    // Blocked magnitude intervals per relevant obstacle. For obstacle o the
    // launcher translated by dir·m overlaps o (within the gap) exactly when
    // all four linear conditions hold, which bounds m to an open interval.
    // Candidate magnitudes: 0 plus every in-range interval endpoint.
    const candidates: number[] = [0]
    for (const o of relevant) {
      let lo = -Infinity
      let hi = Infinity
      // A: launcher.right + dirX*m + gap > o.left
      const cA = o.left - gap - launcher.right
      if (dir.x > 0) {
        const bound = cA / dir.x
        if (bound > lo) lo = bound
      } else if (dir.x < 0) {
        const bound = cA / dir.x
        if (bound < hi) hi = bound
      } else if (!(cA < 0)) {
        hi = -Infinity
      }
      // B: launcher.left + dirX*m < o.right + gap
      const cB = o.right + gap - launcher.left
      if (dir.x > 0) {
        const bound = cB / dir.x
        if (bound < hi) hi = bound
      } else if (dir.x < 0) {
        const bound = cB / dir.x
        if (bound > lo) lo = bound
      } else if (!(cB > 0)) {
        hi = -Infinity
      }
      // C: launcher.bottom + dirY*m + gap > o.top
      const cC = o.top - gap - launcher.bottom
      if (dir.y > 0) {
        const bound = cC / dir.y
        if (bound > lo) lo = bound
      } else if (dir.y < 0) {
        const bound = cC / dir.y
        if (bound < hi) hi = bound
      } else if (!(cC < 0)) {
        hi = -Infinity
      }
      // D: launcher.top + dirY*m < o.bottom + gap
      const cD = o.bottom + gap - launcher.top
      if (dir.y > 0) {
        const bound = cD / dir.y
        if (bound < hi) hi = bound
      } else if (dir.y < 0) {
        const bound = cD / dir.y
        if (bound > lo) lo = bound
      } else if (!(cD > 0)) {
        hi = -Infinity
      }
      if (lo < hi) {
        if (lo >= 0 && lo <= mCap) candidates.push(lo)
        if (hi >= 0 && hi <= mCap) candidates.push(hi)
      }
    }
    candidates.sort((a, b) => a - b)

    // Ascending candidate walk: the first magnitude (plus capped nudges)
    // that verifies is this direction's minimum. Blocked intervals in
    // between are simply skipped — no monotonicity assumption.
    for (let ci = 0; ci < candidates.length; ci++) {
      if (ci > 0 && candidates[ci] === candidates[ci - 1]) continue
      const next = ci + 1 < candidates.length ? candidates[ci + 1] : Infinity
      let ok = -1
      for (let ni = 0; ni < NUDGES.length; ni++) {
        const mTry = candidates[ci] + NUDGES[ni]
        if (mTry > mCap) break
        if (ni > 0 && mTry >= next) break
        if (clearAt(dir.x, dir.y, mTry, mCap)) { ok = mTry; break }
      }
      if (ok < 0) continue
      const dx = dir.x * ok
      const dy = dir.y * ok
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= maxShift && dist < bestDistance) {
        bestDistance = dist
        bestDx = dx
        bestDy = dy
        found = true
      }
      break
    }
  }

  if (!found) return { dx: 0, dy: 0 }
  return { dx: bestDx, dy: bestDy }
}
