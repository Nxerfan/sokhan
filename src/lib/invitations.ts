/**
 * Invitation token + lifecycle helpers (PR #11).
 *
 * SECURITY CONTRACT
 * ------------------
 * The raw invitation token is returned to the inviter EXACTLY ONCE — at the
 * moment of creation — and embedded in the invitation link. The database
 * stores ONLY the SHA-256 hash of the token. Acceptance (public lookup OR
 * private acceptance) requires the raw token, which is matched against the
 * stored hash. SHA-256 is a one-way function: an attacker who exfiltrates the
 * hash table cannot reconstruct any raw token.
 *
 * The raw token is NEVER logged. The library never console.log()s it; route
 * handlers must not either. The raw token only ever flows:
 *   generateInvitationToken()  ->  HTTP response body  ->  inviter's email/share
 *   ->  invitee's `/invite?token=...` URL  ->  public lookup + acceptance flow
 * ->  hash lookup  ->  discard.
 *
 * LOOKUP MODEL
 * -----------
 * `verifyInvitationToken(rawToken)` returns the SHA-256 hash. The hash is the
 * value that should be used in any `findUnique({ where: { tokenHash } })` call.
 * The `Invitation.tokenHash` column has a UNIQUE index, so the lookup is a
 * single equality scan.
 */

import crypto from 'node:crypto'

/** Number of days an invitation remains valid after creation. */
export const INVITATION_EXPIRY_DAYS = 7

/**
 * Generate a fresh invitation token. Returns BOTH the raw token (returned to
 * the inviter exactly once — NEVER stored) AND the SHA-256 hash (stored in
 * the `Invitation.tokenHash` column, looked up on acceptance).
 *
 * `crypto.randomBytes(32)` produces 256 bits of cryptographically secure
 * randomness — sufficient to make brute-force guessing infeasible (2^256
 * search space). The raw token is hex-encoded for URL safety (64 chars).
 */
export function generateInvitationToken(): {
  rawToken: string
  tokenHash: string
} {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  return { rawToken, tokenHash }
}

/**
 * Hash a raw invitation token to its SHA-256 digest, for DB lookup. Used by
 * the public-lookup and acceptance endpoints to resolve an Invitation row
 * from a raw token presented by the invitee. NEVER store the raw token.
 */
export function verifyInvitationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/**
 * Has the invitation passed its `expiresAt`? Returns true if the current
 * time is later than `expiresAt`. Accepts a struct with `expiresAt: Date`
 * (the Prisma `Invitation` row shape).
 */
export function isExpired(invitation: { expiresAt: Date }): boolean {
  return invitation.expiresAt.getTime() <= Date.now()
}

/**
 * Is the invitation in a state where it can still be accepted?
 *
 *   - status MUST be 'pending' (not 'accepted' or 'revoked')
 *   - expiresAt MUST be in the future
 *
 * If either condition fails, the invitation is treated as invalid for
 * acceptance. The public lookup endpoint returns 404 for any non-acceptable
 * invitation (so an attacker cannot distinguish "expired" vs "revoked" vs
 * "already accepted" vs "doesn't exist").
 */
export function isValidForAcceptance(invitation: {
  status: string
  expiresAt: Date
}): boolean {
  return invitation.status === 'pending' && !isExpired(invitation)
}

/** Normalised role set that may be assigned via invitation. Owner is excluded. */
export const INVITABLE_ROLES = ['admin', 'manager', 'agent', 'viewer'] as const

/**
 * Input shape for the POST /api/invitations create endpoint. Email must be
 * lowercased by the caller before constructing this; role must be one of
 * INVITABLE_ROLES.
 */
export interface InvitationCreateInput {
  email: string
  role: string
}

/**
 * Output shape returned from the create endpoint. `inviteUrl` embeds the
 * RAW token — this is the ONLY time the raw token is surfaced back to the
 * caller. Subsequent reads (acceptance, public lookup) hash the token
 * before comparing; the raw form is never persisted or logged.
 */
export interface InvitationResult {
  id: string
  email: string
  role: string
  status: string
  expiresAt: Date
  inviteUrl: string
}

/**
 * Compute the absolute expiry Date for a freshly-created invitation.
 * Exposed as a helper so callers (route handlers, the accept-complete flow,
 * tests) compute the same value without re-implementing the math.
 */
export function invitationExpiryFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
}
