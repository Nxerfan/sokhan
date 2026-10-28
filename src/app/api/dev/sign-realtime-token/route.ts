import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { getAuthSecret } from '@/lib/env-check'

export async function POST(req: NextRequest) {
  if (process.env.SUKHAN_TEST_HARNESS !== 'true') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const { contactId, tenantId, slug, identityLevel, policyVersion } = body as Record<string, unknown>
  if (typeof contactId !== 'string' || typeof tenantId !== 'string' || typeof slug !== 'string') {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }
  const payload: Record<string, unknown> = { type: 'visitor', contactId, tenantId, slug }
  if (identityLevel !== undefined) payload.identityLevel = identityLevel
  if (policyVersion !== undefined) payload.policyVersion = policyVersion
  const now = Math.floor(Date.now() / 1000)
  payload.iat = now
  payload.exp = now + 300
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(encoded).digest('base64url')
  return NextResponse.json({ token: encoded + '.' + sig })
}
