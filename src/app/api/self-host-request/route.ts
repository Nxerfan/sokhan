import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getClientIP } from '@/lib/rate-limit'

/**
 * Self-hosted deployment request form.
 * NO auth required — public form on the marketing site.
 * Stores the request for manual follow-up. No auto-provisioning.
 *
 * Rate limited: 5 requests / 15 minutes / IP.
 *
 * Backend selection:
 *   - REDIS_URL set: Redis INCR + EXPIRE on `rate:self-host:<ip>` with TTL
 *     900s. This shares state across all instances (Vercel serverless,
 *     Docker multi-replica, etc.).
 *   - No REDIS_URL: in-memory Map fallback (single-instance dev / Docker
 *     Lite). Doesn't share across processes/replicas but is correct for the
 *     common local-dev case.
 */
const SELF_HOST_LIMIT = 5
const SELF_HOST_WINDOW_MS = 15 * 60 * 1000
const SELF_HOST_WINDOW_SECONDS = 900
const SELF_HOST_REDIS_KEY_PREFIX = 'rate:self-host:'

// ─── In-memory fallback ───────────────────────────────────────────────
interface SelfHostBucket { count: number; resetAt: number }
const selfHostBuckets = new Map<string, SelfHostBucket>()
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of selfHostBuckets) {
      if (bucket.resetAt < now) selfHostBuckets.delete(key)
    }
  }, 300_000).unref?.()
}

function checkInMemory(ip: string): { allowed: boolean; retryAfter?: number } {
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

// ─── Redis backend ────────────────────────────────────────────────────
let redisClient: any = null
let redisClientPromise: Promise<any> | null = null

async function getRedisClient(): Promise<any | null> {
  if (redisClient) return redisClient
  if (redisClientPromise) return redisClientPromise
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  redisClientPromise = (async () => {
    try {
      const { createClient } = await import('redis')
      const client = createClient({ url: redisUrl })
      client.on('error', (e: Error) =>
        console.error('[self-host-rate-limit] redis error:', e.message),
      )
      await client.connect()
      redisClient = client
      return client
    } catch (e) {
      console.warn(
        '[self-host-rate-limit] Redis unavailable:',
        e instanceof Error ? e.message : e,
      )
      return null
    }
  })()
  return redisClientPromise
}

/**
 * Rate limit check — selects backend based on REDIS_URL env var.
 * Used directly by the POST handler. Preserves the historical function
 * name (`checkSelfHostRateLimit`) for unit-test source-text assertions.
 */
async function checkSelfHostRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const client = await getRedisClient()
  if (!client) return checkInMemory(ip)
  const key = `${SELF_HOST_REDIS_KEY_PREFIX}${ip}`
  try {
    const count = await client.incr(key)
    if (count === 1) {
      // First request in the window — set the TTL.
      await client.expire(key, SELF_HOST_WINDOW_SECONDS)
    }
    if (count > SELF_HOST_LIMIT) {
      const ttl = await client.ttl(key)
      return { allowed: false, retryAfter: ttl > 0 ? ttl : SELF_HOST_WINDOW_SECONDS }
    }
    return { allowed: true }
  } catch (e) {
    console.warn(
      '[self-host-rate-limit] Redis failed:',
      e instanceof Error ? e.message : e,
    )
    return checkInMemory(ip)
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Rate limit: 5 requests / 15 minutes / IP. Uses Redis when REDIS_URL is
  // set (shares state across instances), falls back to in-memory otherwise.
  const ip = getClientIP(req)
  const rateLimitResult = await checkSelfHostRateLimit(ip)
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: rateLimitResult.retryAfter
          ? { 'Retry-After': String(rateLimitResult.retryAfter) }
          : {},
      },
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
