import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb } from '@/lib/db'
import { isExpired } from '@/lib/invitations'

/**
 * Workspace listing (PR #11).
 *
 *   GET  /api/workspaces
 *
 * Returns every workspace (tenant) the current user has an ACTIVE membership
 * in, plus any pending invitations still awaiting acceptance.
 *
 * This endpoint is NOT tenant-scoped — it queries across ALL tenants for this
 * user's active memberships. Therefore it uses `globalDb` (the raw PrismaClient)
 * rather than the fail-closed `db` proxy. The fail-closed proxy requires an
 * active tenant context, but this endpoint deliberately has no single tenant
 * context — it's the workspace switcher, which must enumerate all of them.
 *
 * This is safe because the query is filtered by `userId` (the session user),
 * so it returns only the user's own memberships — no cross-tenant data leak.
 *
 * Response:
 *   {
 *     workspaces: [{ id, name, slug, role, isCurrent }],
 *     pendingInvitations: [{ id, tenantId, workspaceName, role, expiresAt }]
 *   }
 *
 * `isCurrent` is true for the workspace whose id matches session.user.workspaceId
 * — the active one the user is currently operating in.
 */

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const userId = session.user.id
  const email = session.user.email.toLowerCase()
  const currentWorkspaceId = session.user.workspaceId ?? null

  // Active memberships across ALL tenants (NOT tenant-scoped) — globalDb.
  // The membership include pulls the tenant's id/name/slug in one query.
  const memberships = await globalDb.membership.findMany({
    where: { userId, status: 'active' },
    include: { tenant: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const workspaces = memberships
    .filter((m) => !!m.tenant)
    .map((m) => ({
      id: m.tenant!.id,
      name: m.tenant!.name,
      slug: m.tenant!.slug,
      role: m.role,
      isCurrent: m.tenant!.id === currentWorkspaceId,
    }))

  // Pending invitations for this email — globalDb, public lookup by email.
  // Filter out expired ones at the app layer (a janitor pass revokes them,
  // but the GET contract should be crisp without waiting for that).
  const invitations = await globalDb.invitation.findMany({
    where: { email, status: 'pending' },
    include: { tenant: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const pendingInvitations = invitations
    .filter((i) => !isExpired(i) && i.tenant)
    .map((i) => ({
      id: i.id,
      tenantId: i.tenantId,
      workspaceName: i.tenant!.name,
      role: i.role,
      expiresAt: i.expiresAt,
    }))

  return NextResponse.json({ workspaces, pendingInvitations })
}
