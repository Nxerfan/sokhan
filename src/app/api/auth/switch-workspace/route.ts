import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb } from '@/lib/db'

/**
 * Workspace switch VALIDATION (PR #11, BLOCKER: workspace-switch hardening).
 *
 *   POST  /api/auth/switch-workspace   body: { workspaceId }
 *
 * This route is a THIN VALIDATION endpoint. It validates that the
 * requested workspaceId corresponds to an ACTIVE membership for the
 * session user, and returns `{ ok, workspaceId, role }` or 403.
 *
 * It does NOT encode a JWT or set the session cookie — that is now done
 * via NextAuth's SUPPORTED session/JWT update path:
 *
 *   client → useSession().update({ workspaceId })
 *          → POST /api/auth/session
 *          → jwt callback (trigger === 'update')
 *          → validates active membership via globalDb
 *          → sets token.workspaceId + token.role from the DB
 *          → NextAuth re-encodes the JWT + sets the session cookie with
 *            the correct dev/prod cookie name + flags + expiration
 *            (we do NOT hand-roll the cookie contract).
 *
 * Callers MAY call this route first for a fast server-side validation
 * before calling useSession().update(), but it is NOT required — the
 * jwt callback re-validates the membership independently, so a caller
 * that calls useSession().update() directly is still safe.
 *
 * SECURITY
 * --------
 *   - Client-supplied workspaceId is validated against an ACTIVE DB
 *     membership — never trusted directly.
 *   - The role returned is ALWAYS read from the DB Membership, never
 *     from the client.
 *   - A revoked / inactive membership is rejected with 403
 *     `not_active_member`.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const workspaceId = String(body?.workspaceId ?? '').trim()
  if (!workspaceId) {
    return NextResponse.json({ error: 'missing_workspace_id' }, { status: 400 })
  }

  // Validate active membership — globalDb (Membership is tenant-scoped,
  // and this route runs OUTSIDE any tenant context — the session user's
  // CURRENT tenant may be a different one than the target workspace).
  // globalDb is the unscoped client appropriate for this cross-tenant
  // membership lookup.
  const membership = await globalDb.membership.findUnique({
    where: { userId_tenantId: { userId: session.user.id, tenantId: workspaceId } },
    select: { role: true, status: true },
  })
  if (!membership) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (membership.status !== 'active') {
    return NextResponse.json({ error: 'not_active_member' }, { status: 403 })
  }

  // Validation passed. The client now calls useSession().update({ workspaceId })
  // to perform the actual session/JWT mutation via NextAuth's supported path.
  return NextResponse.json({
    ok: true,
    workspaceId,
    role: membership.role,
  })
}
