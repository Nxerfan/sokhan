import crypto from 'crypto'
import { AUTH_SECRET } from './env-check'

/**
 * Realtime token — a lightweight HMAC-signed token used to authenticate
 * Socket.IO connections for BOTH agents (dashboard) and visitors (widget).
 *
 * Uses the same NEXTAUTH_SECRET as NextAuth (via env-check safeguard), so
 * the realtime service can verify tokens without any NextAuth dependency.
 *
 * Format: base64url(payload).base64url(hmac_sha256(payload, secret))
 */

const SECRET = AUTH_SECRET

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

function hmacSign(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
}

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

export function signToken(payload: RealtimeTokenPayload): string {
  const encoded = b64url(JSON.stringify(payload))
  const sig = hmacSign(encoded)
  return `${encoded}.${sig}`
}

export function verifyToken(token: string): RealtimeTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  const expectedSig = hmacSign(encoded)
  if (sig !== expectedSig) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    if (payload.type !== 'agent' && payload.type !== 'visitor') return null
    return payload as RealtimeTokenPayload
  } catch {
    return null
  }
}
