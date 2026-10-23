import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db, globalDb } from '@/lib/db'
import '@/lib/env-check' // fails loudly if NEXTAUTH_SECRET is missing

/**
 * NextAuth options (ADR-8 + PR #11). JWT sessions carry userId + email +
 * name + the active workspaceId + role.
 *
 * Active workspace resolution at sign-in:
 *   The `authorize` function picks the user's FIRST (by createdAt asc)
 *   ACTIVE membership as the sign-in workspace. A user with no active
 *   membership has no usable workspace and CANNOT sign in.
 *
 * Workspace switching — NextAuth's SUPPORTED session/JWT update path:
 *   The client calls `useSession().update({ workspaceId })`. NextAuth
 *   POSTs to /api/auth/session, which triggers the `jwt` callback with
 *   `trigger === 'update'` and `session` = the update payload. The
 *   callback validates `token.uid`, queries the (userId, tenantId)
 *   Membership via globalDb (the jwt callback runs OUTSIDE any tenant
 *   context, and Membership is tenant-scoped — so `db.membership` would
 *   throw TenantContextRequiredError; globalDb is the correct unscoped
 *   client for this bootstrap-style lookup). The membership MUST be
 *   `active`. `token.workspaceId` + `token.role` are set from the DB
 *   membership ONLY — the client-supplied role is ignored. NextAuth
 *   then re-encodes the JWT and sets the session cookie with the
 *   correct dev/prod name + flags + expiration (we do NOT hand-roll
 *   the cookie contract). The client reloads after the update to clear
 *   tenant-bound state (Inbox, socket, etc.).
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - Client-supplied workspaceId is validated server-side against an
 *     ACTIVE membership before the token is mutated. An inactive /
 *     revoked membership cannot be switched to.
 *   - The role is ALWAYS read from the DB Membership, never from the
 *     client. A client cannot escalate its own role via the update
 *     payload.
 *   - Client-supplied role is ignored (only workspaceId is read from
 *     the payload; role comes from the DB).
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

        // db (not globalDb) — User is NOT a tenant-scoped model, so the
        // fail-closed proxy routes db.user to the base client without
        // requiring a tenant context. The memberships include is a SQL
        // JOIN, not a separate tenant-scoped query.
        const user = await db.user.findUnique({
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
    async jwt({ token, user, trigger, session: updatePayload }) {
      if (user) {
        // Initial sign-in — persist uid + workspaceId + role into the JWT.
        token.uid = (user as any).id
        token.workspaceId = (user as any).workspaceId ?? null
        token.role = (user as any).role ?? 'agent'
      }
      if (trigger === 'update' && updatePayload && (updatePayload as any).workspaceId) {
        // Workspace switch request from useSession().update({ workspaceId }).
        // Validate the requested workspaceId against an ACTIVE membership —
        // globalDb (the jwt callback runs outside any tenant context, and
        // Membership is tenant-scoped so db.membership would throw).
        const uid = token.uid as string | undefined
        if (!uid) {
          throw new Error('no_uid_in_token')
        }
        const requestedWorkspaceId = String((updatePayload as any).workspaceId)
        const membership = await globalDb.membership.findUnique({
          where: {
            userId_tenantId: { userId: uid, tenantId: requestedWorkspaceId },
          },
          select: { role: true, status: true },
        })
        if (!membership || membership.status !== 'active') {
          // Not an active member of the target workspace — reject the
          // switch. Throwing here causes NextAuth's session endpoint to
          // return an error, which useSession().update() surfaces to the
          // client (the token is left unchanged, so no switch occurs).
          throw new Error('not_active_member')
        }
        // Set workspaceId + role from the DB. Client-supplied role is
        // IGNORED — only workspaceId is read from the payload.
        token.workspaceId = requestedWorkspaceId
        token.role = membership.role
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
