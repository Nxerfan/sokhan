/**
 * Widget V2 Page Visibility PATCH validation + merge.
 *
 * Handles the isolated page-visibility update contract:
 *   - Free (basic): up to 3 rules, exact match only, no device field.
 *   - Paid (advanced): up to 10 rules, exact + prefix, device-specific.
 *   - Unknown: reject all.
 *   - paidRules: derived by merge (never client-supplied).
 *
 * Downgrade/upgrade preservation (same pattern as all prior features):
 *   - Free edit: set rules = patch.rules, preserve prior paidRules.
 *     If prior rules exceed Free scope, preserve them as paidRules.
 *   - Paid edit: set rules = patch.rules, clear paidRules.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2, type AppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'
import {
  isValidPagePattern,
  isMatchTypeAllowed,
  getMaxPageVisibilityRules,
  isAdvancedPageVisibilityPlan,
  type PageVisibilityRule,
} from './page-visibility-types'

export interface PageVisibilityPatchBody {
  pageVisibility?: unknown
}

export type PageVisibilityValidationResult =
  | { ok: true; data: PageVisibilityPatchData }
  | { ok: false; code: PageVisibilityErrorCode }

export type PageVisibilityErrorCode =
  | 'page_visibility_not_authorized'
  | 'page_visibility_not_object'
  | 'page_visibility_rules_missing'
  | 'page_visibility_rules_not_array'
  | 'page_visibility_rule_invalid'
  | 'page_visibility_not_allowed'
  | 'page_visibility_limit_exceeded'
  | 'page_visibility_duplicate_rule'
  | 'page_visibility_unexpected_key'
  | 'page_visibility_no_fields'

export interface PageVisibilityPatchData {
  rules: PageVisibilityRule[]
}

const ALLOWED_PATCH_KEYS = new Set(['rules'])
const ALLOWED_RULE_KEYS = new Set(['pattern', 'match', 'action', 'device'])

export function validatePageVisibilityPatch(
  body: PageVisibilityPatchBody,
  entitlements: Readonly<WidgetEntitlements> | null,
): PageVisibilityValidationResult {
  if (!entitlements) {
    return { ok: false, code: 'page_visibility_not_authorized' }
  }

  if (body.pageVisibility === undefined || body.pageVisibility === null) {
    return { ok: false, code: 'page_visibility_no_fields' }
  }

  const pageVisibility = body.pageVisibility
  if (typeof pageVisibility !== 'object' || pageVisibility === null || Array.isArray(pageVisibility)) {
    return { ok: false, code: 'page_visibility_not_object' }
  }

  const keys = Object.keys(pageVisibility as Record<string, unknown>)
  for (const key of keys) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      return { ok: false, code: 'page_visibility_unexpected_key' }
    }
  }

  const obj = pageVisibility as Record<string, unknown>

  if (obj.rules === undefined || obj.rules === null) {
    return { ok: false, code: 'page_visibility_rules_missing' }
  }
  if (!Array.isArray(obj.rules)) {
    return { ok: false, code: 'page_visibility_rules_not_array' }
  }

  const capability = entitlements.pageVisibility
  if (capability === 'none') {
    return { ok: false, code: 'page_visibility_not_authorized' }
  }

  const seenRules = new Set<string>()
  const validatedRules: PageVisibilityRule[] = []

  for (const raw of obj.rules) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, code: 'page_visibility_rule_invalid' }
    }
    const ruleObj = raw as Record<string, unknown>

    // Check for unexpected keys.
    for (const key of Object.keys(ruleObj)) {
      if (!ALLOWED_RULE_KEYS.has(key)) {
        return { ok: false, code: 'page_visibility_rule_invalid' }
      }
    }

    // pattern — required, must be a valid pathname.
    if (!isValidPagePattern(ruleObj.pattern)) {
      return { ok: false, code: 'page_visibility_rule_invalid' }
    }

    // match — required, must be 'exact' or 'prefix'.
    if (ruleObj.match !== 'exact' && ruleObj.match !== 'prefix') {
      return { ok: false, code: 'page_visibility_rule_invalid' }
    }

    // action — required, must be 'show' or 'hide'.
    if (ruleObj.action !== 'show' && ruleObj.action !== 'hide') {
      return { ok: false, code: 'page_visibility_rule_invalid' }
    }

    // Plan entitlement check for match type.
    if (!isMatchTypeAllowed(ruleObj.match, capability as 'basic' | 'advanced')) {
      return { ok: false, code: 'page_visibility_not_allowed' }
    }

    // device — optional for advanced, NOT allowed for basic.
    if (ruleObj.device !== undefined && ruleObj.device !== null) {
      if (capability !== 'advanced') {
        return { ok: false, code: 'page_visibility_not_allowed' }
      }
      if (ruleObj.device !== 'desktop' && ruleObj.device !== 'mobile') {
        return { ok: false, code: 'page_visibility_rule_invalid' }
      }
    }

    // Duplicate rule check (pattern + match + action + device).
    const deviceKey = ruleObj.device ?? 'any'
    const ruleKey = `${ruleObj.pattern}|${ruleObj.match}|${ruleObj.action}|${deviceKey}`
    if (seenRules.has(ruleKey)) {
      return { ok: false, code: 'page_visibility_duplicate_rule' }
    }
    seenRules.add(ruleKey)

    validatedRules.push({
      pattern: ruleObj.pattern as string,
      match: ruleObj.match as 'exact' | 'prefix',
      action: ruleObj.action as 'show' | 'hide',
      ...(ruleObj.device ? { device: ruleObj.device as 'desktop' | 'mobile' } : {}),
    })
  }

  // Limit check.
  const maxRules = getMaxPageVisibilityRules(capability as 'basic' | 'advanced')
  if (validatedRules.length > maxRules) {
    return { ok: false, code: 'page_visibility_limit_exceeded' }
  }

  return { ok: true, data: { rules: validatedRules } }
}

export function mergePageVisibilityPatch(
  existingAppearanceV2: unknown,
  patch: PageVisibilityPatchData,
  entitlements: Readonly<WidgetEntitlements> | null,
): AppearanceV2 {
  const existing = parseAppearanceV2(existingAppearanceV2)
  const base: AppearanceV2 = existing ?? { version: 1, desktop: {}, mobile: {} }
  const existingPv = existing?.pageVisibility

  const pvConfig: NonNullable<AppearanceV2['pageVisibility']> = {
    rules: patch.rules,
  }

  if (entitlements && isAdvancedPageVisibilityPlan(entitlements.pageVisibility)) {
    // Paid (advanced): clear paidRules.
  } else {
    // Free (basic) or unknown: preserve paidRules.
    if (existingPv?.paidRules && existingPv.paidRules.length > 0) {
      pvConfig.paidRules = existingPv.paidRules
    }
    // If existing rules exceed Free scope, preserve as paidRules.
    if (!pvConfig.paidRules && existingPv?.rules) {
      const hasAdvancedOnly = existingPv.rules.some(
        r => r.match === 'prefix' || r.device !== undefined,
      )
      if (hasAdvancedOnly || existingPv.rules.length > 3) {
        pvConfig.paidRules = existingPv.rules
      }
    }
  }

  return {
    version: 1,
    desktop: { ...(base.desktop ?? {}) },
    mobile: { ...(base.mobile ?? {}) },
    pageVisibility: pvConfig,
    ...(base.colors ? { colors: base.colors } : {}),
    ...(base.launcher ? { launcher: base.launcher } : {}),
    ...(base.attention ? { attention: base.attention } : {}),
    ...(base.messagePreview ? { messagePreview: base.messagePreview } : {}),
    ...(base.quickReplies ? { quickReplies: base.quickReplies } : {}),
    ...(base.preChatForm ? { preChatForm: base.preChatForm } : {}),
    ...(base.alternativeContactButtons ? { alternativeContactButtons: base.alternativeContactButtons } : {}),
    ...(base.smartAvoidance ? { smartAvoidance: base.smartAvoidance } : {}),
    ...(base.contextChat ? { contextChat: base.contextChat } : {}),
  }
}

export function hasPageVisibilityField(body: Record<string, unknown>): boolean {
  return body.pageVisibility !== undefined
}
