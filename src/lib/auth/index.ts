import { getServerSession } from 'next-auth'
import { authOptions } from './options'
import { db, withTenant, getCurrentTenantId, hasRole, ROLE_RANK } from '@/lib/db'

/**
 * Resolve the authenticated session + active membership, and run `fn` inside
 * a tenant-scoped DB context. Returns null when unauthenticated or when the
 * user has no membership in the active workspace. The session is passed to
 * `fn` so handlers can do role checks without a second getServerSession call.
 */
export async function withSessionTenant<T>(
  fn: (ctx: { session: NonNullable<Awaited<ReturnType<typeof getServerSession>>> }) => Promise<T>,
): Promise<{ session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>; result: T } | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.workspaceId) return null

  const membership = await db.membership.findFirst({
    where: { userId: session.user.id, tenantId: session.user.workspaceId },
  })
  if (!membership) return null

  return withTenant(session.user.workspaceId, async () => {
    const result = await fn({ session })
    return { session, result }
  })
}

export { authOptions, getServerSession, getCurrentTenantId, hasRole, ROLE_RANK }
