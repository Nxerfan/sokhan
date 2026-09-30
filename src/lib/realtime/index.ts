/**
 * Realtime publishing abstraction.
 *
 * The application code only calls `publishRealtime(event)` — this module
 * decides how the event actually reaches the Socket.IO server based on
 * the deployment:
 *
 *   - docker/dev  : HTTP POST to the internal endpoint of the local
 *                   realtime service (default `http://localhost:3004`).
 *                   The realtime service then emits to connected sockets.
 *                   No external Redis needed.
 *
 *   - vercel      : Redis PUBLISH (when `REDIS_URL` is set) OR HTTP POST
 *                   to an external realtime endpoint (when
 *                   `REALTIME_INTERNAL_URL` is set). The realtime service
 *                   — running on a separate long-lived host (Railway,
 *                   Render, Fly.io, a VPS) — subscribes to Redis and
 *                   fans out to connected sockets.
 *
 *                   If neither env var is set, publish is a no-op and
 *                   clients fall back to the polling safety net (10s).
 *
 * This is a refactor of the previous `realtime-publish.ts` — same
 * public API plus a Redis adapter and a deployment-aware factory.
 */

import { getAuthSecret } from '@/lib/env-check'
import { hasLocalRealtimeService } from '@/lib/deployment'

export interface RealtimeEvent {
  /** Socket.IO room name (e.g. `conversation:abc`). */
  room: string
  /** Event name (e.g. `message:new`). */
  event: string
  /** JSON-serialisable payload. */
  payload: unknown
}

export interface RealtimePublisher {
  publish(event: RealtimeEvent): Promise<void>
}

/* ------------------------------------------------------------------ */
/* HTTP publisher (docker/dev, or external HTTP endpoint on Vercel)  */
/* ------------------------------------------------------------------ */

class HttpRealtimePublisher implements RealtimePublisher {
  constructor(
    private readonly url: string,
    private readonly secret: string,
  ) {}

  async publish(event: RealtimeEvent): Promise<void> {
    try {
      await fetch(`${this.url}/internal/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.secret,
        },
        body: JSON.stringify(event),
      })
    } catch (e) {
      // Realtime service may be down — don't block the API response.
      // Messages are persisted to DB; clients catch up via polling.
      console.error('[realtime] http publish failed:', e instanceof Error ? e.message : e)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Redis publisher (Vercel default)                                   */
/* ------------------------------------------------------------------ */
//
// We use a dynamic `import('redis')` so the optional `redis` package is
// only required when actually configured. In docker/dev without Redis,
// this code path is never taken.
//
// The realtime service subscribes to the `sukhan:realtime` channel and
// emits each event to the appropriate room — see
// `mini-services/realtime/index.ts` for the subscriber side.

interface RedisClientLike {
  publish(channel: string, message: string): Promise<number>
  quit(): Promise<void>
}

class RedisRealtimePublisher implements RealtimePublisher {
  private client: RedisClientLike | null = null
  private readonly channel: string

  constructor(
    private readonly url: string,
    channel = 'sukhan:realtime:publish',
  ) {
    this.channel = channel
  }

  private async getClient(): Promise<RedisClientLike> {
    if (this.client) return this.client
    try {
      const mod = await import('redis')
      this.client = (mod as unknown as { createClient: (opts: unknown) => RedisClientLike })
        .createClient({ url: this.url })
      await (this.client as unknown as { connect: () => Promise<void> }).connect()
    } catch (e) {
      throw new Error(
        'Redis realtime publisher is configured (REDIS_URL set) but the ' +
          '`redis` package is not installed. Run `bun add redis` to enable ' +
          'Redis-backed realtime publishing. Original error: ' +
          (e instanceof Error ? e.message : String(e)),
      )
    }
    return this.client
  }

  async publish(event: RealtimeEvent): Promise<void> {
    try {
      const client = await this.getClient()
      await client.publish(this.channel, JSON.stringify(event))
    } catch (e) {
      console.error('[realtime] redis publish failed:', e instanceof Error ? e.message : e)
    }
  }
}

/* ------------------------------------------------------------------ */
/* No-op publisher (Vercel without Redis — degraded, polling fallback) */
/* ------------------------------------------------------------------ */

class NoopRealtimePublisher implements RealtimePublisher {
  async publish(): Promise<void> {
    // Intentionally a no-op. Clients fall back to the polling safety net.
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

let cached: RealtimePublisher | null = null

/**
 * Resolve the active realtime publisher.
 *
 * Resolution order:
 *   1. `REDIS_URL` set → Redis publisher (works in any mode — required for
 *      Vercel).
 *   2. `REALTIME_INTERNAL_URL` set (or local service available) → HTTP
 *      publisher. In docker/dev this defaults to
 *      `http://localhost:3004`. On Vercel, the user can set
 *      `REALTIME_INTERNAL_URL` to point at their external realtime host.
 *   3. Vercel without Redis and without REALTIME_INTERNAL_URL → no-op
 *      (polling only). This is a degraded mode — warn loudly.
 */
export function getRealtimePublisher(): RealtimePublisher {
  if (cached) return cached

  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    cached = new RedisRealtimePublisher(redisUrl, process.env.REDIS_CHANNEL || 'sukhan:realtime:publish')
    return cached
  }

  const httpUrl = process.env.REALTIME_INTERNAL_URL
  if (httpUrl) {
    cached = new HttpRealtimePublisher(httpUrl, getAuthSecret())
    return cached
  }

  if (hasLocalRealtimeService()) {
    cached = new HttpRealtimePublisher('http://localhost:3004', getAuthSecret())
    return cached
  }

  // Vercel without Redis or external HTTP endpoint.
  console.warn(
    '\n⚠️  Realtime publishing is disabled — no REDIS_URL or ' +
      'REALTIME_INTERNAL_URL is set.\n' +
      '   Clients will fall back to the 10-second polling safety net.\n' +
      '   Configure REDIS_URL (recommended) or REALTIME_INTERNAL_URL ' +
      'for real-time delivery.\n',
  )
  cached = new NoopRealtimePublisher()
  return cached
}

/** Test hook — reset the cached publisher. */
export function __resetRealtimePublisherCache(): void {
  cached = null
}

/* ------------------------------------------------------------------ */
/* Public API — drop-in replacement for the old publishToRealtime    */
/* ------------------------------------------------------------------ */

/**
 * Publish a realtime event to all connected clients in `room`.
 *
 * Re-exports the function previously in `realtime-publish.ts` so existing
 * callers continue to work without modification.
 */
export async function publishToRealtime(event: RealtimeEvent): Promise<void> {
  await getRealtimePublisher().publish(event)
}

/** Room name helpers — keep naming consistent between API routes and the realtime service. */
export const room = {
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  agent: (userId: string) => `agent:${userId}`,
}

/** Event names — shared between API routes, realtime service, and clients. */
export const EVENTS = {
  MESSAGE_NEW: 'message:new',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  MESSAGE_READ: 'message:read',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_NEW: 'conversation:new',
} as const
