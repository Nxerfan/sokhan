import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'

/**
 * NextAuth options (ADR-8). JWT sessions carry userId + email + name + the
 * active workspaceId + role. The active workspace is resolved at sign-in from
 * the user's first/owner membership; it can be switched later via the
 * /api/auth/switch-workspace endpoint (Module 2).
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
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        })
        if (!user || !user.passwordHash) return null

        const ok = await bcrypt.compare(password, user.passwordHash)
        if (!ok) return null

        const primary = user.memberships[0]
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          workspaceId: primary?.tenantId ?? null,
          role: primary?.role ?? 'agent',
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
