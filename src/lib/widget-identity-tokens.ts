import 'server-only'
import crypto from 'crypto'

/**
 * Widget identity tokens — TWO distinct, strongly-separated credential classes
 * for the Widget Visitor Access Modes / Identity feature.
 *
 * (feat/widget-visitor-access-modes)
 *
 *   C. Verified-visitor RESUME credential (~30 days)
 *      - binds: tenant, Contact, identityLevel=verified_contact, audience,
 *        issuedAt, expiry, policyVersion
 *      - audience: 'sukhan-resume'
 *      - restores the SAME Contact on the same visitor identity (does NOT
 *        allow arbitrary Contact selection)
 *
 *   B. External-user IDENTITY token (≤5 minutes)
 *      - binds: tenant, externalUserId, identityLevel=external_user, audience,
 *        issuedAt, expiry, policyVersion
 *      - audience: 'sukhan-external'
 *      - minted server-to-server by the identity mint endpoint (the customer's
 *        backend calls it with the integration credential); returned to the
 *        browser; the browser never sees the integration credential
 *
 * STRONG PURPOSE/AUDIENCE SEPARATION: each verify function checks the token
 * `type` AND `aud` (audience) strictly. A resume credential can NEVER be
 * accepted as an external identity token (or vice versa), and neither can be
 * accepted as a realtime visitor token (different type/audience). This blocks
 * credential-confusion attacks.
 *
 * Signing: HMAC-SHA256 over base64url(payload), timing-safe comparison.
 * Signed `iat` (issued-at) + `exp` (expiry). The signing secret is
 * NEXTAUTH_SECRET (the app's signing secret, same as the realtime token) —
 * separation is enforced by type+audience, not by a different secret. (The
 * Mode 2 INTEGRATION credential is a SEPARATE dedicated random secret stored
 * hashed on WidgetConfig — see widget-integration-credential.ts.)
 */

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'dev-insecure-secret-not-production'

/** Resume credential lifetime: ~30 days. */
export const RESUME_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60
/** External identity token lifetime: 5 minutes (recommended maximum). */
export const EXTERNAL_IDENTITY_TOKEN_TTL_SECONDS = 5 * 60

const RESUME_AUDIENCE = 'sukhan-resume'
const EXTERNAL_AUDIENCE = 'sukhan-external'

/** Allowed clock-skew for `iat` validation (seconds). */
const CLOCK_SKEW_SECONDS = 5

// --- payload types ---

export interface ResumeCredentialPayload {
  type: 'resume'
  aud: typeof RESUME_AUDIENCE
  contactId: string
  tenantId: string
  identityLevel: 'verified_contact'
  policyVersion: number
  iat: number
  exp: number
}

export interface ExternalIdentityTokenPayload {
  type: 'external_identity'
  aud: typeof EXTERNAL_AUDIENCE
  externalUserId: string
  contactId: string | null // resolved lazily at verify time (the mint may not know the contactId)
  tenantId: string
  identityLevel: 'external_user'
  policyVersion: number
  // Optional sanitized profile metadata (display only — NOT an identity authority)
  name?: string
  username?: string
  email?: string
  avatarUrl?: string
  iat: number
  exp: number
}

// --- HS256 primitives (self-contained — no coupling to realtime-token-shared) ---

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

function hmacSign(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

interface SignedEnvelope {
  type: string
  aud: string
  iat: number
  exp: number
  [key: string]: unknown
}

function signEnvelope(payload: { type: string; aud: string } & Record<string, unknown>, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: now, exp: now + ttlSeconds } as SignedEnvelope
  const encoded = b64url(JSON.stringify(full))
  const sig = hmacSign(NEXTAUTH_SECRET, encoded)
  return `${encoded}.${sig}`
}

function verifyEnvelope(token: string, expectedType: string, expectedAudience: string): SignedEnvelope | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  const expectedSig = hmacSign(NEXTAUTH_SECRET, encoded)
  if (!timingSafeEqualStr(sig, expectedSig)) return null // bad signature / tampered

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  } catch {
    return null // malformed
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>

  // STRICT type + audience checks (purpose/audience separation).
  if (p.type !== expectedType) return null
  if (p.aud !== expectedAudience) return null

  // iat / exp validation.
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat)) return null
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null
  const now = Math.floor(Date.now() / 1000)
  if (p.iat > now + CLOCK_SKEW_SECONDS) return null // future iat
  if (p.exp <= now) return null // expired

  return p as unknown as SignedEnvelope
}

// --- C. Resume credential (verified_visitor) ---

/** Issue a verified-visitor resume credential (~30 days). */
export function signResumeCredential(args: {
  contactId: string
  tenantId: string
  policyVersion: number
}): string {
  return signEnvelope(
    {
      type: 'resume',
      aud: RESUME_AUDIENCE,
      contactId: args.contactId,
      tenantId: args.tenantId,
      identityLevel: 'verified_contact',
      policyVersion: args.policyVersion,
    },
    RESUME_CREDENTIAL_TTL_SECONDS,
  )
}

/**
 * Verify a resume credential. Returns the payload ONLY if:
 *   - signature is valid (timing-safe)
 *   - type === 'resume' AND aud === 'sukhan-resume'
 *   - not expired
 *   - tenantId === expectedTenantId (tenant-bound)
 *   - policyVersion === currentPolicyVersion (stale-policy rejection)
 * Returns null otherwise (fail closed — no partial information).
 */
export function verifyResumeCredential(
  token: string,
  expectedTenantId: string,
  currentPolicyVersion: number,
): { contactId: string; tenantId: string; policyVersion: number } | null {
  const env = verifyEnvelope(token, 'resume', RESUME_AUDIENCE)
  if (!env) return null
  if (env.tenantId !== expectedTenantId) return null // wrong tenant
  if (env.policyVersion !== currentPolicyVersion) return null // stale policyVersion
  if (typeof env.contactId !== 'string' || !env.contactId) return null
  return { contactId: env.contactId, tenantId: env.tenantId, policyVersion: env.policyVersion }
}

// --- B. External identity token (site_user_only) ---

/** Issue a short-lived (≤5 min) external-user identity token (server-to-server mint). */
export function signExternalIdentityToken(args: {
  tenantId: string
  externalUserId: string
  contactId?: string | null
  policyVersion: number
  profile?: { name?: string; username?: string; email?: string; avatarUrl?: string }
}): string {
  return signEnvelope(
    {
      type: 'external_identity',
      aud: EXTERNAL_AUDIENCE,
      externalUserId: args.externalUserId,
      contactId: args.contactId ?? null,
      tenantId: args.tenantId,
      identityLevel: 'external_user',
      policyVersion: args.policyVersion,
      ...(args.profile ?? {}),
    },
    EXTERNAL_IDENTITY_TOKEN_TTL_SECONDS,
  )
}

/**
 * Verify an external identity token. Returns the payload ONLY if:
 *   - signature is valid (timing-safe)
 *   - type === 'external_identity' AND aud === 'sukhan-external'
 *   - not expired
 *   - tenantId === expectedTenantId (tenant-bound)
 *   - policyVersion === currentPolicyVersion (stale-policy rejection)
 *   - externalUserId is a non-empty string (mandatory)
 * Returns null otherwise (fail closed).
 */
export function verifyExternalIdentityToken(
  token: string,
  expectedTenantId: string,
  currentPolicyVersion: number,
): {
  externalUserId: string
  contactId: string | null
  tenantId: string
  policyVersion: number
  profile: { name?: string; username?: string; email?: string; avatarUrl?: string }
} | null {
  const env = verifyEnvelope(token, 'external_identity', EXTERNAL_AUDIENCE)
  if (!env) return null
  if (env.tenantId !== expectedTenantId) return null // wrong tenant
  if (env.policyVersion !== currentPolicyVersion) return null // stale policyVersion
  if (typeof env.externalUserId !== 'string' || env.externalUserId.length === 0) return null
  return {
    externalUserId: env.externalUserId,
    contactId: typeof env.contactId === 'string' ? env.contactId : null,
    tenantId: env.tenantId,
    policyVersion: env.policyVersion,
    profile: {
      name: typeof env.name === 'string' ? env.name : undefined,
      username: typeof env.username === 'string' ? env.username : undefined,
      email: typeof env.email === 'string' ? env.email : undefined,
      avatarUrl: typeof env.avatarUrl === 'string' ? env.avatarUrl : undefined,
    },
  }
}

/** Test-only helper: create a TAMPERED token (flip the signature) for negative tests. */
export function tamperToken(token: string): string {
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return 'invalid.token'
  // Flip the last character of the signature → invalid signature.
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a')
  return `${encoded}.${flipped}`
}
