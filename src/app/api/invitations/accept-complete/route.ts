import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { globalDb, withTenant, db, getCurrentTenantId } from '@/lib/db'
import { verifyInvitationToken, isExpired } from '@/lib/invitations'
import { PlanLimitExceededError } from '@/lib/payments/gating'
import { getPlan } from '@/lib/payments/plans'

/**
 * Invitation acceptance — NEW USER flow (PR #11).
 *
 *   POST  /api/invitations/accept-complete
 *         body: { workspace, email, requestId, password, token }
 *
 * Used when the invitee has NO existing user account. The invitee first
 * verifies their email ownership via the existing OTP infrastructure
 * (POST /api/auth/signup/start → POST /api/auth/signup/verify), then sets a
 * password via this endpoint.
 *
 * This endpoint is the counterpart to POST /api/auth/signup/complete for
 * invitation-acceptance. The difference:
 *   - signup/complete: create a NEW Tenant + User + owner Membership +
 *     WidgetConfig (a fresh workspace).
 *   - accept-complete: create ONLY a User + non-owner Membership in the
 *     INVITATION's existing tenant + mark the invitation as accepted. The
 *     tenant + its WidgetConfig already exist; the invitee becomes a member
 *     of an existing workspace at the role specified in the invitation.
 *
 * FLOW
 * ----
 *   1. Resolve the workspace slug → tenantId via a GLOBAL Tenant lookup
 *      (BLOCKER 2 — establish tenant context BEFORE any tenant-scoped read).
 *   2. Look up the OTP request by (requestId, email, purpose='signup').
 *      Must be verified=true. The OTP serves as proof that the invitee
 *      controls the invitation email.
 *   3. Reject if the email is already a registered user → the invitee
 *      should have used the authenticated accept flow instead.
 *   4. Enter withTenant(tenantId), hash the raw invitation token, look up
 *      the Invitation via the fail-closed `db` proxy (the extension
 *      injects tenantId → effective query `WHERE tokenHash = $1 AND
 *      tenantId = $2`). A token issued for a different tenant → 404.
 *   5. Validate: invitation exists; status='pending'; not expired;
 *      invitation.email === email (case-insensitive).
 *   6. TRANSACTIONAL plan-limit re-check (BLOCKER 3) inside the
 *      acceptance transaction — same as /api/invitations/accept.
 *   7. Atomically, in a transaction:
 *        a. Create the User (passwordHash, emailVerified=true, locale='fa').
 *        b. Conditional update invitation: SET status='accepted',
 *           acceptedAt=now, acceptedUserId=user.id WHERE id=invitation.id
 *           AND status='pending'. If 0 rows affected → concurrent accept
 *           raced us → return 'already_accepted' (the User creation is
 *           rolled back, no harm done).
 *        c. Create Membership(status='active', role=invitation.role,
 *           tenantId=invitation.tenantId, userId=user.id). Catch P2002
 *           (unique violation on userId+tenantId) → return 'already_member'
 *           (the User row is rolled back since it was created in the same
 *           transaction).
 *   8. Cleanup: delete the PendingSignup + OtpRequest rows for this email.
 *   9. Return `{ ok: true, workspaceId, workspaceName }` — the client then
 *      calls signIn('credentials', { email, password }) to obtain a
 *      session.
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The raw invitation token is NEVER logged. If a transaction fails,
 *     only the tokenHash (a SHA-256 digest) is logged — never the raw token.
 *   - Email ownership is enforced two ways: (a) the OTP flow proves the
 *     invitee controls the inbox, (b) invitation.email === verified email
 *     proves the right inbox was verified. An attacker who steals an
 *     invitation link but cannot receive email at that address cannot
 *     accept it.
 *   - The new user is created with the emailVerified flag set true, since
 *     the OTP step has already verified the address.
 *   - No new owner Tenant is created — the invitee joins an EXISTING
 *     workspace as a non-owner member at the invitation's role.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const slug = String(body?.workspace ?? '').trim()
  const email = String(body?.email ?? '').trim().toLowerCase()
  const requestId = String(body?.requestId ?? '').trim()
  const password = String(body?.password ?? '')
  const rawToken = String(body?.token ?? '').trim()

  if (!slug || !email || !requestId || !password || !rawToken) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Resolve the public tenant slug → tenantId. Tenant is a GLOBAL model.
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const tenantId = tenant.id
  const workspaceName = tenant.name

  // 1. Verify the OTP was verified (purpose='signup' — reuses the existing
  // signup OTP flow so the invitee doesn't have to learn a new OTP channel).
  const otpReq = await globalDb.otpRequest.findFirst({
    where: { requestId, email, purpose: 'signup' },
  })
  if (!otpReq) {
    return NextResponse.json({ error: 'otp_not_verified' }, { status: 403 })
  }
  if (!otpReq.verified) {
    return NextResponse.json({ error: 'otp_not_verified' }, { status: 403 })
  }

  // 2. Reject if email already registered — the user should use the
  // authenticated accept flow instead.
  const existing = await globalDb.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json({ error: 'email_already_registered' }, { status: 409 })
  }

  // 3. Look up the invitation INSIDE the tenant context. The fail-closed
  //    extension injects tenantId into the where clause, so the effective
  //    query is `WHERE tokenHash = $1 AND tenantId = $2`. A token issued
  //    for a different tenant → 404 (BLOCKER 2).
  const tokenHash = verifyInvitationToken(rawToken)
  const invitation = await withTenant(tenantId, () =>
    db.invitation.findUnique({ where: { tokenHash } }),
  )

  // 4. Validate invitation state + email ownership.
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
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (isExpired(invitation)) {
    return NextResponse.json({ error: 'expired' }, { status: 410 })
  }
  // The verified OTP email MUST match the invitation email. This proves the
  // invitee controls the inbox that the invitation was sent to.
  if (invitation.email.toLowerCase() !== email) {
    return NextResponse.json({ error: 'email_mismatch' }, { status: 403 })
  }

  // 5. Atomic transaction: create user + accept invitation + create membership.
  const passwordHash = await bcrypt.hash(password, 10)
  const role = invitation.role
  const invitationId = invitation.id

  try {
    const result = await withTenant(tenantId, async () => {
      const tid = getCurrentTenantId()!
      return db.$transaction(async (tx) => {
        // (BLOCKER 3) TRANSACTIONAL plan-limit re-check — same as
        // /api/invitations/accept. The new-user accept converts a
        // pending seat into an active seat (total usage unchanged);
        // the re-check guards against a plan downgrade that lowered
        // the cap below the current usage AFTER the invitation was
        // created. Count + cap resolution BOTH on `tx` → consistent.
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

        // (a) Create the user. Email-verified=true because the OTP flow
        // already proved ownership.
        const user = await tx.user.create({
          data: {
            email,
            name: email.split('@')[0],
            passwordHash,
            locale: 'fa',
            hasUsedFreeTrial: false,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        })

        // (b) Conditional invitation update — WHERE status='pending' guards
        // against concurrent accepts. If a concurrent accept raced us, the
        // User creation above is rolled back by the transaction.
        const updated = await tx.invitation.updateMany({
          where: { id: invitationId, status: 'pending' },
          data: {
            status: 'accepted',
            acceptedAt: new Date(),
            acceptedUserId: user.id,
          },
        })
        if (updated.count === 0) {
          // Someone accepted first — signal to the caller; the tx will roll
          // back the user creation (no orphan User).
          return { raced: true as const, alreadyMember: false as const }
        }

        // (c) Create the membership. P2002 means the user is already a member
        // of this workspace — return idempotent 'already_member'; the tx will
        // roll back the User creation.
        try {
          await tx.membership.create({
            data: {
              userId: user.id,
              tenantId,
              role,
              status: 'active',
            },
          })
        } catch (e: any) {
          if (e?.code === 'P2002') {
            return { raced: false as const, alreadyMember: true as const }
          }
          throw e
        }

        // Cleanup the OTP + PendingSignup rows for this email.
        await tx.pendingSignup.deleteMany({ where: { email } })
        await tx.otpRequest.deleteMany({ where: { requestId } })

        return { raced: false as const, alreadyMember: false as const }
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
        error: 'already_member',
        workspaceId: tenantId,
        workspaceName,
      }, { status: 409 })
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
    console.error('[invitations/accept-complete] transaction failed', {
      component: 'invitations',
      route: '/api/invitations/accept-complete',
      errorName: e instanceof Error ? e.name : 'unknown',
      // NEVER log the raw token. The tokenHash is a SHA-256 digest — safe.
      tokenHash,
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
