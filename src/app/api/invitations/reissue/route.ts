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
 *   - `superseded` rows CANNOT be reissued (rejected with 409
 *     `already_reissued` — the SAME deterministic result as a concurrent
 *     reissue race loser, so the public contract is timing-independent).
 *   - To reissue a CURRENTLY-PENDING invitation: revoke it first, then
 *     reissue the revoked row.
 *
 * ATOMIC SINGLE-WINNER (BLOCKER 1)
 *   The conditional `revoked → superseded` claim + the new pending
 *   creation are in the SAME transaction. The claim uses
 *   `updateMany WHERE status='revoked'`; the winner gets `count=1` and
 *   proceeds to create the new pending invitation. A concurrent reissue
 *   of the SAME row gets `count=0` (the row is already `superseded`) →
 *   returns a deterministic `already_reissued` (409) response WITHOUT
 *   creating anything. The pre-transaction `superseded` classification
 *   ALSO returns `already_reissued` (409), so BOTH timing paths (initial
 *   read observes superseded; conditional claim loses) produce the SAME
 *   public result — the contract is timing-independent. This guarantees
 *   exactly one new pending link per reissue chain, even under concurrency.
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
      // DETERMINISTIC CONTRACT (PR #13 stability): a request to reissue an
      // already-superseded invitation returns 409 `already_reissued` — the
      // SAME result as the concurrent-race loser path below (conditional
      // claim count=0). This eliminates the pre-transaction-read timing
      // dependence: whether the loser's initial read observes `superseded`
      // (this branch) OR the loser's conditional claim loses inside the
      // transaction (the `raced` branch), the public result is identical.
      return { error: 'already_reissued' as const }
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
      // (402).
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
  if ('planLimit' in result.result) {
    // Capacity-exceeded (serialized loser) → 402. THIS BRANCH WAS MISSING —
    // the { planLimit } result previously fell through every branch to
    // `return { invitation: undefined }` → HTTP 200 with an empty body
    // (the phantom 200 observed by the D7 concurrent-reissue test).
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
        : err === 'already_reissued'
          ? 409
          : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ invitation: result.result.invitation })
}
