/**
 * Rate limiter with deployment-aware backend selection.
 * - Vercel/cloud (REDIS_URL set): Redis INCR + EXPIRE
 * - Local dev/Docker without Redis: in-memory Map fallback
 */
interface RateLimitResult { allowed: boolean; retryAfter?: number }
const WINDOW_MS = 60_000
const IP_LIMIT = 30
const TENANT_LIMIT = 60
const WINDOW_SECONDS = 60
interface RateBucket { count: number; resetAt: number }
const ipBuckets = new Map<string, RateBucket>()
const tenantBuckets = new Map<string, RateBucket>()
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of ipBuckets) { if (bucket.resetAt < now) ipBuckets.delete(key) }
    for (const [key, bucket] of tenantBuckets) { if (bucket.resetAt < now) tenantBuckets.delete(key) }
  }, 300_000)
}
function checkInMemory(key: string, limit: number, buckets: Map<string, RateBucket>): RateLimitResult {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) { buckets.set(key, { count: 1, resetAt: now + WINDOW_MS }); return { allowed: true } }
  bucket.count++
  if (bucket.count > limit) return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  return { allowed: true }
}
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
      client.on('error', (e: Error) => console.error('[rate-limit] redis error:', e.message))
      await client.connect()
      redisClient = client
      return client
    } catch (e) {
      console.warn('[rate-limit] Redis unavailable:', e instanceof Error ? e.message : e)
      return null
    }
  })()
  return redisClientPromise
}
async function checkRedis(key: string, limit: number): Promise<RateLimitResult> {
  const client = await getRedisClient()
  if (!client) return checkInMemory(key, limit, key.includes(':tenant:') ? tenantBuckets : ipBuckets)
  try {
    const count = await client.incr(key)
    if (count === 1) await client.expire(key, WINDOW_SECONDS)
    if (count > limit) { const ttl = await client.ttl(key); return { allowed: false, retryAfter: ttl > 0 ? ttl : WINDOW_SECONDS } }
    return { allowed: true }
  } catch (e) {
    console.warn('[rate-limit] Redis failed:', e instanceof Error ? e.message : e)
    return checkInMemory(key, limit, key.includes(':tenant:') ? tenantBuckets : ipBuckets)
  }
}
export async function rateLimit(ip: string, tenantSlug?: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV !== 'production' && !process.env.REDIS_URL) {
    if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || ip === '::ffff:127.0.0.1') return { allowed: true }
  }
  const ipResult = await checkRedis(`rate:ip:${ip}`, IP_LIMIT)
  if (!ipResult.allowed) return ipResult
  if (tenantSlug) {
    const tenantResult = await checkRedis(`rate:tenant:${tenantSlug}`, TENANT_LIMIT)
    if (!tenantResult.allowed) return tenantResult
  }
  return { allowed: true }
}


// ============================================================
// Backward-compatible wrappers (used by widget API routes)
// ============================================================

/** Extract the client IP from a Next.js request. */
export function getClientIP(req: { headers: { get: (n: string) => string | null }; ip?: string }): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  const realIP = req.headers.get('x-real-ip')
  if (realIP) return realIP
  return req.ip || '127.0.0.1'
}

/** Check rate limit (async — Redis-backed in cloud, in-memory in dev). */
export async function checkRateLimit(ip: string, tenantSlug?: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  return rateLimit(ip, tenantSlug)
}
