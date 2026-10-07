import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'

/**
 * Self-hosted deployment request form.
 * NO auth required — public form on the marketing site.
 * Stores the request for manual follow-up. No auto-provisioning.
 *
 * Rate limited: 5 requests / 15 minutes / IP.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Rate limit: 5 requests / 15 minutes / IP
  const ip = getClientIP(req)
  const rateLimitResult = await checkRateLimit(ip, 'self-host-request')
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: rateLimitResult.retryAfter ? { 'Retry-After': String(rateLimitResult.retryAfter) } : {} },
    )
  }

  // Validate input types — reject non-strings
  if (typeof body.name !== 'string' || typeof body.company !== 'string' ||
      typeof body.email !== 'string' || typeof body.phone !== 'string') {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  }

  const name = body.name.trim().slice(0, 200)
  const company = body.company.trim().slice(0, 200)
  const email = body.email.trim().toLowerCase().slice(0, 254)
  const phone = body.phone.trim().slice(0, 50)
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : null

  if (!name || !company || !email || !phone) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
  }

  const request = await db.selfHostRequest.create({
    data: { name, company, email, phone, message },
  })

  return NextResponse.json({ ok: true, id: request.id })
}
