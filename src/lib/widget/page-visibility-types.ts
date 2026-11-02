/**
 * Page Visibility types + validation helpers.
 *
 * Feature 8 — Page Visibility.
 *
 * Plan limits:
 *   Free (pageVisibility: 'basic'): up to 3 rules, exact match only.
 *   Pro/Max/Self-hosted (pageVisibility: 'advanced'): up to 10 rules,
 *     exact + segment-aware prefix matching, independent desktop/mobile.
 *   Unknown: fail closed.
 *
 * Rule precedence: a matching 'hide' rule overrides a matching 'show' rule.
 * When no rules match, the widget is visible (default).
 */

/** Match type for a page visibility rule. */
export type PageRuleMatch = 'exact' | 'prefix'

/** Action when a rule matches. */
export type PageRuleAction = 'show' | 'hide'

/** A single page visibility rule. */
export interface PageVisibilityRule {
  pattern: string
  match: PageRuleMatch
  action: PageRuleAction
  device?: 'desktop' | 'mobile'
}

/** Max rules per plan. */
export const BASIC_PAGE_VISIBILITY_MAX_RULES = 3
export const ADVANCED_PAGE_VISIBILITY_MAX_RULES = 10

/** Max pattern length. */
export const PAGE_RULE_MAX_PATTERN_LENGTH = 500

/** Allowed match types. */
export const PAGE_RULE_MATCH_TYPES = ['exact', 'prefix'] as const

/** Allowed actions. */
export const PAGE_RULE_ACTIONS = ['show', 'hide'] as const

/**
 * Check if the plan's pageVisibility capability is 'advanced' (paid).
 */
export function isAdvancedPageVisibilityPlan(capability: string): boolean {
  return capability === 'advanced'
}

/**
 * Get the maximum number of rules for a plan capability.
 */
export function getMaxPageVisibilityRules(capability: 'basic' | 'advanced'): number {
  return capability === 'advanced' ? ADVANCED_PAGE_VISIBILITY_MAX_RULES : BASIC_PAGE_VISIBILITY_MAX_RULES
}

/**
 * Validate a page visibility rule pattern.
 * Rejects empty, whitespace-only, regex-like, or oversized patterns.
 * Patterns must be URL pathnames starting with '/'.
 */
export function isValidPagePattern(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > PAGE_RULE_MAX_PATTERN_LENGTH) return false
  // Must start with '/'.
  if (value[0] !== '/') return false
  // Reject wildcards (no '*' or '?' — patterns are literal pathnames).
  if (value.includes('*') || value.includes('?')) return false
  // Reject regex-like characters that could be interpreted as code.
  if (value.includes('\\') || value.includes('(') || value.includes(')')) return false
  // Reject newlines and control characters.
  if (/[\r\n\t\0]/.test(value)) return false
  return true
}

/**
 * Check if a match type is allowed for the plan.
 * Free (basic) can only use 'exact'. Paid (advanced) can use 'exact' and 'prefix'.
 */
export function isMatchTypeAllowed(match: string, capability: 'basic' | 'advanced'): boolean {
  if (capability === 'advanced') return match === 'exact' || match === 'prefix'
  return match === 'exact'
}

/**
 * Evaluate page visibility rules against a URL pathname and device.
 *
 * Returns 'show' or 'hide'. When no rules match, returns 'show' (default visible).
 * Rule precedence: a matching 'hide' rule overrides a matching 'show' rule.
 * Device-specific rules only apply to their device; rules without a device
 * apply to all devices.
 *
 * Pure function — never throws, never accesses the DOM.
 */
export function evaluatePageVisibility(
  rules: PageVisibilityRule[],
  pathname: string,
  device: 'desktop' | 'mobile',
): 'show' | 'hide' {
  if (!rules || rules.length === 0) return 'show'

  let hasMatchingShow = false
  let hasMatchingHide = false

  for (const rule of rules) {
    // Skip device-specific rules that don't match the current device.
    if (rule.device && rule.device !== device) continue

    const matches = rule.match === 'prefix'
      ? matchesPrefix(rule.pattern, pathname)
      : pathname === rule.pattern

    if (matches) {
      if (rule.action === 'hide') {
        hasMatchingHide = true
      } else {
        hasMatchingShow = true
      }
    }
  }

  // Hide overrides show.
  if (hasMatchingHide) return 'hide'
  if (hasMatchingShow) return 'show'
  return 'show'
}

/**
 * Segment-aware prefix matching.
 *
 * '/products' matches:
 *   '/products' (exact)
 *   '/products/' (trailing slash)
 *   '/products/electronics' (sub-path)
 *
 * '/products' does NOT match:
 *   '/products-detail' (partial segment)
 *
 * The pattern is treated as a path segment prefix — the next character
 * after the pattern in the pathname must be '/', end-of-string, or
 * the pattern must be the entire pathname.
 */
function matchesPrefix(pattern: string, pathname: string): boolean {
  if (pathname === pattern) return true
  if (pathname.startsWith(pattern + '/')) return true
  // Also match if pathname starts with pattern and pattern ends with '/'.
  if (pattern.endsWith('/') && pathname.startsWith(pattern)) return true
  return false
}
