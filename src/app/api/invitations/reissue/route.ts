import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db, globalDb } from '@/lib/db'
import { canManageRole } from '@/lib/authz'
import {
  generateInvitationToken,
  invitationExpiryFromNow,
} from '@/lib/invitations'
import { acquireTenantSeatLock } from '@/lib/seat-lock'
import { PlanLimitExceededError } from '@/lib/payments/gating'
import { getPlan } from '@/lib/payments/plans'

/**
 * Invitation REISSUE (PR #11, BLOCKER 4 + BLOCKER 1 atomic single-winner).
 *
 *   POST  /api/invitations/reissue?id=<invitationId>
 *
 * Reissues an existing REVOKED invitation, producing a FRESH cryptographic
 * token + hash + expiry for the SAME email + role + tenant. The old
 * invitation row is marked `superseded`. The new invitation is `pending`.
 *
 * LIFECYCLE INVARIANT — exactly one valid link per reissue chain (#4)
 *   - ONLY `revoked` invitations may be reissued.
 *   - `superseded` rows CANNOT be reissued (rejected with
 *     `superseded_not_reissuable`).
 *   - To reissue a CURRENTLY-PENDING invitation: revoke it first, then
 *     reissue the revoked row.
 *
 * ATOMIC SINGLE-WINNER (BLOCKER 1)
 *   The conditional `revoked → superseded` claim + the new pending
 *   creation are in the SAME transaction. The claim uses
 *   `updateMany WHERE status='revoked'`; the winner gets `count=1` and
 *   proceeds to create the new pending invitation. A concurrent reissue
 *   of the SAME row gets `count=0` (the row is already `superseded`) →
 *   returns a deterministic `already_reissued` response WITHOUT creating
 *   anything. This guarantees exactly one new pending link per reissue
 *   chain, even under concurrency.
 *
 *   The plan-capacity check is ALSO inside the transaction (transactional),
 *   so two concurrent reissues for DIFFERENT revoked invitations cannot
 *   both pass a pre-transaction capacity check and overbook seats.
 *
 * SEAT COUNT
 *   Before: old is `revoked` → 0 seats. After: old is `superseded` (0) +
 *   new is `pending` (1). Net: +1 seat. The transactional plan-capacity
 *   re-check guards against overbooking.
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

    if (target.status === 'pending') {
      return { error: 'already_pending' as const }
    }
    if (target.status === 'accepted') {
      return { error: 'already_accepted' as const }
    }
    if (target.status === 'superseded') {
      return { error: 'superseded_not_reissuable' as const }
    }
    if (target.status !== 'revoked') {
      return { error: 'not_reissuable' as const }
    }

    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

    const { rawToken, tokenHash } = generateInvitationToken()
    const expiresAt = invitationExpiryFromNow()

    // Single transaction: conditional claim + transactional plan-capacity
    // re-check + new pending creation. The conditional claim's count
    // determines the winner (BLOCKER 1).
    let txResult: { raced: boolean; newId: string | null }
    try {
    txResult = await db.$transaction(async (tx) => {
      // (0) Acquire the per-tenant seat-capacity serialization lock
      // (FINAL BLOCKER fix). PostgreSQL `SELECT ... FOR UPDATE` on the
      // Tenant row — serializes ALL seat-increasing transactions for
      // this tenant (invitation create + reissue) across ALL app
      // instances, EVEN when they touch DIFFERENT Invitation rows. Two
      // concurrent reissues of two different revoked invitations both
      // block here; the second one's capacity count sees the first
      // one's committed pending invitation.
      await acquireTenantSeatLock(tx, tid)

      // (a) Conditional claim: revoked → superseded. Only the winner
      // gets count=1. A concurrent reissue of the SAME row gets count=0
      // (the row is already superseded) → returns 'raced' without
      // creating anything.
      const claimed = await tx.invitation.updateMany({
        where: { id: target.id, status: 'revoked' },
        data: { status: 'superseded', updatedAt: new Date() },
      })
      if (claimed.count === 0) {
        // Loser — another concurrent reissue already claimed this row.
        // Do NOT create anything. Return a deterministic race response.
        return { raced: true as const, newId: null as string | null }
      }

      // (b) TRANSACTIONAL plan-capacity re-check (BLOCKER 1). Two
      // concurrent reissues for DIFFERENT revoked invitations both
      // serialized by the tenant seat lock above — the second one's
      // count sees the first one's committed pending invitation. If
      // the cap would be exceeded, throw → the WHOLE transaction rolls
      // back (the claim is undone — the row reverts to 'revoked',
      // safely reissuable; no new pending is created).
      const now = new Date()
      const [activeCount, pendingCount] = await Promise.all([
        tx.membership.count({ where: { status: 'active' } }),
        tx.invitation.count({
          where: { status: 'pending', expiresAt: { gt: now } },
        }),
      ])
      const usage = activeCount + pendingCount
      // TEMPORARY DIAGNOSTIC (remove after verification):
      console.error(`[reissueTx] tenant=${tid.slice(-8)} usage=${usage} active=${activeCount} pending=${pendingCount} at=${new Date().toISOString()}`)
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
        // The new pending invitation would exceed the cap. Throw to
        // roll back the transaction (the claim is undone — the row
        // reverts to 'revoked', no new pending is created).
        throw new PlanLimitExceededError('agents', {
          allowed: false,
          current: usage,
          limit: limitValue,
          planSlug,
        })
      }

      // (c) Winner — create the new pending invitation.
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
      return { raced: false as const, newId: created.id as string | null }
    })
    } catch (e) {
      // Capacity-exceeded: the throw inside the transaction rolls the WHOLE
      // transaction back (lock released, claim undone — the row reverts to
      // 'revoked', safely reissuable). Convert to the planLimit response
      // (402) — previously this threw unhandled → 500 (latent bug found by
      // the D7 concurrent-reissue behavioral test).
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result } as const
      }
      throw e
    }

    if (txResult.raced) {
      return { raced: true as const } as const
    }

    const newId = txResult.newId!

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
  if ('raced' in result.result) {
    // Deterministic race response — a concurrent reissue already claimed
    // the row. NOT an error per se, but the caller did not win.
    return NextResponse.json(
      { error: 'already_reissued', message: 'Concurrent reissue raced — no new link created' },
      { status: 409 },
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
