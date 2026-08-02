import { NextResponse } from 'next/server'
import { withSessionTenant } from '@/lib/auth'
import { signToken, type AgentTokenPayload } from '@/lib/realtime-token'

/**
 * Returns a realtime token for the authenticated agent. The dashboard fetches
 * this on mount and passes it to the Socket.IO client for authentication.
 */
export async function GET() {
  const result = await withSessionTenant(async ({ session }) => {
    const payload: AgentTokenPayload = {
      type: 'agent',
      userId: session.user.id,
      tenantId: session.user.workspaceId!,
      role: session.user.role,
      name: session.user.name ?? undefined,
    }
    return signToken(payload)
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ token: result.result })
}
