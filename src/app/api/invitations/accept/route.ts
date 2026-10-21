import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb, withTenant, db, getCurrentTenantId } from '@/lib/db'
import { verifyInvitationToken, isExpired } from '@/lib/invitations'
import { PlanLimitExceededError } from '@/lib/payments/gating'
import { getPlan } from '@/lib/payments/plans'

/**
 * Invitation acceptance — for an EXISTING, AUTHENTICATED user (PR #11).
 *
 *   POST  /api/invitations/accept   body: { workspace, token }
 *
 * Flow:
 *   1. Caller is signed in (an existing user with a session). The session
 *      user's email MUST match the invitation's email — case-insensitive.
 *   2. Resolve the workspace slug → tenantId via a GLOBAL Tenant lookup
 *      (Tenant is a global model — globalDb is correct). This establishes
 *      tenant context BEFORE any tenant-scoped read (BLOCKER 2).
 *   3. Enter withTenant(tenantId), hash the raw token, look up the
 *      invitation via the fail-closed `db` proxy (the extension injects
 *      `tenantId` into the where clause, so the effective query is
 *      `WHERE tokenHash = $1 AND tenantId = $2`). A token issued for a
 *      different tenant will not match → 404.
 *   4. Validate: invitation exists; status='pending'; not expired;
 *      invitation.email === session.user.email (case-insensitive).
 *   5. TRANSACTIONAL plan-limit re-check (BLOCKER 3): inside the
 *      acceptance transaction, re-count active memberships + unexpired
 *      pending invitations against the plan cap. This protects against
 *      plan downgrades / races between create-time and accept-time. If
 *      the seat would be over-allocated, the transaction rolls back.
 *   6. In the same transaction:
 *        a. Conditional update: SET status='accepted', acceptedAt,
 *           acceptedUserId WHERE id=invitation.id AND status='pending'.
 *           If 0 rows affected → a concurrent accept raced us → return
 *           'already_accepted' (idempotent outcome for the caller).
 *        b. Create Membership(status='active', role=invitation.role,
 *           tenantId=invitation.tenantId, userId=session.user.id). Catch
 *           P2002 (unique violation on userId+tenantId) — means the user is
 *           already a member → return 'already_member' (idempotent: the
 *           invitation is still marked accepted).
 *   7. Do NOT switch the session — just tell the client the new workspace
 *      is available. The client calls useSession().update({ workspaceId })
 *      to switch (the jwt callback's trigger==='update' path).
 *
 * NEW-USER acceptance (where the email has no User account yet) goes
 * through a separate endpoint: /api/invitations/accept-complete.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const slug = String(body?.workspace ?? '').trim()
  const rawToken = String(body?.token ?? '').trim()
  if (!slug || !rawToken) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Resolve the public tenant slug → tenantId. Tenant is a GLOBAL model.
  // If the slug doesn't resolve, return 404 (same as every other failure).
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const tenantId = tenant.id
  const workspaceName = tenant.name

  const tokenHash = verifyInvitationToken(rawToken)

  // Look up the invitation INSIDE the tenant context. The fail-closed
  // extension injects tenantId into the where clause, so the effective
  // query is `WHERE tokenHash = $1 AND tenantId = $2`.
  const invitation = await withTenant(tenantId, () =>
    db.invitation.findUnique({ where: { tokenHash } }),
  )

  if (!invitation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (invitation.status === 'accepted') {
    return NextResponse.json({ error: 'already_accepted' }, { status: 410 })
  }
  if (invitation.status === 'revoked' || invitation.status === 'superseded') {
    return NextResponse.json({ error: 'revoked' }, { status: 410 })
  }
  if (invitation.status !== 'pending') {
    // Unknown status — treat as not found (no information leak).
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (isExpired(invitation)) {
    return NextResponse.json({ error: 'expired' }, { status: 410 })
  }
  // Email ownership check: the session user's email must match the invitation.
  if (
    invitation.email.toLowerCase() !== String(session.user.email).toLowerCase()
  ) {
    return NextResponse.json({ error: 'email_mismatch' }, { status: 403 })
  }

  const userId = session.user.id
  const role = invitation.role
  const invitationId = invitation.id

  // Transaction: transactional plan-limit re-check + conditional
  // invitation update + membership create. The conditional WHERE
  // status='pending' guards against concurrent accepts.
  try {
    const result = await withTenant(tenantId, async () => {
      const tid = getCurrentTenantId()!
      return db.$transaction(async (tx) => {
        // (BLOCKER 3) TRANSACTIONAL plan-limit re-check.
        // This protects against plan downgrades / races between the
        // create-time check and the accept-time check. The seat count
        // is: active memberships + unexpired pending invitations. The
        // current invitation is still 'pending' at this point, so it
        // already counts toward the usage — we are converting a pending
        // seat into an active seat, not adding a new seat. The re-check
        // guards against a plan downgrade that lowered the cap below
        // the current usage AFTER the invitation was created.
        //
        // The count + the cap resolution BOTH run on `tx` so they are
        // transactionally consistent with the membership create (a
        // concurrent plan downgrade cannot slip in between the count
        // and the create). Subscription is tenant-scoped → the
        // extension injects tenantId. Tenant is global → passthrough.
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
        if (limitValue !== -1 && usage > limitValue) {
          throw new PlanLimitExceededError('agents', {
            allowed: false,
            current: usage,
            limit: limitValue,
            planSlug,
          })
        }

        // Conditional update — only succeeds if status is still 'pending'.
        const updated = await tx.invitation.updateMany({
          where: { id: invitationId, status: 'pending' },
          data: {
            status: 'accepted',
            acceptedAt: new Date(),
            acceptedUserId: userId,
          },
        })
        if (updated.count === 0) {
          // Someone else accepted first — return idempotent outcome.
          return { raced: true as const, alreadyMember: false as const }
        }

        // Create OR REACTIVATE the membership (BLOCKER 2 fix).
        // First, check if a Membership already exists (may be 'revoked'
        // — the user was previously a member, got revoked, and is now
        // re-accepting a fresh invitation). If so, REACTIVATE it: set
        // status='active' + role to the invitation's role. The invitation
        // acceptance + membership activation are atomic (same tx); if
        // activation cannot complete, the tx rolls back (the invitation
        // is NOT marked accepted).
        //
        // The updateMany uses `id` (the PK) in the where — matching the
        // existing PATCH /api/members pattern. The fail-closed extension
        // injects tenantId into the where (defense-in-depth).
        const existing = await tx.membership.findFirst({
          where: { userId },
          select: { id: true, status: true },
        })
        let alreadyMember = false
        if (existing) {
          // Membership exists (revoked or active). Reactivate it.
          alreadyMember = existing.status === 'active'
          await tx.membership.updateMany({
            where: { id: existing.id },
            data: { status: 'active', role, updatedAt: new Date() },
          })
        } else {
          // No membership — create one. Catch P2002 for the race where
          // a concurrent accept (of a DIFFERENT invitation for the same
          // user) created the membership between our findFirst + create.
          try {
            await tx.membership.create({
              data: { userId, tenantId, role, status: 'active' },
            })
          } catch (e: any) {
            if (e?.code !== 'P2002') throw e
            // Concurrent accept created the membership. Find + reactivate.
            const raced = await tx.membership.findFirst({
              where: { userId },
              select: { id: true, status: true },
            })
            alreadyMember = raced?.status === 'active'
            if (raced) {
              await tx.membership.updateMany({
                where: { id: raced.id },
                data: { status: 'active', role, updatedAt: new Date() },
              })
            }
          }
        }
        return { raced: false as const, alreadyMember: alreadyMember }
      })
    })

    if (result.raced) {
      return NextResponse.json(
        { error: 'already_accepted', workspaceId: tenantId, workspaceName },
        { status: 410 },
      )
    }
    if (result.alreadyMember) {
      return NextResponse.json({
        ok: true,
        workspaceId: tenantId,
        workspaceName,
        alreadyMember: true,
      })
    }
    return NextResponse.json({ ok: true, workspaceId: tenantId, workspaceName })
  } catch (e: any) {
    if (e instanceof PlanLimitExceededError) {
      return NextResponse.json(
        {
          error: 'plan_limit_exceeded',
          limit: 'agents',
          current: e.result.current,
          max: e.result.limit,
          plan: e.result.planSlug,
        },
        { status: 402 },
      )
    }
    console.error('[invitations/accept] transaction failed', {
      component: 'invitations',
      route: '/api/invitations/accept',
      errorName: e instanceof Error ? e.name : 'unknown',
      // NEVER log the raw token. Only the hash (already a digest) is safe.
      tokenHash,
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
