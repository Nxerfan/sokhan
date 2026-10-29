import 'server-only'
import crypto from 'crypto'
import { getAuthSecret } from '@/lib/env-check'

const NEXTAUTH_SECRET = getAuthSecret()
export const RESUME_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60
export const EXTERNAL_IDENTITY_TOKEN_TTL_SECONDS = 5 * 60
const RESUME_AUDIENCE = 'sukhan-resume'
const EXTERNAL_AUDIENCE = 'sukhan-external'
const CLOCK_SKEW_SECONDS = 5

function assertValidPolicyVersion(pv: number): void {
  if (typeof pv !== 'number' || !Number.isFinite(pv) || !Number.isInteger(pv) || pv <= 0) throw new Error('invalid_policy_version')
}

function b64url(input: string | Buffer): string { return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url') }
function hmacSign(secret: string, data: string): string { return crypto.createHmac('sha256', secret).update(data).digest('base64url') }
function timingSafeEqualStr(a: string, b: string): boolean { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B) }

interface SignedEnvelope { type: string; aud: string; iat: number; exp: number; [k: string]: unknown }

function signEnvelope(payload: { type: string; aud: string } & Record<string, unknown>, ttl: number): string {
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: now, exp: now + ttl } as SignedEnvelope
  const encoded = b64url(JSON.stringify(full))
  return `${encoded}.${hmacSign(NEXTAUTH_SECRET, encoded)}`
}

function verifyEnvelope(token: string, expectedType: string, expectedAud: string): SignedEnvelope | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  if (!timingSafeEqualStr(sig, hmacSign(NEXTAUTH_SECRET, encoded))) return null
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString()) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.type !== expectedType || p.aud !== expectedAud) return null
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat)) return null
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null
  const now = Math.floor(Date.now() / 1000)
  if (p.iat > now + CLOCK_SKEW_SECONDS) return null
  if (p.exp <= now) return null
  return p as unknown as SignedEnvelope
}

export function signResumeCredential(args: { contactId: string; tenantId: string; policyVersion: number }): string {
  assertValidPolicyVersion(args.policyVersion)
  return signEnvelope({ type: 'resume', aud: RESUME_AUDIENCE, contactId: args.contactId, tenantId: args.tenantId, identityLevel: 'verified_contact', policyVersion: args.policyVersion }, RESUME_CREDENTIAL_TTL_SECONDS)
}

export function verifyResumeCredential(token: string, expectedTenantId: string, currentPolicyVersion: number): { contactId: string; tenantId: string; policyVersion: number } | null {
  const env = verifyEnvelope(token, 'resume', RESUME_AUDIENCE)
  if (!env) return null
  if (env.identityLevel !== 'verified_contact') return null
  if (env.tenantId !== expectedTenantId) return null
  if (env.policyVersion !== currentPolicyVersion) return null
  if (typeof env.contactId !== 'string' || !env.contactId) return null
  return { contactId: env.contactId, tenantId: env.tenantId, policyVersion: env.policyVersion }
}

export function signExternalIdentityToken(args: { tenantId: string; externalUserId: string; contactId?: string | null; policyVersion: number }): string {
  assertValidPolicyVersion(args.policyVersion)
  return signEnvelope({ type: 'external_identity', aud: EXTERNAL_AUDIENCE, externalUserId: args.externalUserId, contactId: args.contactId ?? null, tenantId: args.tenantId, identityLevel: 'external_user', policyVersion: args.policyVersion }, EXTERNAL_IDENTITY_TOKEN_TTL_SECONDS)
}

export function verifyExternalIdentityToken(token: string, expectedTenantId: string, currentPolicyVersion: number): { externalUserId: string; contactId: string | null; tenantId: string; policyVersion: number } | null {
  const env = verifyEnvelope(token, 'external_identity', EXTERNAL_AUDIENCE)
  if (!env) return null
  if (env.identityLevel !== 'external_user') return null
  if (env.tenantId !== expectedTenantId) return null
  if (env.policyVersion !== currentPolicyVersion) return null
  if (typeof env.externalUserId !== 'string' || env.externalUserId.length === 0) return null
  return { externalUserId: env.externalUserId, contactId: typeof env.contactId === 'string' ? env.contactId : null, tenantId: env.tenantId, policyVersion: env.policyVersion }
}

export function tamperToken(token: string): string {
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return 'invalid.token'
  return `${encoded}.${sig.slice(0, -1)}${sig.slice(-1) === 'a' ? 'b' : 'a'}`
}
