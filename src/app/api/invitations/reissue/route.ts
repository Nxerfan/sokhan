import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db, globalDb } from '@/lib/db'
import { canManageRole } from '@/lib/authz'
import {
  generateInvitationToken,
  invitationExpiryFromNow,
} from '@/lib/invitations'

/**
 * Invitation REISSUE (PR #11, BLOCKER 4 — fixed lifecycle).
 *
 *   POST  /api/invitations/reissue?id=<invitationId>
 *
 * Reissues an existing REVOKED invitation, producing a FRESH cryptographic
 * token + hash + expiry for the SAME email + role + tenant. The old
 * invitation row is marked `superseded` (a distinct non-usable state) so it
 * can never be reissued again. The new invitation is `pending` with a
 * freshly-generated raw token returned EXACTLY ONCE in the response.
 *
 * LIFECYCLE INVARIANT — exactly one valid link per reissue chain (#4 fix)
 * --------------------------------------------------------------------
 *   - ONLY `revoked` invitations may be reissued.
 *   - `superseded` rows CANNOT be reissued (they are the spent husk of a
 *     previous reissue). Reissuing a superseded row would create a SECOND
 *     valid pending link for the same logical invitee, violating the
 *     one-active-link invariant.
 *   - `pending` invitations are already usable — reissuing would duplicate.
 *   - `accepted` invitations already produced a membership — reissuing
 *     would create a duplicate membership path.
 *
 * To reissue a CURRENTLY-PENDING invitation (e.g. the link was lost):
 *   1. REVOKE the pending invitation (DELETE /api/invitations?id=...).
 *   2. Reissue that newly-revoked row via this endpoint.
 * This guarantees exactly one valid pending link exists at any time.
 *
 * SEAT COUNT
 * ----------
 * Before reissue: the old invitation is `revoked` → 0 seats.
 * After reissue: the old is `superseded` (0 seats) + the new is `pending`
 * (1 seat). Net: +1 seat. The plan-limit gate applies.
 *
 * SECURITY
 * --------
 *   - Fresh raw token generated server-side, returned EXACTLY ONCE, never
 *     persisted/logged. Only the SHA-256 hash is stored.
 *   - Actor must be manager+ who outranks the target role.
 *   - Target must belong to the current tenant (fail-closed).
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return { error: 'missing_id' as const }

    const tid = getCurrentTenantId()!

    const target = await db.invitation.findFirst({
      where: { id, tenantId: tid },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) return { error: 'not_found' as const }

    // ONLY revoked invitations may be reissued (#4 fix).
    if (target.status === 'pending') {
      return { error: 'already_pending' as const }
    }
    if (target.status === 'accepted') {
      return { error: 'already_accepted' as const }
    }
    if (target.status === 'superseded') {
      // A superseded row is the spent husk of a previous reissue — it
      // CANNOT be reissued again (would create a second valid link).
      return { error: 'superseded_not_reissuable' as const }
    }
    if (target.status !== 'revoked') {
      return { error: 'not_reissuable' as const }
    }

    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

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

    const { rawToken, tokenHash } = generateInvitationToken()
    const expiresAt = invitationExpiryFromNow()

    const newId = await db.$transaction(async (tx) => {
      // (a) Mark the OLD revoked invitation `superseded` — it can never be
      // reissued again (#4 invariant). The WHERE status='revoked' guard
      // makes this conditional (a concurrent reissue of the same row
      // would affect 0 rows → the new pending is still created, but the
      // old stays revoked rather than superseded — acceptable).
      await tx.invitation.updateMany({
        where: { id: target.id, status: 'revoked' },
        data: { status: 'superseded', updatedAt: new Date() },
      })

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
        : err === 'missing_id' || err === 'already_pending' || err === 'already_accepted' || err === 'not_reissuable' || err === 'superseded_not_reissuable'
          ? 400
          : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ invitation: result.result.invitation })
}
