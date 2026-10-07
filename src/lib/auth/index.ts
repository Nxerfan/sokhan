import { getServerSession } from 'next-auth'
import { authOptions } from './options'
import { db, withTenant, getCurrentTenantId, hasRole, ROLE_RANK } from '@/lib/db'

export interface TypedSession {
  user: {
    id: string
    email: string
    name?: string | null
    workspaceId: string
    role: string
  }
  expires: string
}

/**
 * Resolve the session for the current request and run `fn` inside the
 * tenant context.
 *
 * Security: the effective role is ALWAYS read from the CURRENT Membership
 * row in the database — never from the stale JWT `session.user.role`. This
 * ensures that a downgraded or revoked user loses access immediately,
 * without waiting for the JWT to expire.
 *
 * Returns `null` if:
 *   - no session / no workspaceId
 *   - membership not found
 *   - membership.status !== 'active'
 *
 * The `session` passed to `fn` has `user.role` replaced with the fresh DB
 * role so that downstream `hasRole()` calls authorise against the current
 * authority, not the JWT-stored one.
 */
export async function withSessionTenant<T>(
  fn: (ctx: { session: TypedSession }) => Promise<T>,
): Promise<{ session: TypedSession; result: T } | null> {
  const session = await getServerSession(authOptions) as TypedSession | null
  if (!session?.user?.workspaceId) return null
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id, tenantId: session.user.workspaceId },
  })
  if (!membership) return null
  if (membership.status !== 'active') return null

  // Replace the stale JWT role with the fresh DB role.
  const freshSession: TypedSession = {
    ...session,
    user: { ...session.user, role: membership.role },
  }

  return withTenant(session.user.workspaceId, async () => {
    const result = await fn({ session: freshSession })
    return { session: freshSession, result }
  })
}

export { authOptions, getServerSession, getCurrentTenantId, hasRole, ROLE_RANK }
