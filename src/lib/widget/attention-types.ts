/**
 * Attention animation types + validation — standalone module to avoid
 * circular imports between appearance-v2.ts and effective-attention.ts.
 *
 * Mirrors the launcher-types.ts separation pattern: pure TS, no Prisma,
 * no Next.js, no server-only imports. Safe for the NPM widget / browser
 * bundle to import.
 *
 * Feature 4 — Attention Animations.
 *
 * Animation catalog:
 *   - 'none'   — no motion (default, preserves legacy appearance).
 *   - 'pulse'  — subtle scale pulse (basic, available to all plans).
 *   - 'bounce' — gentle vertical bounce (advanced / paid-only).
 *   - 'shake'  — small horizontal shake (advanced / paid-only).
 *   - 'glow'   — soft box-shadow glow (advanced / paid-only).
 *
 * Entitlement model (see widget-entitlements.ts):
 *   - attentionAnimations: 'basic'  → 'none' + 'pulse' (Free).
 *   - attentionAnimations: 'advanced' → all five (Pro / Max / Self-hosted).
 *   - Unknown plans → fail closed to 'none'.
 *
 * Downgrade/upgrade preservation:
 *   - When a paid tenant selects an advanced-only animation then
 *     downgrades to Free, the active animation becomes a basic one, but
 *     the advanced selection is stored in `paidAnimation` so it can be
 *     restored on upgrade — exactly the pattern established by
 *     LauncherConfig.paidShape.
 *   - `paidAnimation` may ONLY hold an advanced-only animation
 *     (bounce/shake/glow). Storing 'none' or 'pulse' as paidAnimation
 *     is contradictory and rejected by the parser.
 */

/** All supported attention animations. */
export const ATTENTION_ANIMATIONS = ['none', 'pulse', 'bounce', 'shake', 'glow'] as const
export type AttentionAnimation = (typeof ATTENTION_ANIMATIONS)[number]

/** Animations available to Free (attentionAnimations='basic'). */
export const BASIC_ATTENTION_ANIMATIONS: readonly AttentionAnimation[] = ['none', 'pulse']

/** Animations that are advanced-only (not available on Free). */
export const ADVANCED_ONLY_ATTENTION_ANIMATIONS: readonly AttentionAnimation[] = [
  'bounce',
  'shake',
  'glow',
]

/** The default attention animation (fail-closed for unknown plans + legacy). */
export const DEFAULT_ATTENTION_ANIMATION: AttentionAnimation = 'none'

/**
 * Check if a value is a valid attention animation.
 */
export function isValidAttentionAnimation(value: unknown): value is AttentionAnimation {
  if (typeof value !== 'string') return false
  return (ATTENTION_ANIMATIONS as readonly string[]).includes(value)
}

/**
 * Check if an animation is an advanced-only animation (not available on Free).
 * 'none' and 'pulse' are basic (available to all plans) and are NEVER
 * advanced-only. Only bounce/shake/glow are advanced-only.
 */
export function isAdvancedOnlyAttentionAnimation(animation: AttentionAnimation): boolean {
  return ADVANCED_ONLY_ATTENTION_ANIMATIONS.includes(animation)
}
