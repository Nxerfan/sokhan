import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'
import { globalDb } from '@/lib/db'
import {
  SWITCH_COOKIE,
  SWITCH_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/auth/cookies'

/**
 * Workspace switching (PR #11).
 *
 *   POST  /api/auth/switch-workspace   body: { workspaceId }
 *
 * Switches the active workspace (tenant) for the current user. The session
 * user MUST have an ACTIVE membership in the target workspace — verified
 * server-side, NEVER from the client request body.
 *
 * SESSION UPDATE MODEL — COOKIE + JWT CALLBACK
 * --------------------------------------------
 * NextAuth v4's session token is a JWT encoded with NEXTAUTH_SECRET. The
 * supported way to update the JWT server-side is via the `jwt` callback:
 * the callback runs on every session access (every `getServerSession`,
 * every `/api/auth/session` call). So this route:
 *
 *   1. Verifies the session + active membership server-side (using
 *      `globalDb` — this is NOT a tenant-scoped read; we have to verify
 *      across the OLD workspace boundary, so the fail-closed per-tenant
 *      `db` proxy is useless here).
 *   2. Resolves the fresh role from the DB membership (NEVER from the
 *      client).
 *   3. Sets a SHORT-LIVED HttpOnly + SameSite cookie
 *      `__sukhan_switch_target=<workspaceId>`. Max-age is 60 seconds —
 *      only long enough for the next page load to trigger the jwt callback
 *      and consume it.
 *   4. Returns `{ ok: true, workspaceId, role }`. The client reloads the
 *      page (e.g., `window.location.reload()` or `router.refresh()`).
 *
 *   5. On the next session access (the page reload), the NextAuth `jwt`
 *      callback (in `src/lib/auth/options.ts`) sees the cookie, verifies
 *      the active membership again (defense-in-depth — the membership might
 *      have been revoked between the switch request and the reload),
 *      updates `token.workspaceId` + `token.role`, and CLEARS the cookie
 *      so it's consumed exactly once.
 *
 * This is the cleanest server-side session-update path for NextAuth v4.
 * Alternatives considered:
 *   - `unstable_update` from `next-auth/react` — client-side only.
 *   - Manually `jwt.encode` + cookie.set the NextAuth session cookie —
 *     fragile because the cookie name depends on `useSecureCookies` /
 *     `__Secure-` prefix and is not exported from the NextAuth public API.
 *
 * SECURITY
 * --------
 *   - The switch cookie is HttpOnly + SameSite=Lax → not readable by JS,
 *     not sent on cross-site requests.
 *   - The cookie carries a workspaceId, which is not a secret — an attacker
 *     who can set cookies can switch the user's view, but cannot escalate
 *     privileges: the jwt callback re-verifies the active membership +
 *     reads the role from the DB, so the token will only ever hold a role
 *     the user actually has in that workspace.
 *   - The cookie is consumed within one session-access cycle and cleared.
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

  // Verify active membership in the target workspace — globalDb (NOT the
  // fail-closed db proxy). The proxy is scoped to the CURRENT session's
  // tenantId, which is the OLD workspace, not the new one we want to verify
  // against. This read is filtered by userId+tenantId, so it returns only
  // this user's membership — no cross-tenant data leak.
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

  // Resolve the fresh role — NEVER trust the client. The jwt callback will
  // re-resolve it from the DB on the next session access too.
  const res = NextResponse.json({
    ok: true,
    workspaceId,
    role: membership.role,
  })

  // Set the short-lived switch cookie. HttpOnly + SameSite=Lax + Secure
  // (in production) — the cookie cannot be read by client-side JS, cannot
  // be sent cross-site. MaxAge=60s: just enough for the next page reload
  // to trigger the jwt callback.
  res.cookies.set(SWITCH_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SWITCH_COOKIE_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  })

  return res
}


