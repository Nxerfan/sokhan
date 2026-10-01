import { getServerSession } from 'next-auth'
import { authOptions } from './options'
import { db, withTenant, getCurrentTenantId, hasRole, ROLE_RANK } from '@/lib/db'
export interface TypedSession {
  user: { id: string; email: string; name?: string | null; workspaceId: string; role: string }
  expires: string
}
export async function withSessionTenant<T>(
  fn: (ctx: { session: TypedSession }) => Promise<T>,
): Promise<{ session: TypedSession; result: T } | null> {
  const session = await getServerSession(authOptions) as TypedSession | null
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
