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
 *   change roles for existing members), only GET + PATCH remain supported
 *   on this route. The POST is now a 410 Gone that points callers at the
 *   invitations endpoint.
 */

export async function GET() {
  const result = await withSessionTenant(async () => {
    // Only active memberships — 'invited' no longer exists (see PR #11
    // migration), and any other non-active status would leak users who no
    // longer have access to the workspace.
    // Explicit tenantId filter — defense-in-depth (do not rely solely on
    // the Prisma extension's auto-injection).
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
 *
 * Returns 410 Gone so stale callers (old clients, tests) get a clear
 * non-success response and cannot accidentally create a stub membership.
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
    // Agent and viewer have no membership management.
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const body = await req.json()
    const memberId = String(body.memberId ?? '')
    const role = String(body.role ?? '')

    // Validate role — reject 'owner' and invalid roles.
    if (role === 'owner') {
      return { error: 'cannot_assign_owner' as const }
    }
    if (!VALID_ROLES.includes(role)) {
      return { error: 'invalid_role' as const }
    }

    // Actor cannot assign a role at or above their own authority.
    if (!canManageRole(session.user.role, role)) {
      return { forbidden: true as const }
    }

    const tid = getCurrentTenantId()!

    // Fetch the target membership — must belong to the current tenant.
    const target = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
    })
    if (!target) {
      return { error: 'not_found' as const }
    }

    // Actor cannot modify their own membership (no self-promotion / demotion).
    if (target.userId === session.user.id) {
      return { forbidden: true as const }
    }

    // Only owner may modify admin memberships; nobody may modify owner.
    // General rule: actor can only manage roles strictly below their own.
    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

    // Apply the role change — tenantId explicit in where (defense-in-depth).
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

export { canManageRole }
