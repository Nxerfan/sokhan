import 'server-only'
import { db, getCurrentTenantId } from '@/lib/db'

/**
 * Widget Visitor Access Modes / Identity — server-side policy enforcement.
 *
 * (feat/widget-visitor-access-modes)
 *
 * THREE access modes (stored on WidgetConfig.accessMode):
 *   - anonymous        — anyone can chat (the historical behavior; EXISTING
 *                        workspaces migrate to this).
 *   - verified_visitor  — visitor must verify an email via OTP before sending.
 *                        NEW workspaces default to this.
 *   - site_user_only   — only website users proven by the CUSTOMER's server
 *                        (via the server-to-server identity mint endpoint) may
 *                        chat.
 *
 * THREE canonical identity levels (carried in tokens / resume credentials):
 *   - anonymous         — an unverified visitorId-only Contact.
 *   - verified_contact  — a Contact whose email was OTP-verified (verified_visitor).
 *   - external_user     — a Contact backed by a customer-provided externalUserId
 *                         proven server-to-server (site_user_only).
 *
 * The access mode determines which identity level is SUFFICIENT to send messages.
 * Enforcement is SERVER-SIDE ONLY (REST contact/messages + realtime token/room
 * join/reconnect/polling). Frontend locking is UX only.
 *
 * policyVersion: incremented atomically on every access-mode / integration-secret
 * change. A presented credential with a STALE policyVersion (< current) is
 * rejected so stricter policy transitions take effect IMMEDIATELY (not just on
 * token expiry). This blocks legacy widget clients from bypassing a newer
 * stricter policy.
 */

export const ACCESS_MODES = ['anonymous', 'verified_visitor', 'site_user_only'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

export const IDENTITY_LEVELS = ['anonymous', 'verified_contact', 'external_user'] as const
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number]

/** The canonical default for NEW workspaces (set explicitly at signup). */
export const DEFAULT_ACCESS_MODE_NEW: AccessMode = 'verified_visitor'
/** The canonical default for EXISTING workspaces (migration backfill). */
export const DEFAULT_ACCESS_MODE_EXISTING: AccessMode = 'anonymous'

/**
 * Whether a given identity level is SUFFICIENT to send messages under the
 * given access mode. This is the core authorization primitive — pure,
 * deterministic, fully unit-testable.
 *
 *   anonymous mode       → anonymous / verified_contact / external_user all OK
 *   verified_visitor mode → verified_contact OR external_user OK; anonymous NOT OK
 *   site_user_only mode   → external_user OK; anonymous + verified_contact NOT OK
 *
 * (A stronger identity is always acceptable under a weaker mode; a weaker
 * identity is never acceptable under a stricter mode.)
 */
export function isIdentitySufficient(accessMode: AccessMode, identityLevel: IdentityLevel): boolean {
  switch (accessMode) {
    case 'anonymous':
      // Anyone may chat — all identity levels are sufficient.
      return true
    case 'verified_visitor':
      // Must be a verified contact OR an external (website) user.
      return identityLevel === 'verified_contact' || identityLevel === 'external_user'
    case 'site_user_only':
      // Must be an external (website) user proven by the customer's server.
      return identityLevel === 'external_user'
  }
}

/** Whether the access mode requires identity verification before sending. */
export function requiresVerification(accessMode: AccessMode): boolean {
  return accessMode !== 'anonymous'
}

/** Coerce an arbitrary string into an AccessMode (defensive — defaults to anonymous). */
export function parseAccessMode(value: unknown): AccessMode | null {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
    ? (value as AccessMode)
    : null
}

export function coerceAccessMode(value: unknown): AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
    ? (value as AccessMode)
    : 'anonymous'
}

/** Coerce an arbitrary string into an IdentityLevel (defensive — defaults to anonymous). */
export function coerceIdentityLevel(value: unknown): IdentityLevel {
  return typeof value === 'string' && (IDENTITY_LEVELS as readonly string[]).includes(value)
    ? (value as IdentityLevel)
    : 'anonymous'
}

/**
 * policyVersion check. A presented credential's policyVersion MUST equal the
 * tenant's CURRENT policyVersion. A stale (older) policyVersion means the
 * credential was minted before a stricter policy transition → rejected so the
 * stricter policy takes effect immediately. (A future/newer policyVersion
 * from the same tenant should not occur in normal flow; it is also rejected.)
 */
export function isPolicyVersionCurrent(
  presentedPolicyVersion: number | undefined | null,
  currentPolicyVersion: number,
): boolean {
  if (presentedPolicyVersion === undefined || presentedPolicyVersion === null) return false
  if (typeof presentedPolicyVersion !== 'number' || !Number.isFinite(presentedPolicyVersion)) return false
  return presentedPolicyVersion === currentPolicyVersion
}

/**
 * The authorization decision returned to REST/realtime enforcement points.
 * `allowed=false` carries a truthful, distinguishable `reason` for the UX
 * (no sensitive implementation details).
 */
export type AuthorizationDecision =
  | { allowed: true; accessMode: AccessMode; identityLevel: IdentityLevel }
  | { allowed: false; reason: AuthorizationDenyReason; accessMode: AccessMode }

export type AuthorizationDenyReason =
  | 'verification_required' // verified_visitor: visitor has not completed email OTP verification
  | 'website_login_required' // site_user_only: no external identity / customer says not authenticated
  | 'identity_token_invalid' // site_user_only: the Sukhan identity token is malformed/tampered
  | 'identity_token_expired' // site_user_only: the Sukhan identity token has expired
  | 'policy_changed' // the presented policyVersion is stale (stricter policy now in effect)
  | 'integration_unavailable' // site_user_only: no integration secret configured / mint endpoint unreachable

/**
 * Evaluate the authorization for a presented identity against the tenant's
 * CURRENT access policy. Pure (no I/O) given the current accessMode +
 * policyVersion + the presented identityLevel + presentedPolicyVersion.
 *
 * Callers that have already loaded the tenant's WidgetConfig should use this
 * pure form. Callers that need to load the policy from the DB use
 * `authorizeSendWithTenant` below.
 */
export function evaluateSendAuthorization(args: {
  accessMode: AccessMode
  currentPolicyVersion: number
  identityLevel: IdentityLevel
  presentedPolicyVersion?: number | null
}): AuthorizationDecision {
  const { accessMode, currentPolicyVersion, identityLevel, presentedPolicyVersion } = args
  // policyVersion is checked FIRST: a stale credential is rejected even if the
  // identity would otherwise be sufficient — so a stricter policy transition
  // immediately invalidates older weaker credentials.
  if (requiresVerification(accessMode) && !isPolicyVersionCurrent(presentedPolicyVersion, currentPolicyVersion)) {
    return { allowed: false, reason: 'policy_changed', accessMode }
  }
  if (isIdentitySufficient(accessMode, identityLevel)) {
    return { allowed: true, accessMode, identityLevel }
  }
  // Insufficient identity — return the mode-specific truthful reason.
  const reason: AuthorizationDenyReason =
    accessMode === 'verified_visitor'
      ? 'verification_required'
      : accessMode === 'site_user_only'
        ? 'website_login_required'
        : 'verification_required' // defensive (anonymous always allows)
  return { allowed: false, reason, accessMode }
}

/**
 * Load the CURRENT access policy for the session tenant + evaluate a presented
 * identity against it. Runs inside `withSessionTenant` (uses the fail-closed
 * `db` proxy + `getCurrentTenantId()`).
 *
 * Returns `{ allowed: false, reason: 'integration_unavailable' }` if the
 * tenant's WidgetConfig is missing (defensive — should not happen; every
 * tenant has a WidgetConfig row created at signup).
 */
export async function authorizeSendWithTenant(args: {
  identityLevel: IdentityLevel
  presentedPolicyVersion?: number | null
}): Promise<AuthorizationDecision> {
  const tid = getCurrentTenantId()
  if (!tid) {
    // No tenant context — the fail-closed proxy would have thrown already;
    // this is a defensive guard.
    return { allowed: false, reason: 'integration_unavailable', accessMode: 'anonymous' }
  }
  const config = await db.widgetConfig.findUnique({
    where: { tenantId: tid },
    select: { accessMode: true, policyVersion: true },
  })
  if (!config) {
    return { allowed: false, reason: 'integration_unavailable', accessMode: 'anonymous' }
  }
  const accessMode = coerceAccessMode(config.accessMode)
  return evaluateSendAuthorization({
    accessMode,
    currentPolicyVersion: config.policyVersion,
    identityLevel: args.identityLevel,
    presentedPolicyVersion: args.presentedPolicyVersion,
  })
}

/**
 * The SAFE public fields to expose in the public widget config for the
 * access/identity feature. NEVER include the integration secret (raw or hash),
 * private signing secrets, or server credentials.
 */
export function publicAccessConfig(config: {
  accessMode: string
  policyVersion: number
  loginUrl?: string | null
  loginButtonLabel?: string | null
  loginReturnUrlParam?: string | null
  identityEndpointPath?: string | null
}): {
  accessMode: AccessMode
  policyVersion: number
  loginUrl: string | null
  loginButtonLabel: string | null
  loginReturnUrlParam: string | null
  identityEndpointPath: string | null
} {
  return {
    accessMode: coerceAccessMode(config.accessMode),
    policyVersion: config.policyVersion,
    loginUrl: config.loginUrl ?? null,
    loginButtonLabel: config.loginButtonLabel ?? null,
    loginReturnUrlParam: config.loginReturnUrlParam ?? null,
    identityEndpointPath: config.identityEndpointPath ?? null,
  }
}
