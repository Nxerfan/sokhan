import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb } from '@/lib/db'
import { verifyInvitationToken, isExpired } from '@/lib/invitations'

/**
 * Invitation acceptance — for an EXISTING, AUTHENTICATED user (PR #11).
 *
 *   POST  /api/invitations/accept   body: { token }
 *
 * Flow:
 *   1. Caller is signed in (an existing user with a session). The session
 *      user's email MUST match the invitation's email — case-insensitive.
 *   2. Hash the raw token, look up the invitation (globalDb — public lookup
 *      by tokenHash).
 *   3. Validate: invitation exists; status='pending'; not expired;
 *      invitation.email === session.user.email (case-insensitive).
 *   4. In a transaction:
 *        a. Conditional update: SET status='accepted', acceptedAt,
 *           acceptedUserId WHERE id=invitation.id AND status='pending'.
 *           If 0 rows affected → a concurrent accept raced us → return
 *           'already_accepted' (idempotent outcome for the caller).
 *        b. Create Membership(status='active', role=invitation.role,
 *           tenantId=invitation.tenantId, userId=session.user.id). Catch
 *           P2002 (unique violation on userId+tenantId) — means the user is
 *           already a member → return 'already_member' (idempotent: the
 *           invitation is still marked accepted).
 *   5. Do NOT switch the session — just tell the client the new workspace
 *      is available. The client can call /api/auth/switch-workspace if it
 *      wants to enter the new workspace immediately.
 *
 * NEW-USER acceptance (where the email has no User account yet) goes
 * through a separate endpoint: /api/invitations/accept-complete (the
 * invitee first verifies email via OTP then sets a password — creating the
 * User row in the same transaction as the acceptance).
 */

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const rawToken = String(body?.token ?? '').trim()
  if (!rawToken) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400 })
  }

  const tokenHash = verifyInvitationToken(rawToken)
  const invitation = await globalDb.invitation.findUnique({
    where: { tokenHash },
    include: { tenant: { select: { id: true, name: true } } },
  })

  if (!invitation || !invitation.tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (invitation.status === 'accepted') {
    return NextResponse.json({ error: 'already_accepted' }, { status: 410 })
  }
  if (invitation.status === 'revoked') {
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
  const tenantId = invitation.tenantId
  const role = invitation.role
  const workspaceName = invitation.tenant.name

  // Transaction: conditional invitation update + membership create.
  // The conditional WHERE status='pending' guards against concurrent accepts.
  try {
    const result = await globalDb.$transaction(async (tx) => {
      // Conditional update — only succeeds if status is still 'pending'.
      const updated = await tx.invitation.updateMany({
        where: { id: invitation.id, status: 'pending' },
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

      // Try to create the membership. P2002 (unique violation on
      // userId+tenantId) means the user is already a member — that's fine,
      // the invitation is still marked accepted (idempotent).
      try {
        await tx.membership.create({
          data: { userId, tenantId, role, status: 'active' },
        })
      } catch (e: any) {
        if (e?.code === 'P2002') {
          return { raced: false as const, alreadyMember: true as const }
        }
        throw e
      }
      return { raced: false as const, alreadyMember: false as const }
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
  } catch (e) {
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
