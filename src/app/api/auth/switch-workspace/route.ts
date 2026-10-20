import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb } from '@/lib/db'
import { encode as jwtEncode } from 'next-auth/jwt'
import { getAuthSecret } from '@/lib/env-check'

/**
 * Workspace switching (PR #11).
 *
 *   POST  /api/auth/switch-workspace   body: { workspaceId }
 *
 * Switches the active workspace (tenant) for the current user. The session
 * user MUST have an ACTIVE membership in the target workspace — verified
 * server-side, NEVER from the client request body.
 *
 * SESSION UPDATE MODEL — manual JWT re-encode
 * -------------------------------------------
 * NextAuth v4's JWT session cookie is encoded with NEXTAUTH_SECRET. We
 * manually encode a new JWT with the updated workspaceId + role and set
 * the session cookie directly. This is the cleanest server-side path
 * for NextAuth v4 (unstable_update is client-only).
 *
 * The client should reload the page after receiving the success response
 * to ensure all tenant-bound state (Inbox, socket, etc.) is refreshed.
 *
 * SECURITY
 * --------
 *   - Client-supplied workspaceId is NEVER trusted directly — we verify
 *     the membership from the DB.
 *   - The role is ALWAYS read from the DB Membership, never from the client.
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

  // Verify active membership — globalDb (NOT fail-closed db proxy).
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

  // Manually encode a new JWT with the updated workspace + role.
  // The new token carries the same uid + email but a different
  // workspaceId + role (resolved from the DB, not the client).
  const newToken = {
    uid: session.user.id,
    email: session.user.email,
    name: session.user.name,
    workspaceId,
    role: membership.role,
  }

  const secret = getAuthSecret()
  const encoded = await jwtEncode({
    token: newToken,
    secret,
    salt: 'next-auth.session-token',
    maxAge: 30 * 24 * 60 * 60, // 30 days — matches NextAuth default
  })

  const res = NextResponse.json({
    ok: true,
    workspaceId,
    role: membership.role,
  })

  // Set the NextAuth session cookie with the new JWT.
  // The cookie name follows NextAuth v4 conventions:
  //   - development: __Secure-next-auth.session-token is NOT used;
  //     the name is 'next-auth.session-token' when not using secure cookies.
  //   - production (HTTPS): '__Secure-next-auth.session-token'
  // We match the same logic NextAuth uses internally.
  const cookieName = process.env.NODE_ENV === 'production'
    ? '__Secure-next-auth.session-token'
    : 'next-auth.session-token'

  res.cookies.set(cookieName, encoded, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    secure: process.env.NODE_ENV === 'production',
  })

  return res
}
