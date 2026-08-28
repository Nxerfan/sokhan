/**
 * Simple in-memory rate limiter for public widget endpoints.
 *
 * Two dimensions:
 *   - Per IP address: prevents a single attacker from flooding all tenants
 *   - Per tenant (slug): prevents a targeted attack from overwhelming one tenant
 *
 * Uses a sliding window counter (requests per window). In production with
 * multiple instances, this should use Redis instead of in-memory.
 */

interface RateBucket {
  count: number
  resetAt: number
}

const WINDOW_MS = 60_000 // 1 minute
const IP_LIMIT = 30 // 30 requests per minute per IP
const TENANT_LIMIT = 60 // 60 requests per minute per tenant

const ipBuckets = new Map<string, RateBucket>()
const tenantBuckets = new Map<string, RateBucket>()

// Cleanup old entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of ipBuckets) {
    if (bucket.resetAt < now) ipBuckets.delete(key)
  }
  for (const [key, bucket] of tenantBuckets) {
    if (bucket.resetAt < now) tenantBuckets.delete(key)
  }
}, 300_000)

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

function checkBucket(map: Map<string, RateBucket>, key: string, limit: number): RateLimitResult {
  const now = Date.now()
  let bucket = map.get(key)

  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS }
    map.set(key, bucket)
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt }
  }

  bucket.count++
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt }
}

export function checkRateLimit(ip: string, tenantSlug: string): RateLimitResult {
  // Skip rate limiting in dev mode for localhost — tests all come from the same IP
  if (process.env.NODE_ENV !== 'production' && (ip === 'unknown' || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost')) {
    return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 }
  }

  const ipResult = checkBucket(ipBuckets, ip, IP_LIMIT)
  if (!ipResult.allowed) return ipResult

  const tenantResult = checkBucket(tenantBuckets, tenantSlug, TENANT_LIMIT)
  if (!tenantResult.allowed) return tenantResult

  return {
    allowed: true,
    remaining: Math.min(ipResult.remaining, tenantResult.remaining),
    resetAt: Math.max(ipResult.resetAt, tenantResult.resetAt),
  }
}

/** Extract the real client IP from a request, handling proxies. */
export function getClientIP(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()

  const realIP = req.headers.get('x-real-ip')
  if (realIP) return realIP

  return 'unknown'
}
