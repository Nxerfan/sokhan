/**
 * Widget V2 Attention PATCH validation + merge.
 *
 * Handles the isolated attention update contract:
 *   - Free (attentionAnimations='basic'): only 'none' and 'pulse' allowed.
 *   - Paid (attentionAnimations='advanced'): all five animations allowed.
 *   - True-patch: editing attention does NOT reset positioning, colors, or
 *     launcher.
 *   - Preserves advanced-only animations when Free edits a basic animation
 *     (downgrade preservation): the stored paid animation remains in the
 *     V2 attention's `paidAnimation` field for upgrade restore.
 *
 * Pure TS — no Prisma, no Next.js. Used by the API route handler.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  ATTENTION_ANIMATIONS,
  isAdvancedOnlyAttentionAnimation,
  type AttentionAnimation,
} from './attention-types'
import { isAttentionAnimationAllowed } from './effective-attention'

/** The attention patch payload shape (from the dashboard PATCH body). */
export interface AttentionPatchBody {
  attention?: unknown
}

/** Result of validating an attention patch. */
export type AttentionValidationResult =
  | { ok: true; data: AttentionPatchData }
  | { ok: false; code: AttentionErrorCode }

/** Error codes for attention PATCH validation. */
export type AttentionErrorCode =
  | 'attention_not_authorized'
  | 'attention_not_object'
  | 'attention_animation_missing'
  | 'attention_animation_invalid'
  | 'attention_animation_not_allowed'
  | 'attention_unexpected_key'
  | 'attention_no_fields'

/** A validated attention patch. */
export interface AttentionPatchData {
  animation: AttentionAnimation
}

/** Allowed keys in the attention patch body. `paidAnimation` is NEVER
 *  caller-supplied — it is derived by the merge from the prior stored
 *  advanced selection during a downgrade. */
const ALLOWED_ATTENTION_KEYS = new Set(['animation'])

/**
 * Validate an attention patch body against the plan entitlements.
 *
 * The `body.attention` field is expected to be:
 *   { animation: 'none' | 'pulse' | 'bounce' | 'shake' | 'glow' }
 *
 * Free plan: only 'none' and 'pulse' accepted. Advanced-only motions
 * (bounce/shake/glow) → `attention_animation_not_allowed`.
 *
 * Paid plans: all five animations accepted.
 *
 * Unknown plans: every request rejected (fail closed).
 *
 * Returns the validated patch data or an error code. Never throws.
 */
export function validateAttentionPatch(
  body: AttentionPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): AttentionValidationResult {
  // FAIL CLOSED: unknown plans or plans without attention entitlement.
  if (!entitlements) {
    return { ok: false, code: 'attention_not_authorized' }
  }

  if (body.attention === undefined || body.attention === null) {
    return { ok: false, code: 'attention_no_fields' }
  }

  const attention = body.attention

  if (typeof attention !== 'object' || attention === null) {
    return { ok: false, code: 'attention_not_object' }
  }
  if (Array.isArray(attention)) {
    return { ok: false, code: 'attention_not_object' }
  }

  // Check for unexpected keys. `paidAnimation` is NEVER accepted from the
  // caller — it can only be derived by the merge during a downgrade.
  const keys = Object.keys(attention as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_ATTENTION_KEYS.has(key)) {
      return { ok: false, code: 'attention_unexpected_key' }
    }
  }

  const obj = attention as Record<string, unknown>

  // animation — required, must be a valid attention animation.
  if (obj.animation === undefined || obj.animation === null) {
    return { ok: false, code: 'attention_animation_missing' }
  }
  if (
    typeof obj.animation !== 'string' ||
    !(ATTENTION_ANIMATIONS as readonly string[]).includes(obj.animation)
  ) {
    return { ok: false, code: 'attention_animation_invalid' }
  }

  const animation = obj.animation as AttentionAnimation

  // Entitlement check: Free can't use advanced-only motions.
  if (!isAttentionAnimationAllowed(animation, entitlements)) {
    return { ok: false, code: 'attention_animation_not_allowed' }
  }

  return { ok: true, data: { animation } }
}

/**
 * Merge a validated attention patch into the existing stored appearanceV2.
 *
 * True-patch semantics:
 *   - Editing attention does NOT reset positioning (desktop/mobile preserved).
 *   - Editing attention does NOT reset colors.
 *   - Editing attention does NOT reset launcher.
 *   - Advanced-only animations preserved when Free edits a basic animation
 *     (downgrade preservation): the stored paid animation remains in the
 *     V2 attention's `paidAnimation` field for upgrade restore.
 *
 * Explicit Pro selection (attentionAnimations='advanced'):
 *   - The user's explicit choice replaces any prior paid preference —
 *     including when the new animation equals the stored (Free-forced)
 *     animation. `paidAnimation` is cleared so a stale preserved
 *     preference can never override an explicit authorized choice.
 *
 * Returns the new appearanceV2 object (always valid, always canonical).
 */
export function mergeAttentionPatch(
  existingAppearanceV2: unknown,
  patch: AttentionPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)

  const base: AppearanceV2 = existing ?? {
    version: 1,
    desktop: {},
    mobile: {},
  }

  // Determine the stored paid animation for preservation.
  const existingAttention = existing?.attention
  const newAnimation = patch.animation

  // Build the new attention config from the patch + entitlement context.
  //
  // NOTE: we intentionally do NOT short-circuit when
  // existingAttention?.animation === newAnimation. An explicit authorized
  // advanced (Pro) selection must replace the previous paid preference
  // even when the new animation happens to match the stored (Free-forced)
  // animation. This is the same contract fixed for LauncherConfig.paidShape
  // in PR #18 — a stale paidAnimation must never survive an explicit
  // authorized selection.
  //
  // Reproduction this guards:
  //   1. Pro saves glow         -> { animation: 'glow' }
  //   2. Downgrade to Free
  //   3. Free saves pulse       -> { animation: 'pulse', paidAnimation: 'glow' }
  //   4. Upgrade to Pro         -> resolver restores glow (via paidAnimation)
  //   5. User explicitly selects pulse and saves
  //      newAnimation ('pulse') === existingAttention.animation ('pulse')
  //      -> a short-circuit here would retain paidAnimation='glow'
  //      -> resolver would STILL return glow (stale paid preference)
  //   6. Correct behavior: clear paidAnimation so the resolver returns the
  //      user's explicit 'pulse'.
  //
  // The Free (basic) branch below still preserves paidAnimation for both
  // real edits and idempotent Free saves, so removing the short-circuit
  // does not regress downgrade/upgrade restoration.
  const attentionConfig: NonNullable<AppearanceV2['attention']> = {
    animation: newAnimation,
  }

  // When the plan has 'advanced' entitlement (Pro/Max/Self-hosted), the
  // user is explicitly choosing an animation on a paid plan. Clear
  // paidAnimation — the user's explicit choice replaces any prior paid
  // preference, including when newAnimation matches the stored animation.
  if (entitlements?.attentionAnimations === 'advanced') {
    // No paidAnimation — explicit advanced choice replaces prior preference.
  } else {
    // Plan is 'basic' (Free). Preserve advanced-only animation for restore.
    // Only advanced-only animations (bounce/shake/glow) are valid as
    // paidAnimation — 'none' and 'pulse' are basic and contradictory.
    if (existingAttention?.animation && existingAttention.animation !== newAnimation) {
      const existingAnimation = existingAttention.animation as AttentionAnimation
      if (isAdvancedOnlyAttentionAnimation(existingAnimation)) {
        attentionConfig.paidAnimation = existingAnimation
      }
    }
    // Also preserve any existing paidAnimation from the existing config.
    // This covers idempotent Free saves (newAnimation === existingAttention.animation)
    // and Free edits between two basic animations: the stored paid
    // preference is carried forward unchanged for future upgrade restore.
    if (existingAttention?.paidAnimation && !attentionConfig.paidAnimation) {
      attentionConfig.paidAnimation = existingAttention.paidAnimation
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    attention: attentionConfig,
    // Preserve colors + launcher + any other existing V2 fields.
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
  }
}

/**
 * Check if the PATCH body contains an `attention` field.
 */
export function hasAttentionField(body: Record<string, unknown>): boolean {
  return body.attention !== undefined
}
