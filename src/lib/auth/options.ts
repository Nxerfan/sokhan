import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
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
 * Workspace switching (PR #11):
 *   The switch-workspace API route manually encodes a new JWT using
 *   next-auth/jwt's encode() and sets the session cookie directly.
 *   The client reloads the page after the switch.
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The role in the JWT is always reconciled against the DB on the next
 *     session-access attempt that re-validates. (In the authz layer
 *     `withSessionTenant` replaces `session.user.role` with the fresh DB
 *     role, so even a stale JWT cannot grant authority beyond what the
 *     membership currently allows.)
 *   - Client-supplied workspaceId/role are NEVER trusted.
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
    async jwt({ token, user }) {
      if (user) {
        token.uid = (user as any).id
        token.workspaceId = (user as any).workspaceId ?? null
        token.role = (user as any).role ?? 'agent'
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
