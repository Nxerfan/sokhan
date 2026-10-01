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
 *   type — MUST be 'agent' or 'visitor' (anything else → 400)
 *   contactId — REQUIRED for visitors; ignored for agents
 *   userId — (agents only) the socket's userId (informational — agents can
 *            join any conversation in their tenant)
 *
 * Fail-closed behavior:
 *   - Missing/invalid `type` → 400.
 *   - Visitor without `contactId` → 400 (must NOT silently fall through
 *     to a tenant-only check — that would let a visitor join ANY
 *     conversation in their tenant).
 *   - Visitor: conversation must match `tenantId` AND `contactId`.
 *   - Agent: conversation must match `tenantId`.
 *   - Anything not found → 403.
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

  // Validate type — only 'agent' and 'visitor' are accepted. Anything
  // else is rejected so an unknown payload type cannot slip past the
  // visitor-specific contactId check.
  if (type !== 'agent' && type !== 'visitor') {
    return NextResponse.json({ error: 'invalid_type' }, { status: 400 })
  }

  // Visitors MUST have a contactId. Without it, we cannot scope the
  // query to their own conversations — reject instead of falling
  // through to a tenant-only check.
  if (type === 'visitor' && !contactId) {
    return NextResponse.json({ error: 'missing_contact_id' }, { status: 400 })
  }

  const where: { id: string; tenantId: string; contactId?: string } = {
    id: conversationId,
    tenantId,
  }
  // Visitors may only join their OWN conversations (contactId match).
  // Agents can join any conversation in their tenant (no contactId filter).
  if (type === 'visitor') {
    where.contactId = contactId!
  }

  const conv = await db.conversation.findFirst({ where, select: { id: true } })
  if (!conv) {
    return NextResponse.json({ error: 'not_found' }, { status: 403 })
  }

  return NextResponse.json({ ok: true })
}
