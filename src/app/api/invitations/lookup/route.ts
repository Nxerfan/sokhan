import { NextResponse, NextRequest } from 'next/server'
import { globalDb, withTenant, db } from '@/lib/db'
import { verifyInvitationToken, isValidForAcceptance } from '@/lib/invitations'

/**
 * PUBLIC invitation lookup — TENANT-SCOPED (PR #11, BLOCKER 2 fix).
 *
 *   GET  /api/invitations/lookup?workspace=<slug>&token=<opaque>
 *
 * This endpoint is intentionally NOT behind authentication. The invitee
 * receives the link `/invite?workspace=<slug>&token=<opaqueToken>` in their
 * email; the invite landing page calls this endpoint to render the
 * invitation card before the user decides to accept (which then requires
 * auth or signup).
 *
 * TENANT-SCOPING CONTRACT — FAIL-CLOSED
 * --------------------------------------
 * The token is a random opaque value whose SHA-256 hash is stored in the
 * `Invitation` table. `Invitation` is a tenant-scoped Prisma model (see
 * `TENANT_SCOPED_MODEL_NAMES` in src/lib/db.ts). A token-only lookup
 * cannot establish tenant context before querying — therefore the invite
 * URL carries BOTH:
 *   - `workspace` — the public tenant slug, resolved to a tenantId FIRST
 *                  via a global `Tenant.findUnique({ where: { slug } })`
 *                  query (Tenant is a GLOBAL model, so globalDb is safe here)
 *   - `token`     — the opaque raw invitation token
 *
 * Once the tenant is resolved, we enter `withTenant(tenantId)` and query
 * `db.invitation.findUnique({ where: { tokenHash } })` — the fail-closed
 * extension injects `tenantId` into the where clause, so the actual DB
 * query is `WHERE tokenHash = $1 AND tenantId = $2`. If an attacker
 * substitutes a different valid workspace slug, the tenantId filter
 * ensures the invitation (which belongs to the ORIGINAL tenant) is not
 * found → 404. Fail-closed.
 *
 * `Tenant.findUnique({ where: { slug } })` is safe to run on globalDb
 * because `Tenant` is NOT a tenant-scoped model — it is the root
 * isolation boundary itself (its `slug` is globally unique). No
 * per-tenant context is needed to look up a tenant by its own slug.
 *
 * SAFE RESPONSE FIELDS
 * --------------------
 * The response returns ONLY: `workspaceName`, `role`, `email`,
 * `expiresAt`. No tenantId, no tokenHash, no internal ids.
 *
 * For any non-acceptable state (not found / expired / revoked / accepted /
 * tampered workspace), the endpoint returns 404 with the SAME error code.
 * An attacker cannot distinguish WHY the invitation is invalid.
 */
export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get('workspace') ?? '').trim()
  const rawToken = (req.nextUrl.searchParams.get('token') ?? '').trim()

  if (!slug || !rawToken) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // 1. Resolve the public tenant slug → tenantId. Tenant is a GLOBAL model,
  //    so globalDb is correct here (no tenant context needed to look up a
  //    tenant by its own unique slug). If the slug doesn't resolve, fail
  //    closed with the same 404 as every other failure mode.
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const tokenHash = verifyInvitationToken(rawToken)

  // 2. Enter the tenant context. Inside, `db.invitation` routes to the
  //    per-tenant extended client whose findUnique handler injects
  //    `tenantId` into the where clause. The effective DB query is
  //    `WHERE tokenHash = $1 AND tenantId = $2`. A token issued for a
  //    DIFFERENT tenant will not match → 404.
  const invitation = await withTenant(tenant.id, () =>
    db.invitation.findUnique({
      where: { tokenHash },
    }),
  )

  if (!invitation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!isValidForAcceptance(invitation)) {
    // Same error code for expired / revoked / accepted — caller cannot
    // distinguish WHY the invitation is no longer acceptable.
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // 3. Safe fields ONLY — never leak tenantId, tokenHash, acceptedUserId,
  //    invitedByUserId, or the invitation id itself.
  return NextResponse.json({
    workspaceName: tenant.name,
    role: invitation.role,
    email: invitation.email,
    expiresAt: invitation.expiresAt,
  })
}
