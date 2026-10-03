/**
 * Shared realtime-token helpers — used by THREE verifiers:
 *   1. App-side verifier        (src/lib/realtime-token.ts)
 *   2. Vercel realtime function (api/realtime.ts)
 *   3. Docker realtime service  (mini-services/realtime/index.ts)
 *
 * This module has ZERO non-stdlib imports so it can be loaded from any of
 * the three runtimes (Next.js, Vercel Function, Bun mini-service) without a
 * transpiler or path-alias dependency. Each caller passes its own `secret`.
 *
 * Security properties:
 *   - HMAC-SHA256 signature over base64url(payload).
 *   - Signed `iat` (issued-at) and `exp` (expiry) fields — tokens are
 *     short-lived (default 10 minutes) and cannot be reused forever.
 *   - Timing-safe signature comparison via `crypto.timingSafeEqual`.
 *   - Rejects: expired token, malformed exp, future iat, bad signature,
 *     invalid payload type, non-object payload.
 */

import crypto from 'crypto'

/** Default token lifetime in seconds (10 minutes). */
export const DEFAULT_TOKEN_TTL_SECONDS = 600

/** Allowed clock-skew for `iat` validation (seconds). */
const CLOCK_SKEW_SECONDS = 5

export interface AgentTokenPayload {
  type: 'agent'
  userId: string
  tenantId: string
  role: string
  name?: string
}

export interface VisitorTokenPayload {
  type: 'visitor'
  contactId: string
  tenantId: string
  slug: string
}

export type RealtimeTokenPayload = AgentTokenPayload | VisitorTokenPayload

interface SignedPayload {
  type: 'agent' | 'visitor'
  iat: number
  exp: number
  [key: string]: unknown
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

function hmacSign(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

/**
 * Timing-safe string comparison. Returns false early if lengths differ
 * (which is safe — length is not secret for HMAC-SHA256 base64url output).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Sign a realtime token. Adds `iat` and `exp` claims.
 * The token expires after `ttlSeconds` (default 10 minutes).
 */
export function signToken(
  payload: RealtimeTokenPayload,
  secret: string,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload: SignedPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  }
  const encoded = b64url(JSON.stringify(fullPayload))
  const sig = hmacSign(secret, encoded)
  return `${encoded}.${sig}`
}

/**
 * Verify a realtime token. Returns the payload if valid, or `null` if:
 *   - wrong number of segments
 *   - bad signature (timing-safe comparison)
 *   - payload is not valid JSON
 *   - payload is not an object
 *   - payload.type is not 'agent' or 'visitor'
 *   - iat is missing, not a number, or in the future (beyond skew)
 *   - exp is missing, not a number, or in the past
 */
export function verifyToken(
  token: string,
  secret: string,
): RealtimeTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  const expectedSig = hmacSign(secret, encoded)
  if (!timingSafeEqualStr(sig, expectedSig)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.type !== 'agent' && p.type !== 'visitor') return null

  // Validate iat — must be a finite number, not in the future.
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat)) return null
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null
  const now = Math.floor(Date.now() / 1000)
  if (p.iat > now + CLOCK_SKEW_SECONDS) return null // future iat
  if (p.exp < now) return null // expired

  return p as unknown as RealtimeTokenPayload
}
