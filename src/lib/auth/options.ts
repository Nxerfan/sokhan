import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { cookies } from 'next/headers'
import { globalDb } from '@/lib/db'
import '@/lib/env-check' // fails loudly if NEXTAUTH_SECRET is missing
import { SWITCH_COOKIE } from '@/lib/auth/cookies'

/**
 * NextAuth options (ADR-8 + PR #11). JWT sessions carry userId + email +
 * name + the active workspaceId + role.
 *
 * Active workspace resolution at sign-in:
 *   The `authorize` function picks the user's FIRST (by createdAt asc)
 *   ACTIVE membership as the sign-in workspace. Previously this query took
 *   ANY membership status (including 'invited' — which no longer exists
 *   after the PR #11 migration) and ordered by createdAt. The new query
 *   filters `status: 'active'` — a user with no active membership has no
 *   usable workspace and CANNOT sign in (the UI should offer them the
 *   invitation acceptance flow instead).
 *
 * Workspace switching (PR #11):
 *   The `jwt` callback looks for the `__sukhan_switch_target` cookie set by
 *   `/api/auth/switch-workspace`. If present, the callback re-verifies the
 *   active membership (defense-in-depth: the membership might have been
 *   revoked between the switch request and the next session access),
 *   updates `token.workspaceId` + `token.role` to the fresh DB values, and
 *   CLEARS the cookie so it is consumed exactly once. The database read
 *   goes through `globalDb` (NOT the fail-closed `db` proxy) because the
 *   jwt callback runs OUTSIDE any tenant context — verifying a cross-tenant
 *   membership is the whole point.
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The role in the JWT is always reconciled against the DB on the next
 *     session-access attempt that re-validates. (In the authz layer
 *     `withSessionTenant` replaces `session.user.role` with the fresh DB
 *     role, so even a stale JWT cannot grant authority beyond what the
 *     membership currently allows.)
 *   - The `__sukhan_switch_target` cookie is HttpOnly + SameSite=Lax and
 *     carries only a workspaceId (not a secret). Even if an attacker could
 *     set it, the membership re-verification would reject a workspace the
 *     user doesn't belong to, and the role would always be resolved from
 *     the DB.
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase()
        const password = credentials?.password
        if (!email || !password) return null

        // User lookup is global — not tenant-scoped. globalDb (NOT the
        // fail-closed db proxy) because the fail-closed proxy requires a
        // tenant context, but at sign-in we have none yet.
        const user = await globalDb.user.findUnique({
          where: { email },
          include: {
            memberships: {
              where: { status: 'active' },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        })
        if (!user || !user.passwordHash) return null

        const ok = await bcrypt.compare(password, user.passwordHash)
        if (!ok) return null

        // No active membership → no usable workspace → login fails. The user
        // must accept an invitation (or complete a new-user signup) to
        // obtain an active membership before they can sign in.
        const primary = user.memberships[0]
        if (!primary) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          workspaceId: primary.tenantId,
          role: primary.role,
          locale: user.locale,
        } as any
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Initial sign-in: stamp the token with the user + resolved workspace.
        token.uid = (user as any).id
        token.workspaceId = (user as any).workspaceId ?? null
        token.role = (user as any).role ?? 'agent'
      }

      // Workspace switch: consume the __sukhan_switch_target cookie if
      // present. The cookie is set by /api/auth/switch-workspace after it
      // has already verified the membership server-side. We re-verify here
      // (defense-in-depth) because time has passed (the client reloaded the
      // page) and the membership may have been revoked in the interim.
      try {
        // Next.js 15+: `cookies()` from `next/headers` returns a Promise.
        // The jwt callback is async, so awaiting it is fine. The cookie
        // access runs in the NextAuth Route Handler context (App Router
        // Route Handlers support read+write cookie access via next/headers).
        const cookieStore = await cookies()
        const switchTarget = cookieStore.get(SWITCH_COOKIE)?.value
        if (switchTarget && token.uid) {
          // globalDb: jwt callback runs OUTSIDE any tenant context.
          const m = await globalDb.membership.findUnique({
            where: {
              userId_tenantId: {
                userId: token.uid,
                tenantId: switchTarget,
              },
            },
            select: { role: true, status: true },
          })
          if (m?.status === 'active') {
            token.workspaceId = switchTarget
            token.role = m.role
          }
          // Clear the cookie so it is consumed exactly once. Setting
          // maxAge=0 deletes it on the outgoing response. Note: setting
          // cookies from inside the jwt callback is supported in App
          // Router Route Handler context (which is what NextAuth's
          // [...nextauth] handler runs in).
          cookieStore.set(SWITCH_COOKIE, '', {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
          })
        }
      } catch {
        // Cookie access can fail in some environments (e.g., edge runtime
        // before cookies are available). Silently ignore — the switch
        // cookie will simply not be consumed, and the user can retry.
      }

      return token
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).id = token.uid
        ;(session.user as any).workspaceId = token.workspaceId
        ;(session.user as any).role = token.role
      }
      return session
    },
  },
}

export type AppSession = {
  user: {
    id: string
    email: string
    name?: string | null
    workspaceId: string | null
    role: string
  }
}
