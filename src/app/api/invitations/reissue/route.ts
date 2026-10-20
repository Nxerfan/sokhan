import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db, globalDb } from '@/lib/db'
import { canManageRole } from '@/lib/authz'
import {
  generateInvitationToken,
  invitationExpiryFromNow,
} from '@/lib/invitations'

/**
 * Invitation REISSUE (PR #11, BLOCKER 4).
 *
 *   POST  /api/invitations/reissue?id=<invitationId>
 *
 * Reissues an existing REVOKED or SUPERSEDED invitation, producing a FRESH
 * cryptographic token + hash + expiry for the SAME email + role + tenant.
 * The old invitation row is marked `superseded` (a distinct non-usable
 * state) so it can never produce another valid link unexpectedly. The new
 * invitation is `pending` with a freshly-generated raw token returned
 * EXACTLY ONCE in the response.
 *
 * WHY THIS EXISTS
 * --------------
 * The legacy migration (`20241102000000_add_invitation_model_v2`) converts
 * old `Membership(status='invited')` rows into `Invitation` rows with a
 * SYNTHETIC tokenHash (`'legacy_' || md5(random() || id)`). No raw token
 * was ever generated for these rows — the synthetic hash is a one-way
 * digest of random bytes + the membership id, and `verifyInvitationToken()`
 * hashes a user-supplied raw token through SHA-256, which can never
 * reproduce the synthetic md5 value. These rows are therefore PERMANENTLY
 * UNUSABLE as invitation links. The migration marks them `revoked` (not
 * `pending`) so they don't display as usable invitations or consume seats.
 *
 * A manager who wants to re-invite one of these legacy invitees (or any
 * other revoked/superseded invitee) uses this endpoint. It:
 *   1. Validates the target invitation exists in the current tenant and
 *      has status `revoked` or `superseded` (i.e. it is NOT a usable
 *      pending invitation — reissuing a pending one would be a no-op;
 *      reissuing an accepted one would create a duplicate membership path).
 *   2. Validates the actor is manager+ who outranks the target role
 *      (same check as create/revoke).
 *   3. Generates a FRESH raw token + SHA-256 hash + expiry.
 *   4. In a transaction:
 *        a. Mark the OLD invitation `superseded` (no longer `revoked`).
 *           `superseded` is NOT `pending` → does not consume a seat and
 *           cannot be accepted.
 *        b. Create a NEW invitation (status='pending') for the same
 *           email/role/tenant with the fresh tokenHash + expiry.
 *   5. Returns the new invitation's inviteUrl (with the raw token) EXACTLY
 *      ONCE.
 *
 * SEAT COUNT INVARIANT
 * --------------------
 * Before reissue: the old invitation is `revoked` → 0 seats.
 * After reissue: the old is `superseded` (0 seats) + the new is `pending`
 * (1 seat). Net change: +1 seat (the new pending invitation). This is
 * correct — the manager is re-creating an invitation that reserves a
 * seat. The plan-limit gate at create-time still applies: if the tenant
 * is at the cap, the reissue is rejected with `plan_limit_exceeded`
 * (same as a fresh create).
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The fresh raw token is generated server-side, returned EXACTLY ONCE
 *     in the response, and NEVER persisted/logged. Only the hash is stored.
 *   - The old synthetic/unrecoverable tokenHash remains in the DB row (now
 *     marked `superseded`) but is irrelevant — no raw token can ever match
 *     it, and the row's status prevents acceptance regardless.
 *   - Only revoked/superseded invitations can be reissued. A `pending`
 *     invitation is already usable (the inviter should share the original
 *     link). An `accepted` invitation already produced a membership.
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return { error: 'missing_id' as const }

    const tid = getCurrentTenantId()!

    // Look up the target invitation in the current tenant. The fail-closed
    // extension injects tenantId; explicit filter is defense-in-depth.
    const target = await db.invitation.findFirst({
      where: { id, tenantId: tid },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) return { error: 'not_found' as const }

    // Only revoked or superseded invitations can be reissued.
    if (target.status === 'pending') {
      return { error: 'already_pending' as const }
    }
    if (target.status === 'accepted') {
      return { error: 'already_accepted' as const }
    }
    if (target.status !== 'revoked' && target.status !== 'superseded') {
      return { error: 'not_reissuable' as const }
    }

    // Actor must outrank the target role (same as create/revoke).
    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

    // Plan-limit gate — the new pending invitation consumes a seat.
    // Reuse the create-time gate via a direct import to avoid a circular
    // dependency. The gate counts active memberships + unexpired pending
    // invitations (BLOCKER 3). The old invitation here is revoked/
    // superseded → does not count → the new pending invitation is the +1.
    const { enforceCurrentTenantPlanLimit, PlanLimitExceededError } = await import(
      '@/lib/payments/gating'
    )
    try {
      await enforceCurrentTenantPlanLimit('agents')
    } catch (e: any) {
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result } as const
      }
      throw e
    }

    // Generate the fresh token + hash + expiry.
    const { rawToken, tokenHash } = generateInvitationToken()
    const expiresAt = invitationExpiryFromNow()

    // Transaction: mark old superseded + create new pending.
    const newId = await db.$transaction(async (tx) => {
      // (a) Mark the old invitation `superseded` — no longer usable, no
      // longer counts as a seat, no longer displays as pending. Idempotent
      // in case a previous reissue run already marked it.
      await tx.invitation.updateMany({
        where: { id: target.id, status: { in: ['revoked', 'superseded'] } },
        data: { status: 'superseded', updatedAt: new Date() },
      })

      // (b) Create the NEW pending invitation with the fresh hash + expiry.
      const created = await tx.invitation.create({
        data: {
          tenantId: tid,
          email: target.email,
          role: target.role,
          status: 'pending',
          tokenHash,
          expiresAt,
          invitedByUserId: session.user.id,
        },
        select: { id: true },
      })
      return created.id
    })

    // Build the invite URL with the workspace slug + fresh raw token.
    const origin = req.headers.get('x-forwarded-host')
      ? `${req.headers.get('x-forwarded-proto') || 'https'}://${req.headers.get('x-forwarded-host')}`
      : process.env.NEXTAUTH_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`

    const tenantRow = await globalDb.tenant.findUnique({
      where: { id: tid },
      select: { slug: true },
    })
    const slug = tenantRow?.slug ?? ''

    const inviteUrl = `${origin}/invite?workspace=${encodeURIComponent(slug)}&token=${rawToken}`

    return {
      invitation: {
        id: newId,
        email: target.email,
        role: target.role,
        status: 'pending' as const,
        expiresAt,
        inviteUrl,
      },
    } as const
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
      err === 'not_found'
        ? 404
        : err === 'missing_id' || err === 'already_pending' || err === 'already_accepted' || err === 'not_reissuable'
          ? 400
          : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ invitation: result.result.invitation })
}
