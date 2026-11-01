/**
 * Widget V2 Attention Animations — effective resolution + entitlement enforcement.
 *
 * Derives the EFFECTIVE attention animation from:
 *   1. Stored V2 attention selection (parsed strictly).
 *   2. DEFAULT_ATTENTION_ANIMATION ('none') if nothing valid / no V2 field.
 *
 * There is no V1 fallback for attention (it is a purely V2 feature) —
 * legacy tenants (no V2 attention field) always resolve to 'none', which
 * preserves the unanimated launcher.
 *
 * Entitlement enforcement:
 *   - `attentionAnimations: 'basic'` (Free) → only 'none' and 'pulse'.
 *   - `attentionAnimations: 'advanced'` (paid) → all five animations.
 *   - Unknown plans (null entitlements) → fail closed to 'none'.
 *
 * Downgrade/upgrade restoration (mirrors effective-launcher.ts):
 *   - When a paid tenant selects an advanced animation then downgrades to
 *     Free, the active animation is forced to a basic one, but the
 *     advanced selection is preserved in `paidAnimation`.
 *   - On re-upgrade (plan becomes 'advanced' again), the resolver restores
 *     `paidAnimation` as the effective animation.
 *   - An explicit Pro selection always wins: mergeAttentionPatch clears
 *     paidAnimation for every authorized advanced selection (including
 *     when the new animation equals the stored basic animation), so a
 *     stale paidAnimation can never override an explicit choice. This is
 *     the same contract fixed for LauncherConfig.paidShape in PR #18.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  ATTENTION_ANIMATIONS,
  BASIC_ATTENTION_ANIMATIONS,
  ADVANCED_ONLY_ATTENTION_ANIMATIONS,
  DEFAULT_ATTENTION_ANIMATION,
  isValidAttentionAnimation,
  isAdvancedOnlyAttentionAnimation,
  type AttentionAnimation,
} from './attention-types'

// Re-export for backward compatibility (other modules import from here).
export {
  ATTENTION_ANIMATIONS,
  BASIC_ATTENTION_ANIMATIONS,
  ADVANCED_ONLY_ATTENTION_ANIMATIONS,
  DEFAULT_ATTENTION_ANIMATION,
  isValidAttentionAnimation,
  isAdvancedOnlyAttentionAnimation,
  type AttentionAnimation,
}

/**
 * The effective attention animation (what the widget actually renders).
 */
export interface EffectiveAttention {
  animation: AttentionAnimation
}

/**
 * Stored attention input — the V2 `appearanceV2` field (raw, untyped —
 * parsed strictly here). Attention has no V1 fallback.
 */
export interface StoredAttentionInput {
  /** V2 appearance field (raw — parsed strictly by parseAppearanceV2). */
  appearanceV2?: unknown
}

/**
 * Check if an animation is allowed for a plan's entitlement.
 *
 * 'basic' (Free) → only 'none' and 'pulse'.
 * 'advanced' (paid) → all five animations.
 * null entitlements (unknown plan) → nothing allowed (fail closed).
 */
export function isAttentionAnimationAllowed(
  animation: AttentionAnimation,
  entitlements: Readonly<WidgetEntitlements> | null,
): boolean {
  if (!entitlements) return false
  if (entitlements.attentionAnimations === 'advanced') return true
  // 'basic' (Free) → only none + pulse
  return BASIC_ATTENTION_ANIMATIONS.includes(animation)
}

/**
 * Resolve the effective attention animation from stored config + plan entitlements.
 *
 * Resolution order:
 *   1. Stored V2 attention: if the plan is now entitled to the active
 *      animation, apply it. If NOT entitled (e.g. Free after downgrade
 *      from Pro with a stored advanced animation):
 *        a. If a paidAnimation is stored AND the plan is now entitled to
 *           it (e.g. re-upgraded to Pro), restore the paidAnimation.
 *        b. Otherwise, fall back to the safe default ('none').
 *      Additionally, when the plan is 'advanced' AND a paidAnimation is
 *      stored, the paidAnimation takes priority (restore on upgrade).
 *   2. DEFAULT_ATTENTION_ANIMATION ('none') — no V1 fallback for attention.
 *
 * Entitlement enforcement:
 *   - null entitlements (unknown plan) → fail closed to 'none'.
 *   - attentionAnimations='basic' → only 'none' and 'pulse' applied.
 *     Advanced-only animations (bounce/shake/glow) stored but NOT applied.
 *   - attentionAnimations='advanced' → all animations applied, including
 *     restored paidAnimation from prior downgrade.
 */
export function resolveEffectiveAttention(
  stored: StoredAttentionInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveAttention {
  // Fail closed for unknown plans.
  if (!entitlements) {
    return { animation: DEFAULT_ATTENTION_ANIMATION }
  }

  // Parse stored V2 strictly.
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const v2Attention = appearanceV2?.attention

  if (v2Attention) {
    // V2 attention present.
    // When the plan has 'advanced' entitlement AND a paidAnimation exists,
    // restore the paidAnimation. The active animation was forced by a prior
    // downgrade (Free couldn't use the advanced animation). On upgrade, the
    // user's original paid preference should be restored.
    if (
      entitlements.attentionAnimations === 'advanced' &&
      v2Attention.paidAnimation
    ) {
      return { animation: v2Attention.paidAnimation }
    }
    if (isAttentionAnimationAllowed(v2Attention.animation, entitlements)) {
      return { animation: v2Attention.animation }
    }
    // Active animation NOT entitled (e.g. Free after Pro downgrade).
    if (
      v2Attention.paidAnimation &&
      isAttentionAnimationAllowed(v2Attention.paidAnimation, entitlements)
    ) {
      return { animation: v2Attention.paidAnimation }
    }
    return { animation: DEFAULT_ATTENTION_ANIMATION }
  }

  // No V2 attention → legacy, never animate.
  return { animation: DEFAULT_ATTENTION_ANIMATION }
}

/**
 * Get the stored attention config from V2 (without entitlement enforcement).
 * Returns null if no V2 attention selection exists.
 */
export function getStoredAttention(stored: StoredAttentionInput): {
  animation: AttentionAnimation
  paidAnimation?: AttentionAnimation
} | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.attention ?? null
}
