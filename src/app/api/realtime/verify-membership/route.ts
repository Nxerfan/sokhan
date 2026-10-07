import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthSecret } from '@/lib/env-check'
import { withTenant } from '@/lib/db'
import crypto from 'crypto'

/**
 * Internal endpoint for the Docker realtime service to verify that an
 * agent's membership is currently active before granting tenant-wide
 * realtime access.
 *
 * Auth: X-Internal-Secret header must match NEXTAUTH_SECRET (timing-safe).
 * This endpoint is NOT public — it's for server-to-server use only.
 *
 * Query params:
 *   userId   — the agent's user ID
 *   tenantId — the tenant ID
 *
 * Returns 200 if the membership exists and is active.
 * Returns 403 otherwise.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export async function GET(req: NextRequest) {
  const secret = getAuthSecret()
  const authHeader = req.headers.get('x-internal-secret') || ''
  if (!timingSafeEqualStr(authHeader, secret)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const userId = url.searchParams.get('userId')
  const tenantId = url.searchParams.get('tenantId')

  if (!userId || !tenantId) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 })
  }

  const membership = await withTenant(tenantId, async () => {
    return db.membership.findFirst({
      where: { userId, tenantId },
      select: { id: true, role: true, status: true },
    })
  })

  if (!membership) {
    return NextResponse.json({ error: 'not_found' }, { status: 403 })
  }

  if (membership.status !== 'active') {
    return NextResponse.json({ error: 'inactive' }, { status: 403 })
  }

  return NextResponse.json({ ok: true, role: membership.role })
}
