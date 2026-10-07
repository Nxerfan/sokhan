import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getClientIP } from '@/lib/rate-limit'

/**
 * Self-hosted deployment request form.
 * NO auth required — public form on the marketing site.
 * Stores the request for manual follow-up. No auto-provisioning.
 *
 * Rate limited: 5 requests / 15 minutes / IP.
 */
// Dedicated rate limiter for self-host form: 5 requests / 15 minutes / IP
const SELF_HOST_LIMIT = 5
const SELF_HOST_WINDOW_MS = 15 * 60 * 1000
const selfHostBuckets = new Map<string, { count: number; resetAt: number }>()

function checkSelfHostRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const bucket = selfHostBuckets.get(ip)
  if (!bucket || bucket.resetAt < now) {
    selfHostBuckets.set(ip, { count: 1, resetAt: now + SELF_HOST_WINDOW_MS })
    return { allowed: true }
  }
  bucket.count++
  if (bucket.count > SELF_HOST_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  return { allowed: true }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Rate limit: 5 requests / 15 minutes / IP
  const ip = getClientIP(req)
  const rateLimitResult = checkSelfHostRateLimit(ip)
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

  const name = body.name.trim()
  const company = body.company.trim()
  const email = body.email.trim().toLowerCase()
  const phone = body.phone.trim()
  const message = typeof body.message === 'string' ? body.message.trim() : null
  if (name.length > 200) return NextResponse.json({ error: 'name_too_long' }, { status: 400 })
  if (company.length > 200) return NextResponse.json({ error: 'company_too_long' }, { status: 400 })
  if (email.length > 254) return NextResponse.json({ error: 'email_too_long' }, { status: 400 })
  if (phone.length > 50) return NextResponse.json({ error: 'phone_too_long' }, { status: 400 })
  if (message && message.length > 2000) return NextResponse.json({ error: 'message_too_long' }, { status: 400 })

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
