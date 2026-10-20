import { NextResponse, NextRequest } from 'next/server'
import { globalDb } from '@/lib/db'
import { verifyInvitationToken, isValidForAcceptance } from '@/lib/invitations'

/**
 * PUBLIC invitation lookup (PR #11).
 *
 *   GET  /api/invitations/[token]  — look up an invitation by the RAW token
 *
 * This endpoint is intentionally NOT behind authentication. The invitee
 * receives the link `/invite?token=<rawToken>` in their email; the invite
 * landing page calls this endpoint to render the invitation card before the
 * user decides to accept (which then requires auth or signup).
 *
 * LOOKUP MODEL — NOT TENANT-SCOPED
 * -------------------------------
 * This endpoint uses `globalDb` (the raw, un-extended PrismaClient), NOT the
 * fail-closed `db` proxy. The fail-closed proxy requires an active tenant
 * context (per-tenant client via `withTenant`), but a public lookup has no
 * tenant context yet — the invitee isn't signed in, and the token identifies
 * the invitation without a tenant hint.
 *
 * This is safe because:
 *   1. The query is by `tokenHash` (the SHA-256 of the raw token), which has
 *      a UNIQUE index. The hash is cryptographically unguessable: 256 bits of
 *      randomness in the raw token, hashed through SHA-256. Brute-forcing is
 *      computationally infeasible.
 *   2. The response returns ONLY safe fields: `workspaceName`, `role`,
 *      `email`, `expiresAt`. No tenantId, no tokenHash, no internal IDs.
 *   3. If the invitation is not found / expired / revoked / accepted, the
 *      endpoint returns 404. The error is deliberately identical for all
 *      failure modes — an attacker cannot distinguish "this token exists
 *      but is expired" from "this token doesn't exist".
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params
  const trimmed = rawToken.trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const tokenHash = verifyInvitationToken(trimmed)

  // globalDb (NOT db): public lookup, no tenant context — see file header.
  const invitation = await globalDb.invitation.findUnique({
    where: { tokenHash },
    include: { tenant: { select: { name: true } } },
  })

  if (!invitation || !invitation.tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!isValidForAcceptance(invitation)) {
    // Same error code for expired / revoked / accepted — caller cannot
    // distinguish WHY the invitation is no longer acceptable.
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Safe fields ONLY — never leak tenantId, tokenHash, acceptedUserId,
  // invitedByUserId, or the invitation id itself.
  return NextResponse.json({
    workspaceName: invitation.tenant.name,
    role: invitation.role,
    email: invitation.email,
    expiresAt: invitation.expiresAt,
  })
}
