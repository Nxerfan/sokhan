import 'server-only'
import { db, getCurrentTenantId } from '@/lib/db'

export const ACCESS_MODES = ['anonymous', 'verified_visitor', 'site_user_only'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]
export const IDENTITY_LEVELS = ['anonymous', 'verified_contact', 'external_user'] as const
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number]
export const DEFAULT_ACCESS_MODE_NEW: AccessMode = 'verified_visitor'
export const DEFAULT_ACCESS_MODE_EXISTING: AccessMode = 'anonymous'

export function parseAccessMode(value: unknown): AccessMode | null {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value) ? (value as AccessMode) : null
}
export function parseIdentityLevel(value: unknown): IdentityLevel | null {
  return typeof value === 'string' && (IDENTITY_LEVELS as readonly string[]).includes(value) ? (value as IdentityLevel) : null
}
export function parsePolicyVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null
  return value
}
export function coerceAccessMode(value: unknown): AccessMode { return parseAccessMode(value) ?? 'anonymous' }
export function coerceIdentityLevel(value: unknown): IdentityLevel { return parseIdentityLevel(value) ?? 'anonymous' }

// ─── Public access-field validation (shared by dashboard PATCH + publicAccessConfig) ───
// These PURE validators enforce the SAME contract for both dashboard writes
// (PATCH /api/widget-config/access) and public reads (GET /api/widget/<slug>/config).
// A persisted legacy value that fails validation fail-closes the public route
// (503 policy_unavailable) — it is NEVER silently coerced/passed to the browser.
export const ALLOWED_PATCH_KEYS = ['accessMode', 'loginUrl', 'loginButtonLabel', 'loginReturnUrlParam', 'identityEndpointPath'] as const
export const LOGIN_URL_MAX = 500
export const LOGIN_BUTTON_LABEL_MAX = 200
export const LOGIN_RETURN_URL_PARAM_MAX = 100
export const IDENTITY_ENDPOINT_PATH_MAX = 500
// ASCII control chars (0x00-0x1f + 0x7f) — covers tab/newline/etc. (Avoids the
// ES2018 \p{Cc} requirement at the ES2017 tsconfig target.)
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/** Validate a login URL — http(s) absolute OR same-origin relative; reject
 *  protocol-relative //, javascript:, data:, backslash confusion, control
 *  chars, oversized. null is handled by the caller. */
export function isValidLoginUrl(url: string): boolean {
  if (url.length > LOGIN_URL_MAX) return false
  if (CONTROL_CHAR_RE.test(url)) return false
  if (url.includes('\\')) return false // backslash confusion (browser may normalize to //)
  if (url === '/') return true
  if (/^\/[^/]/.test(url)) return true // same-origin relative (not //)
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }
  return false // reject //, javascript:, data:, malformed, etc.
}

/** Validate a login button label — non-empty string <= LOGIN_BUTTON_LABEL_MAX.
 *  Rejects empty/whitespace-only non-null + oversized. Unicode allowed. */
export function isValidLoginButtonLabel(label: string): boolean {
  if (label.length > LOGIN_BUTTON_LABEL_MAX) return false
  if (label.trim().length === 0) return false // no empty/whitespace-only
  return true
}

/** Validate a login return-URL parameter NAME (not a URL). Conservative
 *  URL-query-key charset; reject URL-structure chars (& = ? #), whitespace,
 *  control chars, oversized. */
export function isValidReturnUrlParam(p: string): boolean {
  if (p.length > LOGIN_RETURN_URL_PARAM_MAX) return false
  if (CONTROL_CHAR_RE.test(p)) return false
  return /^[a-zA-Z0-9_.-]+$/.test(p) // letters, digits, _, -, .
}

/** Validate the identity endpoint path — same-origin relative path only; reject
 *  absolute URLs, protocol-relative //, backslash confusion, query/hash, control
 *  chars, oversized. null is handled by the caller. */
export function isValidIdentityEndpointPath(path: string): boolean {
  if (path.length > IDENTITY_ENDPOINT_PATH_MAX) return false
  if (CONTROL_CHAR_RE.test(path)) return false
  if (path.includes('\\')) return false
  if (path.includes('?') || path.includes('#')) return false // no query/hash
  if (path === '/') return true
  return /^\/[^/]/.test(path) // same-origin relative (not //)
}

export function isIdentitySufficient(accessMode: AccessMode, identityLevel: IdentityLevel): boolean {
  if (accessMode === 'anonymous') return true
  if (accessMode === 'verified_visitor') return identityLevel === 'verified_contact' || identityLevel === 'external_user'
  return identityLevel === 'external_user'
}
export function requiresVerification(accessMode: AccessMode): boolean { return accessMode !== 'anonymous' }
export function isPolicyVersionCurrent(presented: number | undefined | null, current: number): boolean {
  const p = parsePolicyVersion(presented); return p !== null && p === current
}

export type AuthorizationDecision =
  | { allowed: true; accessMode: AccessMode; identityLevel: IdentityLevel }
  | { allowed: false; reason: AuthorizationDenyReason; accessMode: AccessMode | null }
export type AuthorizationDenyReason = 'verification_required' | 'website_login_required' | 'identity_token_invalid' | 'identity_token_expired' | 'policy_changed' | 'integration_unavailable' | 'policy_unavailable'

export function resolveLegacyTokenIdentity(args: { currentAccessMode: AccessMode; tokenIdentityLevel: unknown; tokenPolicyVersion: unknown }): IdentityLevel | null {
  const level = parseIdentityLevel(args.tokenIdentityLevel)
  const pv = parsePolicyVersion(args.tokenPolicyVersion)
  if (level !== null && pv !== null) return level
  if (args.currentAccessMode === 'anonymous') return 'anonymous'
  return null
}

export function evaluateSendAuthorization(args: { accessMode: unknown; currentPolicyVersion: unknown; identityLevel: unknown; presentedPolicyVersion?: number | null }): AuthorizationDecision {
  const accessMode = parseAccessMode(args.accessMode)
  if (accessMode === null) return { allowed: false, reason: 'policy_unavailable', accessMode: null }
  const currentPolicyVersion = parsePolicyVersion(args.currentPolicyVersion)
  if (currentPolicyVersion === null) return { allowed: false, reason: 'policy_unavailable', accessMode }
  const identityLevel = parseIdentityLevel(args.identityLevel)
  if (identityLevel === null) return { allowed: false, reason: 'policy_unavailable', accessMode }
  if (requiresVerification(accessMode) && !isPolicyVersionCurrent(args.presentedPolicyVersion, currentPolicyVersion)) return { allowed: false, reason: 'policy_changed', accessMode }
  if (isIdentitySufficient(accessMode, identityLevel)) return { allowed: true, accessMode, identityLevel }
  const reason: AuthorizationDenyReason = accessMode === 'verified_visitor' ? 'verification_required' : accessMode === 'site_user_only' ? 'website_login_required' : 'verification_required'
  return { allowed: false, reason, accessMode }
}

export async function authorizeSendWithTenant(args: { identityLevel: unknown; presentedPolicyVersion?: number | null }): Promise<AuthorizationDecision> {
  const tid = getCurrentTenantId()
  if (!tid) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  const config = await db.widgetConfig.findUnique({ where: { tenantId: tid }, select: { accessMode: true, policyVersion: true } })
  if (!config) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  return evaluateSendAuthorization({ accessMode: config.accessMode, currentPolicyVersion: config.policyVersion, identityLevel: args.identityLevel, presentedPolicyVersion: args.presentedPolicyVersion })
}

export function publicAccessConfig(config: { accessMode: string; policyVersion: number; loginUrl?: string | null; loginButtonLabel?: string | null; loginReturnUrlParam?: string | null; identityEndpointPath?: string | null }): { accessMode: AccessMode; policyVersion: number; loginUrl: string | null; loginButtonLabel: string | null; loginReturnUrlParam: string | null; identityEndpointPath: string | null } | null {
  const accessMode = parseAccessMode(config.accessMode)
  if (accessMode === null) return null
  const policyVersion = parsePolicyVersion(config.policyVersion)
  if (policyVersion === null) return null
  // Validate the persisted public login fields against the SAME contract as
  // dashboard PATCH. A legacy unsafe value fail-closes (returns null -> the
  // public route returns 503 policy_unavailable). NEVER silently passed to the
  // browser, NEVER coerced.
  const loginUrl = config.loginUrl ?? null
  if (loginUrl !== null && !isValidLoginUrl(loginUrl)) return null
  const loginButtonLabel = config.loginButtonLabel ?? null
  if (loginButtonLabel !== null && !isValidLoginButtonLabel(loginButtonLabel)) return null
  const loginReturnUrlParam = config.loginReturnUrlParam ?? null
  if (loginReturnUrlParam !== null && !isValidReturnUrlParam(loginReturnUrlParam)) return null
  const identityEndpointPath = config.identityEndpointPath ?? null
  if (identityEndpointPath !== null && !isValidIdentityEndpointPath(identityEndpointPath)) return null
  return { accessMode, policyVersion, loginUrl, loginButtonLabel, loginReturnUrlParam, identityEndpointPath }
}
