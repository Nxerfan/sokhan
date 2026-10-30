/**
 * Widget customization entitlements — the capability-based plan model.
 *
 * Replaces the coarse `Plan.customization: boolean` with a typed,
 * server-authoritative per-capability entitlement definition. This is the
 * CANONICAL source of truth for what each plan ALLOWS — the dashboard, the
 * PATCH validation, + the effective-config resolver all consult this model.
 *
 * IMPORTANT: a capability being permitted by a plan does NOT mean it has
 * already been IMPLEMENTED. Phase 1 establishes the entitlement foundation;
 * later phases implement the actual features. The entitlement model must
 * remain truthful (never advertise/activate unimplemented features).
 *
 * Fail-closed: unknown/invalid plans return null. No reliance on
 * client-supplied plan info. No inference from numeric price or isPaidPlan().
 */

import type { PlanSlug } from './plans'

/**
 * The per-capability entitlement definition for a plan.
 * Numbers represent maximums (0 = disabled). Strings represent tiers.
 */
export interface WidgetEntitlements {
  /** @readonly — use Object.freeze for runtime immutability */
  /** Position: 3 predefined positions (Free) vs unrestricted (paid). */
  presetPositioning: boolean
  /** Precise X/Y pixel positioning + drag + slider. */
  precisePositioning: boolean
  /** Color: 10 predefined palettes (Free) vs presets + custom tokens (paid). */
  presetColors: boolean
  /** Arbitrary/custom colors + independently configurable visual tokens. */
  customColors: boolean
  /** Launcher style selection: 'limited' (Free) vs 'all' (paid). */
  launcherSelection: 'limited' | 'all'
  /** Message Preview feature. */
  messagePreview: boolean
  /** Attention animations: 'basic' (one subtle default) vs 'advanced' (4 motions). */
  attentionAnimations: 'basic' | 'advanced'
  /** Max quick-reply buttons (0 = disabled). Free: 2, paid: 10. */
  quickReplies: number
  /** Pre-chat form: 'none' | 'basic' (≤2 fields) | 'advanced'. */
  preChatForm: 'none' | 'basic' | 'advanced'
  /** Page-specific visibility rules: 'none' | 'basic' (≤3) | 'advanced'. */
  pageVisibility: 'none' | 'basic' | 'advanced'
  /** Max alternative-contact buttons (0 = disabled). Free: 2, paid: 5. */
  alternativeContactButtons: number
  /** Smart Avoidance (BETA, advanced plans only). */
  smartAvoidance: boolean
  /** Context Chat (BETA, advanced plans only). */
  contextChat: boolean
  /** Playground: available to all plans, respecting each plan's capabilities. */
  playground: boolean
  /** Branding removal: subject to existing branding entitlement. */
  brandingRemoval: boolean
  /**
   * Legacy `customization: boolean` compatibility — true when the plan has
   * unrestricted customization (the old model). Phase 1 preserves this for
   * backward-compat with `getEffectiveWidgetConfig` + the PATCH gate.
   */
  legacyCustomizationUnlocked: boolean
}

/** Free plan entitlements — limited customization (V2 contract). */
const FREE_ENTITLEMENTS: WidgetEntitlements = {
  presetPositioning: true,
  precisePositioning: false,
  presetColors: true,
  customColors: false,
  launcherSelection: 'limited',
  messagePreview: false,
  attentionAnimations: 'basic',
  quickReplies: 2,
  preChatForm: 'basic',
  pageVisibility: 'basic',
  alternativeContactButtons: 2,
  smartAvoidance: false,
  contextChat: false,
  playground: true,
  brandingRemoval: false,
  // Phase 1 backward-compat: Free is still fully locked (legacy behavior
  // preserved until later phases implement the actual Free customization
  // features). The entitlement MODEL is defined, but the gating is NOT
  // changed yet.
  legacyCustomizationUnlocked: false,
}

/** Pro plan entitlements — full customization. */
const PRO_ENTITLEMENTS: Readonly<WidgetEntitlements> = Object.freeze<WidgetEntitlements>({
  presetPositioning: true,
  precisePositioning: true,
  presetColors: true,
  customColors: true,
  launcherSelection: 'all',
  messagePreview: true,
  attentionAnimations: 'advanced',
  quickReplies: 10,
  preChatForm: 'advanced',
  pageVisibility: 'advanced',
  alternativeContactButtons: 5,
  smartAvoidance: true,
  contextChat: true,
  playground: true,
  brandingRemoval: true,
  legacyCustomizationUnlocked: true,
})

/** Max plan entitlements — same as Pro (full customization). */
const MAX_ENTITLEMENTS: Readonly<WidgetEntitlements> = Object.freeze<WidgetEntitlements>({ ...PRO_ENTITLEMENTS })

/** Self-hosted plan entitlements — same as Pro/Max (full customization). */
const SELF_HOSTED_ENTITLEMENTS: Readonly<WidgetEntitlements> = Object.freeze<WidgetEntitlements>({ ...PRO_ENTITLEMENTS })

// Freeze the Free entitlements too (was a plain object).
// (FREE_ENTITLEMENTS is defined above as a plain object — freeze it here.)
Object.freeze(FREE_ENTITLEMENTS)

/**
 * The canonical entitlement catalog — a Map (prototype-free) so that
 * inherited Object properties (constructor, toString, __proto__, etc.)
 * can NEVER be confused with legitimate plan slugs. Every key is an
 * own property; unknown keys (including prototype names) return null.
 *
 * The values are frozen (Object.freeze) to prevent accidental mutation
 * across requests.
 */
const ENTITLEMENT_CATALOG: ReadonlyMap<string, Readonly<WidgetEntitlements>> = new Map([
  ['free', FREE_ENTITLEMENTS],
  ['pro', PRO_ENTITLEMENTS],
  ['max', MAX_ENTITLEMENTS],
  ['self-hosted', SELF_HOSTED_ENTITLEMENTS],
])

/**
 * Get the widget customization entitlements for a plan slug.
 *
 * Returns null for unknown/invalid plans (FAIL CLOSED). Uses a Map
 * (prototype-free) so inherited Object properties (constructor, toString,
 * __proto__, etc.) return null — not a non-null value that could be
 * mistaken for a legitimate entitlement set.
 *
 * The caller must treat null as "no customization allowed" — never default
 * to a permissive entitlement set.
 *
 * Server-authoritative: the plan slug comes from the Tenant row (server-side),
 * never from client-supplied info.
 */
export function getEntitlements(planSlug: string | null | undefined): Readonly<WidgetEntitlements> | null {
  if (!planSlug || typeof planSlug !== 'string') return null
  return ENTITLEMENT_CATALOG.get(planSlug) ?? null
}

/**
 * Whether a plan has the legacy "customization unlocked" boolean.
 * Phase 1 backward-compat: the existing PATCH gate + getEffectiveWidgetConfig
 * use this to preserve the current Free-locked / paid-unlocked behavior.
 */
export function isLegacyCustomizationUnlocked(planSlug: string | null | undefined): boolean {
  const e = getEntitlements(planSlug)
  return e?.legacyCustomizationUnlocked ?? false
}
