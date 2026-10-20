import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { enforceCurrentTenantPlanLimit, PlanLimitExceededError } from '@/lib/payments/gating'
import { canManageRole, VALID_ROLES } from '@/lib/authz'
import {
  generateInvitationToken,
  invitationExpiryFromNow,
  isExpired,
  type InvitationResult,
} from '@/lib/invitations'

/**
 * Invitation CRUD (PR #11).
 *
 *   GET     /api/invitations                 — list pending invitations in
 *                                              the current workspace
 *                                              (manager+ only)
 *   POST    /api/invitations                 — create a new invitation +
 *                                              return the raw token EXACTLY
 *                                              ONCE in the response
 *                                              (manager+ who outranks target)
 *   DELETE  /api/invitations?id=<invitationId> — revoke a pending
 *                                              invitation
 *                                              (manager+ who outranks target)
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The raw invitation token is generated in `generateInvitationToken()`,
 *     embedded in the response body as `inviteUrl` exactly ONCE, and never
 *     persisted, logged, or returned again. Subsequent reads go through the
 *     hash (DB lookup via `Invitation.tokenHash`, which has a UNIQUE index).
 *   - All queries are tenant-scoped via the fail-closed `db` proxy
 *     (`withSessionTenant` activates the tenant context). The plan-limit
 *     count includes BOTH active memberships AND pending invitations — the
 *     `Membership(status='invited')` row no longer exists (the migration
 *     deleted them and backfilled `Invitation` rows), so the new count
 *     formula is `active_count + pending_invitation_count`.
 *   - Revoke requires the same outranking-actor check that create requires
 *     (manager+ who outranks the target role) — the inviter cannot revoke a
 *     role they couldn't have created.
 */

/** Safe projection for the GET list (no tokenHash, no internal IDs leaked). */
function publicListFields(i: any) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.status,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    acceptedAt: i.acceptedAt,
  }
}

export async function GET() {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }
    // Pending invitations only — accepted/revoked/expired are hidden from the list.
    // The fail-closed extension injects tenantId; explicit filter is defense-in-depth.
    const tid = getCurrentTenantId()!
    const invitations = await db.invitation.findMany({
      where: { tenantId: tid, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    // Filter out expired entries at the app layer too — keeps the GET contract
    // crisp without mutating the DB (a separate janitor pass revokes them).
    const live = invitations.filter((i) => !isExpired(i))
    return { invitations: live.map(publicListFields) } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return NextResponse.json({ invitations: result.result.invitations })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const body = await req.json().catch(() => null)
    const email = String(body?.email ?? '').trim().toLowerCase()
    const role = String(body?.role ?? '')

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { error: 'invalid_email' as const }
    }
    if (role === 'owner') return { error: 'cannot_assign_owner' as const }
    if (!VALID_ROLES.includes(role)) return { error: 'invalid_role' as const }
    // Actor must outrank the target role.
    if (!canManageRole(session.user.role, role)) return { forbidden: true as const }

    const tid = getCurrentTenantId()!

    // Duplicate active membership check: if there's already an active
    // membership for this email in this workspace, do not invite again.
    const existingUser = await db.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (existingUser) {
      const m = await db.membership.findUnique({
        where: { userId_tenantId: { userId: existingUser.id, tenantId: tid } },
        select: { status: true },
      })
      if (m?.status === 'active') return { error: 'already_member' as const }
    }

    // Duplicate pending invitation check: at most one active invitation per
    // (tenantId, email) at a time. (Existing revoked/accepted invitations
    // for the same email are fine — the user can be re-invited.)
    const dupPending = await db.invitation.findFirst({
      where: { tenantId: tid, email, status: 'pending' },
      select: { id: true, expiresAt: true },
    })
    if (dupPending && !isExpired(dupPending)) {
      return { error: 'invitation_already_pending' as const }
    }

    // Plan limit check: active memberships + pending invitations count toward
    // the 'agents' limit. The new gating.ts formula counts both correctly.
    try {
      await enforceCurrentTenantPlanLimit('agents')
    } catch (e) {
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result } as const
      }
      throw e
    }

    // Generate token + hash. The raw token is returned EXACTLY ONCE in the
    // response — never logged, never persisted.
    const { rawToken, tokenHash } = generateInvitationToken()
    const expiresAt = invitationExpiryFromNow()

    const invitation = await db.invitation.create({
      data: {
        tenantId: tid,
        email,
        role,
        status: 'pending',
        tokenHash,
        expiresAt,
        invitedByUserId: session.user.id,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
      },
    })

    // Build the invite URL with the raw token. The origin is the request's
    // forwarded host (respects Caddy/Vercel proxy headers). Falls back to
    // the NEXTAUTH_URL env var if headers are absent (e.g., in tests).
    const origin = req.headers.get('x-forwarded-host')
      ? `${req.headers.get('x-forwarded-proto') || 'https'}://${req.headers.get('x-forwarded-host')}`
      : process.env.NEXTAUTH_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`

    const inviteUrl = `${origin}/invite?token=${rawToken}`

    const payload: InvitationResult = {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      inviteUrl,
    }
    return { invitation: payload } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('planLimit' in result.result) {
    const r = result.result as { planLimit: { current: number; limit: number; planSlug: string } }
    return NextResponse.json(
      {
        error: 'plan_limit_exceeded',
        limit: 'agents',
        current: r.planLimit.current,
        max: r.planLimit.limit,
        plan: r.planLimit.planSlug,
      },
      { status: 402 },
    )
  }
  if ('error' in result.result) {
    const err = result.result.error
    const status =
      err === 'invalid_role' ||
      err === 'cannot_assign_owner' ||
      err === 'invalid_email' ||
      err === 'already_member' ||
      err === 'invitation_already_pending'
        ? 400
        : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ invitation: result.result.invitation })
}

export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    // The id may arrive as a query param (?id=...) or as a JSON body { id }.
    // Both are accepted so callers can use whichever is convenient.
    const urlId = req.nextUrl.searchParams.get('id')
    let id: string | null = urlId
    if (!id) {
      const body = await req.json().catch(() => null)
      id = String(body?.id ?? '').trim() || null
    }
    if (!id) return { error: 'missing_id' as const }

    const tid = getCurrentTenantId()!
    // Tenant-scoped lookup — the fail-closed extension would inject tenantId
    // anyway; explicit filter is defense-in-depth.
    const invitation = await db.invitation.findFirst({
      where: { id, tenantId: tid },
      select: { id: true, role: true, status: true },
    })
    if (!invitation) return { error: 'not_found' as const }
    if (invitation.status !== 'pending') {
      return { error: 'not_pending' as const }
    }
    // Revoke requires the same outranking check as create.
    if (!canManageRole(session.user.role, invitation.role)) {
      return { forbidden: true as const }
    }

    await db.invitation.update({
      where: { id: invitation.id },
      data: { status: 'revoked' },
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
      err === 'not_found' ? 404 : err === 'not_pending' || err === 'missing_id' ? 400 : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ ok: true })
}

// Re-export for legacy callers that imported canManageRole from the members route.
export { canManageRole }
