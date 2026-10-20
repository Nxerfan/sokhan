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
 * Workspace switching (PR #11):
 *   The switch-workspace API route uses NextAuth's `unstable_update`
 *   mechanism to trigger the jwt callback with `trigger='update'` +
 *   `session={ workspaceId }`. The jwt callback re-verifies the active
 *   membership (defense-in-depth) and updates the token.
 *
 * SECURITY INVARIANTS
 * -------------------
 *   - The role in the JWT is always reconciled against the DB on the next
 *     session-access attempt that re-validates. (In the authz layer
 *     `withSessionTenant` replaces `session.user.role` with the fresh DB
 *     role, so even a stale JWT cannot grant authority beyond what the
 *     membership currently allows.)
 *   - Client-supplied workspaceId/role are NEVER trusted — the jwt
 *     callback always re-resolves the role from the DB Membership.
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
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = (user as any).id
        token.workspaceId = (user as any).workspaceId ?? null
        token.role = (user as any).role ?? 'agent'
      }

      // Workspace switch via NextAuth's `update` trigger. The
      // switch-workspace API route calls `unstable_update()` with
      // `{ workspaceId }`, which triggers this callback with
      // `trigger='update'` + `session={ workspaceId }`.
      if (trigger === 'update' && session) {
        const newWorkspaceId = (session as any).workspaceId
        if (newWorkspaceId && token.uid) {
          const m = await globalDb.membership.findUnique({
            where: {
              userId_tenantId: {
                userId: token.uid,
                tenantId: newWorkspaceId,
              },
            },
            select: { role: true, status: true },
          })
          if (m?.status === 'active') {
            token.workspaceId = newWorkspaceId
            token.role = m.role
          }
        }
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
