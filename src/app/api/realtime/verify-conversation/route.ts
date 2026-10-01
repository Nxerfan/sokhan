import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthSecret } from '@/lib/env-check'

/**
 * Internal endpoint for the Docker realtime service to verify
 * conversation ownership before allowing conversation:join.
 *
 * Auth: X-Internal-Secret header must match NEXTAUTH_SECRET.
 * This endpoint is NOT public — it's for server-to-server use only.
 *
 * Query params:
 *   conversationId — the conversation to check
 *   tenantId — the socket's tenant
 *   type — 'agent' or 'visitor'
 *   contactId — (visitors only) the socket's contactId
 *   userId — (agents only) the socket's userId (not checked, agents can join any conversation in their tenant)
 */
export async function GET(req: NextRequest) {
  const secret = getAuthSecret()
  const authHeader = req.headers.get('x-internal-secret')
  if (authHeader !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const conversationId = url.searchParams.get('conversationId')
  const tenantId = url.searchParams.get('tenantId')
  const type = url.searchParams.get('type')
  const contactId = url.searchParams.get('contactId')

  if (!conversationId || !tenantId || !type) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 })
  }

  const where: any = { id: conversationId, tenantId }
  // Visitors may only join their OWN conversations
  if (type === 'visitor' && contactId) {
    where.contactId = contactId
  }

  const conv = await db.conversation.findFirst({ where, select: { id: true } })
  if (!conv) {
    return NextResponse.json({ error: 'not_found' }, { status: 403 })
  }

  return NextResponse.json({ ok: true })
}
