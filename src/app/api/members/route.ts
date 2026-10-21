import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { canManageRole, VALID_ROLES } from '@/lib/authz'

/**
 * Members CRUD (revised in PR #11).
 *
 * Role hierarchy:
 *   owner: 5, admin: 4, manager: 3, agent: 2, viewer: 1
 *
 * Rules:
 *   owner   may manage admin / manager / agent / viewer (not owner)
 *   admin   may manage manager / agent / viewer (not owner / admin)
 *   manager may manage agent / viewer (not owner / admin / manager)
 *   agent   no membership management
 *   viewer  no membership management
 *
 * Nobody may assign 'owner' through this endpoint.
 * Actor cannot modify their own membership (no self-promotion / self-demotion).
 * Only owner may modify admin memberships.
 *
 * INVITATION FLOW (PR #11)
 * ------------------------
 *   POST /api/members (create a Membership) is DEPRECATED for invitations.
 *   It returned an 'invited' Membership row + a stub User with no password —
 *   an antipattern that polluted the User table with unverifiable accounts.
 *   Invitations now go through POST /api/invitations, which creates an
 *   `Invitation` row + a one-time raw token returned to the inviter; the
 *   invitee verifies email ownership (OTP) then accepts to create their own
 *   User + Membership in one atomic transaction (see
 *   /api/invitations/accept-complete).
 *
 *   To preserve the PATCH /api/members role-change flow (still used to
 *   change roles for existing members), only GET + PATCH + DELETE remain
 *   supported on this route. The POST is now a 410 Gone that points callers
 *   at the invitations endpoint.
 *
 * MEMBERSHIP REVOCATION (DELETE — #6 fix)
 * ----------------------------------------
 *   DELETE /api/members?memberId=<id>
 *
 *   Revokes a membership by setting status='revoked' (NOT a hard delete —
 *   preserves the audit trail + the unique (userId, tenantId) constraint
 *   so future reinvitation reactivates rather than creating a duplicate).
 *
 *   Authorization (fail-closed):
 *     - actor must be manager+
 *     - cannot revoke owner (nobody can remove the workspace owner)
 *     - cannot revoke self (no self-removal via this generic endpoint)
 *     - actor may only revoke a role STRICTLY BELOW their own authority
 *       (canManageRole check — same as create/revoke-invitation)
 *     - target membership must belong to the CURRENT tenant
 *       (db.membership.findFirst is tenant-scoped → cross-tenant
 *       memberId returns null → 'not_found'. Fail-closed.)
 *
 *   Post-revocation guarantees:
 *     - /api/workspaces excludes it (filters status='active')
 *     - withSessionTenant() rejects it immediately (membership.status !==
 *       'active' → null → 401 on all tenant APIs)
 *     - the unique (userId, tenantId) row persists, so a future
 *       reinvitation + acceptance would hit P2002 on the Membership
 *       create → the accept route's 'already_member' idempotent path
 *       REACTIVATES the row (PATCH status back to 'active'). (If a
 *       hard-reactivation path is needed, a dedicated PATCH endpoint
 *       can be added; for now, reinvitation is the canonical path.)
 */

export async function GET() {
  const result = await withSessionTenant(async () => {
    // Only active memberships — 'invited' no longer exists (see PR #11
    // migration), and any other non-active status would leak users who no
    // longer have access to the workspace.
    return db.membership.findMany({
      where: { tenantId: getCurrentTenantId()!, status: 'active' },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ members: result.result })
}

/**
 * DEPRECATED (PR #11) — invitation creation now lives at POST /api/invitations.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'members_post_deprecated',
      message: 'Use POST /api/invitations to create invitations',
    },
    { status: 410 },
  )
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const body = await req.json()
    const memberId = String(body.memberId ?? '')
    const role = String(body.role ?? '')

    if (role === 'owner') {
      return { error: 'cannot_assign_owner' as const }
    }
    if (!VALID_ROLES.includes(role)) {
      return { error: 'invalid_role' as const }
    }

    if (!canManageRole(session.user.role, role)) {
      return { forbidden: true as const }
    }

    const tid = getCurrentTenantId()!

    const target = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
    })
    if (!target) {
      return { error: 'not_found' as const }
    }

    if (target.userId === session.user.id) {
      return { forbidden: true as const }
    }

    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

    await db.membership.updateMany({
      where: { id: memberId, tenantId: tid },
      data: { role },
    })
    const membership = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    return { membership } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) {
    const status = result.result.error === 'not_found' ? 404 : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
  return NextResponse.json({ membership: result.result.membership })
}

/**
 * DELETE /api/members?memberId=<id> — membership revocation (#6).
 *
 * Sets status='revoked'. See file header for the full authorization +
 * post-revocation contract.
 */
export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const memberId = req.nextUrl.searchParams.get('memberId')
    if (!memberId) return { error: 'missing_member_id' as const }

    const tid = getCurrentTenantId()!

    // Tenant-scoped lookup — cross-tenant memberId returns null (fail-closed).
    const target = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
      select: { id: true, userId: true, role: true, status: true },
    })
    if (!target) return { error: 'not_found' as const }

    // Cannot revoke owner — nobody may remove the workspace owner.
    if (target.role === 'owner') {
      return { error: 'cannot_revoke_owner' as const }
    }
    // Cannot revoke self via this generic endpoint.
    if (target.userId === session.user.id) {
      return { forbidden: true as const }
    }
    // Actor may only revoke a role strictly below their own authority.
    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }
    // Only active memberships can be revoked (idempotent for already-revoked).
    if (target.status === 'revoked') {
      return { error: 'already_revoked' as const }
    }

    await db.membership.updateMany({
      where: { id: memberId, tenantId: tid, status: 'active' },
      data: { status: 'revoked', updatedAt: new Date() },
    })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('error' in result.result) {
    const err = result.result.error
    const status =
      err === 'not_found' ? 404
        : err === 'missing_member_id' ? 400
        : err === 'cannot_revoke_owner' || err === 'already_revoked' ? 400
        : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ ok: true })
}

export { canManageRole }
