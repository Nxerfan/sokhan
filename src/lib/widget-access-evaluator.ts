/**
 * Pure, zero-dependency widget access-policy evaluator.
 *
 * This module is the PURE core of the widget-visitor-access-modes feature.
 * It has NO runtime dependencies — no Next.js, no `server-only`, no Prisma,
 * no DB, no network. It can be imported from ANY runtime:
 *   - Next.js App Router (server route handlers)
 *   - Vercel realtime function (api/realtime.ts — standalone Node process)
 *   - Docker realtime mini-service (mini-services/realtime/index.ts — Bun)
 *   - Pure unit tests (bun:test)
 *
 * The DB-touching wrapper (`authorizeSendWithTenant`) lives in
 * `src/lib/widget-access-policy.ts`, which re-exports everything below for
 * backward-compat with existing app-side importers.
 *
 * SECURITY CONTRACT:
 *   - parseAccessMode / parsePolicyVersion / parseIdentityLevel are STRICT.
 *     They NEVER silently coerce a corrupt value to the historical default
 *     (anonymous / 1 / anonymous). A bad value returns null. Callers fail
 *     closed (503 policy_unavailable / 403 identity_token_invalid).
 *   - resolveLegacyTokenIdentity: legacy = BOTH identityLevel AND
 *     policyVersion genuinely absent (undefined). Accepted ONLY in anonymous
 *     mode. In verified_visitor / site_user_only → null. Partial claims
 *     (one present, one missing) OR malformed values → null. A correctly-
 *     signed modern token with malformed/partial claims must NOT silently
 *     degrade to anonymous.
 *   - evaluateSendAuthorization: frozen policy semantics. anonymous allows
 *     anon/verified_contact/external_user; verified_visitor allows
 *     verified_contact/external_user; site_user_only allows external_user
 *     only. policyVersion equality enforced for verified_visitor/
 *     site_user_only. Stale → policy_changed.
 *   - evaluateVisitorCurrentPolicyAccess: orchestrates the full CURRENT-policy
 *     visitor access decision. Pure — the caller loads the tenant's
 *     WidgetConfig + Contact identity class and passes them in. The function
 *     never touches the DB or network. Used by:
 *       - REST POST /api/widget/[slug]/messages (send authorization)
 *       - Vercel realtime io.use() middleware (visitor connect)
 *       - Vercel realtime conversation:join (revalidation after policy change)
 *       - Docker realtime io.use() (via the internal verifier endpoint)
 *       - Docker realtime conversation:join (via the internal verifier)
 */

// ─── Canonical modes + identity levels ──────────────────────────────────

export const ACCESS_MODES = ['anonymous', 'verified_visitor', 'site_user_only'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

export const IDENTITY_LEVELS = ['anonymous', 'verified_contact', 'external_user'] as const
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number]

/** Canonical default for NEW workspaces (set explicitly at signup). */
export const DEFAULT_ACCESS_MODE_NEW: AccessMode = 'verified_visitor'
/** Canonical default for EXISTING workspaces (migration backfill). */
export const DEFAULT_ACCESS_MODE_EXISTING: AccessMode = 'anonymous'

// ─── Strict parsers ─────────────────────────────────────────────────────

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

/** Tolerant coercion — display only. NEVER used for security decisions. */
export function coerceAccessMode(value: unknown): AccessMode { return parseAccessMode(value) ?? 'anonymous' }

/** Tolerant coercion — display only. NEVER used for security decisions. */
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
// ASCII control chars (0x00-0x1f + 0x7f) — covers tab/newline/etc. (Avoids
// the ES2018 \p{Cc} requirement at the ES2017 tsconfig target.)
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

// ─── Core authorization primitives ───────────────────────────────────────

/**
 * Whether a given identity level is SUFFICIENT to send messages under the
 * given access mode. Pure, deterministic.
 *
 *   anonymous mode       → anonymous / verified_contact / external_user all OK
 *   verified_visitor mode → verified_contact OR external_user OK; anonymous NOT OK
 *   site_user_only mode   → external_user OK; anonymous + verified_contact NOT OK
 *
 * (A stronger identity is always acceptable under a weaker mode; a weaker
 * identity is never acceptable under a stricter mode.)
 */
export function isIdentitySufficient(accessMode: AccessMode, identityLevel: IdentityLevel): boolean {
  if (accessMode === 'anonymous') return true
  if (accessMode === 'verified_visitor') return identityLevel === 'verified_contact' || identityLevel === 'external_user'
  return identityLevel === 'external_user'
}

export function requiresVerification(accessMode: AccessMode): boolean { return accessMode !== 'anonymous' }

export function isPolicyVersionCurrent(presented: number | undefined | null, current: number): boolean {
  const p = parsePolicyVersion(presented); return p !== null && p === current
}

// ─── Send authorization (pure) ───────────────────────────────────────────

export type AuthorizationDecision =
  | { allowed: true; accessMode: AccessMode; identityLevel: IdentityLevel }
  | { allowed: false; reason: AuthorizationDenyReason; accessMode: AccessMode | null }
export type AuthorizationDenyReason = 'verification_required' | 'website_login_required' | 'identity_token_invalid' | 'identity_token_expired' | 'policy_changed' | 'integration_unavailable' | 'policy_unavailable'

/**
 * Resolve a token's identity level against the CURRENT access mode.
 *
 * Legacy = BOTH identityLevel AND policyVersion genuinely absent (undefined).
 * Accepted ONLY in anonymous mode (-> 'anonymous'). In verified_visitor /
 * site_user_only → null (reject). Partial claims (one present, one missing)
 * OR malformed values → null. A correctly-signed modern token with malformed/
 * partial policy claims must NOT silently degrade to anonymous.
 */
export function resolveLegacyTokenIdentity(args: { currentAccessMode: AccessMode; tokenIdentityLevel: unknown; tokenPolicyVersion: unknown }): IdentityLevel | null {
  const level = parseIdentityLevel(args.tokenIdentityLevel)
  const pv = parsePolicyVersion(args.tokenPolicyVersion)
  // Both claims present + valid -> use the strict identity level.
  if (level !== null && pv !== null) return level
  // Both claims genuinely ABSENT (undefined) -> legacy token. Accepted ONLY
  // in anonymous mode. In verified_visitor/site_user_only, reject.
  if (args.tokenIdentityLevel === undefined && args.tokenPolicyVersion === undefined) {
    if (args.currentAccessMode === 'anonymous') return 'anonymous'
    return null
  }
  // Partial claims (one present, one missing) OR malformed values -> reject.
  return null
}

/**
 * Evaluate CURRENT-policy send authorization (the FROZEN policy semantics).
 *
 * Order:
 *   1. parse accessMode → null → policy_unavailable.
 *   2. parse currentPolicyVersion → null → policy_unavailable.
 *   3. parse identityLevel → null → policy_unavailable.
 *   4. if mode requires verification: presentedPolicyVersion must equal current
 *      (stale → policy_changed so stricter policy transitions take effect
 *      IMMEDIATELY).
 *   5. isIdentitySufficient decides allow / mode-specific deny.
 */
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

// ─── publicAccessConfig (pure) ───────────────────────────────────────────

export function publicAccessConfig(config: { accessMode: string; policyVersion: number; loginUrl?: string | null; loginButtonLabel?: string | null; loginReturnUrlParam?: string | null; identityEndpointPath?: string | null }): { accessMode: AccessMode; policyVersion: number; loginUrl: string | null; loginButtonLabel: string | null; loginReturnUrlParam: string | null; identityEndpointPath: string | null } | null {
  const accessMode = parseAccessMode(config.accessMode)
  if (accessMode === null) return null
  const policyVersion = parsePolicyVersion(config.policyVersion)
  if (policyVersion === null) return null
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

// ─── Visitor CURRENT-policy access evaluator (the SHARED primitive) ──────

/**
 * The persisted identity class of a Contact, as loaded from the DB. The
 * caller is responsible for loading + passing this in (the evaluator has
 * no DB access). `identifierType` is 'visitorId' or 'externalUser';
 * `externalUserId` is the customer-provided external id (null for visitorId
 * contacts); `emailVerifiedAt` is the OTP-verification timestamp (null if
 * the contact's email has not been OTP-verified).
 */
export interface ContactIdentityClass {
  identifierType: string
  externalUserId: string | null
  emailVerifiedAt: Date | null
}

/**
 * The decision returned by `evaluateVisitorCurrentPolicyAccess`. On allow,
 * carries the resolved identity level. On deny, carries a stable reason
 * that the caller maps to a stable error code:
 *   - policy_unavailable      → 503 (no WidgetConfig / corrupt accessMode / corrupt policyVersion)
 *   - identity_token_invalid  → 403 (partial/malformed token claims OR Contact identity-class mismatch)
 *   - policy_changed          → 403 (stale policyVersion)
 *   - verification_required   → 403 (verified_visitor + insufficient identity)
 *   - website_login_required  → 403 (site_user_only + insufficient identity)
 *
 * The reasons are TRUTHFUL + DISTINGUISHABLE — never reveal sensitive
 * details (no Contact email/name, no raw errors, no DB stack traces).
 */
export type VisitorAccessDecision =
  | { allowed: true; identityLevel: IdentityLevel }
  | { allowed: false; reason: 'policy_unavailable' | 'identity_token_invalid' | 'policy_changed' | 'verification_required' | 'website_login_required' }

/**
 * Evaluate CURRENT-policy visitor access — pure.
 *
 * Inputs (caller loads from DB before calling):
 *   - currentAccessMode: the tenant's CURRENT WidgetConfig.accessMode (raw).
 *   - currentPolicyVersion: the tenant's CURRENT WidgetConfig.policyVersion (raw).
 *   - tokenIdentityLevel: the visitor token's `identityLevel` claim (may be
 *     undefined for legacy tokens).
 *   - tokenPolicyVersion: the visitor token's `policyVersion` claim (may be
 *     undefined for legacy tokens).
 *   - contactIdentityClass: the persisted Contact's identity class — used to
 *     revalidate the token's identity claim against the actual DB row.
 *
 * Logic (matches the REST send route's already-green semantics):
 *   1. parseAccessMode(currentAccessMode) → null → policy_unavailable.
 *   2. parsePolicyVersion(currentPolicyVersion) → null → policy_unavailable.
 *   3. isLegacy = (tokenIdentityLevel === undefined && tokenPolicyVersion === undefined).
 *   4. resolvedIdentity = resolveLegacyTokenIdentity({...}).
 *   5. If resolvedIdentity === null:
 *        - isLegacy → mode-specific deny (verified_visitor → verification_required,
 *          site_user_only → website_login_required).
 *        - else → identity_token_invalid.
 *   6. Revalidate contactIdentityClass:
 *        - anonymous/verified_contact: identifierType must be 'visitorId',
 *          externalUserId must be null. verified_contact: also emailVerifiedAt != null.
 *        - external_user: identifierType must be 'externalUser',
 *          externalUserId must be non-null.
 *      Mismatch → identity_token_invalid.
 *   7. evaluateSendAuthorization(...) with the resolved identity + presented pv.
 *   8. If allowed → { allowed: true, identityLevel: resolvedIdentity }.
 *   9. If denied → { allowed: false, reason: decision.reason }.
 *
 * Pure — no side effects, no I/O. Fully unit-testable.
 */
export function evaluateVisitorCurrentPolicyAccess(args: {
  currentAccessMode: unknown
  currentPolicyVersion: unknown
  tokenIdentityLevel: unknown
  tokenPolicyVersion: unknown
  contactIdentityClass: ContactIdentityClass
}): VisitorAccessDecision {
  // 1. parse accessMode strictly.
  const accessMode = parseAccessMode(args.currentAccessMode)
  if (accessMode === null) return { allowed: false, reason: 'policy_unavailable' }

  // 2. parse currentPolicyVersion strictly.
  const currentPolicyVersion = parsePolicyVersion(args.currentPolicyVersion)
  if (currentPolicyVersion === null) return { allowed: false, reason: 'policy_unavailable' }

  // 3. isLegacy = BOTH claims genuinely absent (undefined).
  const isLegacy = args.tokenIdentityLevel === undefined && args.tokenPolicyVersion === undefined

  // 4. Resolve the token's identity level against the current access mode.
  const resolvedIdentity = resolveLegacyTokenIdentity({
    currentAccessMode: accessMode,
    tokenIdentityLevel: args.tokenIdentityLevel,
    tokenPolicyVersion: args.tokenPolicyVersion,
  })

  // 5. If resolution failed, fail with the mode-specific reason.
  if (resolvedIdentity === null) {
    if (isLegacy) {
      // Both claims absent + non-anonymous mode → mode-specific deny.
      if (accessMode === 'verified_visitor') return { allowed: false, reason: 'verification_required' }
      if (accessMode === 'site_user_only') return { allowed: false, reason: 'website_login_required' }
      // (anonymous + legacy both-absent resolves to 'anonymous' — unreachable here.)
      return { allowed: false, reason: 'identity_token_invalid' }
    }
    // Partial / malformed modern claims → identity_token_invalid.
    return { allowed: false, reason: 'identity_token_invalid' }
  }

  // 6. Revalidate the Contact's persisted identity class against the
  // resolved identity claim. A correctly-signed token whose Contact row
  // has drifted (e.g. a verified_contact token for an externalUser Contact)
  // must NOT pass.
  const c = args.contactIdentityClass
  if (resolvedIdentity === 'anonymous' || resolvedIdentity === 'verified_contact') {
    if (c.identifierType !== 'visitorId' || c.externalUserId !== null) {
      return { allowed: false, reason: 'identity_token_invalid' }
    }
    if (resolvedIdentity === 'verified_contact' && c.emailVerifiedAt === null) {
      return { allowed: false, reason: 'identity_token_invalid' }
    }
  } else if (resolvedIdentity === 'external_user') {
    if (c.identifierType !== 'externalUser' || c.externalUserId === null) {
      return { allowed: false, reason: 'identity_token_invalid' }
    }
  } else {
    // Exhaustiveness — unreachable (resolvedIdentity is a valid IdentityLevel).
    return { allowed: false, reason: 'identity_token_invalid' }
  }

  // 7. Evaluate the FROZEN policy semantics (policyVersion + sufficiency).
  // `presentedPolicyVersion` is typed `number | null | undefined` by the
  // evaluator; args.tokenPolicyVersion is `unknown` (the caller passes the
  // raw token claim). resolveLegacyTokenIdentity already validated the
  // claim shape, so we cast through to the expected type — the evaluator
  // re-parses defensively.
  const decision = evaluateSendAuthorization({
    accessMode,
    currentPolicyVersion,
    identityLevel: resolvedIdentity,
    presentedPolicyVersion: args.tokenPolicyVersion as number | null | undefined,
  })

  // 8/9. Map the decision to a VisitorAccessDecision. The evaluator's
  // AuthorizationDenyReason union is wider than the 5 reasons a visitor
  // can ever see from THIS entry point — narrow explicitly so the
  // VisitorAccessDecision type stays tight + exhaustive.
  if (decision.allowed) {
    return { allowed: true, identityLevel: resolvedIdentity }
  }
  switch (decision.reason) {
    case 'policy_unavailable':
      return { allowed: false, reason: 'policy_unavailable' }
    case 'policy_changed':
      return { allowed: false, reason: 'policy_changed' }
    case 'verification_required':
      return { allowed: false, reason: 'verification_required' }
    case 'website_login_required':
      return { allowed: false, reason: 'website_login_required' }
    case 'identity_token_invalid':
      return { allowed: false, reason: 'identity_token_invalid' }
    default:
      // `identity_token_expired` + `integration_unavailable` cannot be
      // produced by evaluateSendAuthorization's current impl — they're in
      // the union for future use. Map them to identity_token_invalid as a
      // defense-in-depth fallback so the route surfaces a stable error.
      return { allowed: false, reason: 'identity_token_invalid' }
  }
}
