import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db, globalDb } from '@/lib/db'
import { PlanLimitExceededError } from '@/lib/payments/gating'
import { getPlan } from '@/lib/payments/plans'
import { canManageRole, VALID_ROLES } from '@/lib/authz'
import { acquireTenantSeatLock } from '@/lib/seat-lock'
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

    // Generate token + hash (pure functions, no DB state). The raw token
    // is returned EXACTLY ONCE in the response — never logged, persisted.
    const { rawToken, tokenHash } = generateInvitationToken()
    const expiresAt = invitationExpiryFromNow()

    // ONE serialized transaction (FINAL BLOCKER fix): acquire the
    // per-tenant seat-capacity lock → duplicate checks → capacity check
    // → create. The PostgreSQL `SELECT ... FOR UPDATE` row lock on the
    // Tenant row (acquireTenantSeatLock) serializes ALL seat-increasing
    // operations for this tenant across ALL app instances — two
    // concurrent creates for DIFFERENT emails cannot both pass the
    // capacity check and overbook, and two concurrent creates for the
    // SAME email cannot both pass the duplicate-pending check.
    let txResult:
      | { error: 'already_member' | 'invitation_already_pending' }
      | { invitation: { id: string; email: string; role: string; status: string; expiresAt: Date } }
    try {
      txResult = await db.$transaction(async (tx) => {
        // (a) Acquire the per-tenant seat-capacity serialization lock.
        // Blocks until any concurrent seat-reserving transaction for this
        // tenant commits — everything below is serialized per tenant.
        await acquireTenantSeatLock(tx, tid)

        // (b) Duplicate active membership check (under the lock).
        const existingUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        })
        if (existingUser) {
          const m = await tx.membership.findUnique({
            where: { userId_tenantId: { userId: existingUser.id, tenantId: tid } },
            select: { status: true },
          })
          if (m?.status === 'active') {
            return { error: 'already_member' as const }
          }
        }

        // (c) Duplicate pending invitation check (under the lock): at
        // most one live pending invitation per (tenantId, email).
        // Serialized by the tenant lock — a concurrent same-email create
        // sees the first one's committed pending row.
        const dupPending = await tx.invitation.findFirst({
          where: { tenantId: tid, email, status: 'pending' },
          select: { id: true, expiresAt: true },
        })
        if (dupPending && !isExpired(dupPending)) {
          return { error: 'invitation_already_pending' as const }
        }

        // (d) TRANSACTIONAL capacity check (under the lock): active
        // memberships + unexpired pending invitations. The new pending
        // invitation consumes one seat — reject if usage >= limit.
        // Throw to roll back (nothing created).
        const now = new Date()
        const [activeCount, pendingCount] = await Promise.all([
          tx.membership.count({ where: { status: 'active' } }),
          tx.invitation.count({
            where: { status: 'pending', expiresAt: { gt: now } },
          }),
        ])
        const usage = activeCount + pendingCount
        const sub = await tx.subscription.findFirst({
          where: { status: 'active' },
          include: { plan: { select: { slug: true } } },
          orderBy: { createdAt: 'desc' },
        })
        let planSlug = sub?.plan?.slug
        if (!planSlug) {
          const t = await tx.tenant.findUnique({
            where: { id: tid },
            select: { plan: true },
          })
          planSlug = t?.plan ?? 'free'
        }
        const plan = getPlan(planSlug) ?? getPlan('free')!
        const limitValue = plan.limits.agents
        if (limitValue !== -1 && usage >= limitValue) {
          throw new PlanLimitExceededError('agents', {
            allowed: false,
            current: usage,
            limit: limitValue,
            planSlug,
          })
        }

        // (e) Create the pending invitation (the seat-increasing write).
        const created = await tx.invitation.create({
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
        return { invitation: created } as const
      })
    } catch (e) {
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result } as const
      }
      throw e
    }

    if ('error' in txResult) {
      return txResult
    }
    const invitation = txResult.invitation

    // Build the invite URL with the raw token AND the workspace slug.
    // The slug is the PUBLIC tenant identifier — the public lookup route
    // (/api/invitations/lookup?workspace=<slug>&token=<opaque>) resolves
    // the slug → tenantId FIRST, then enters withTenant(tenantId) before
    // querying the tenant-scoped Invitation row. This establishes tenant
    // context BEFORE any tenant-scoped read — the fail-closed contract
    // (BLOCKER 2). The raw token is still the opaque invitation secret.
    //
    // The origin is the request's forwarded host (respects Caddy/Vercel
    // proxy headers). Falls back to NEXTAUTH_URL if headers are absent.
    const origin = req.headers.get('x-forwarded-host')
      ? `${req.headers.get('x-forwarded-proto') || 'https'}://${req.headers.get('x-forwarded-host')}`
      : process.env.NEXTAUTH_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`

    // Resolve the tenant's slug — needed for the invite URL. The tenant
    // row is read via globalDb (Tenant is a GLOBAL model). getCurrentTenantId()
    // is non-null inside withSessionTenant.
    const tenantRow = await globalDb.tenant.findUnique({
      where: { id: tid },
      select: { slug: true },
    })
    const slug = tenantRow?.slug ?? ''

    const inviteUrl = `${origin}/invite?workspace=${encodeURIComponent(slug)}&token=${rawToken}`

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
