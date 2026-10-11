/**
 * Shared realtime endpoint resolver (PR: widget-inbox-realtime-reliability).
 *
 * ONE source of truth for how the Sukhan realtime (Socket.IO) endpoint is
 * addressed across deployment modes. Consumed by:
 *
 *   - src/lib/realtime-client.ts  (dashboard inbox — same-origin)
 *   - src/app/api/widget/[slug]/config/route.ts  (server returns `realtime`
 *     in the widget config response so the cross-origin NPM widget does not
 *     need to know deployment topology)
 *
 * The resolved `url` may be relative (e.g. '/?XTransformPort=3003' or '').
 * The dashboard uses it as-is (same origin). The cross-origin NPM widget
 * resolves a relative `url` against its Sukhan `apiUrl` (the Sukhan API
 * origin) — NEVER against the host page origin.
 *
 * IMPORTANT: passing '/api/realtime' as the Socket.IO URL (not the `path`)
 * makes Socket.IO treat it as a NAMESPACE. The `path` is '/api/realtime' on
 * Vercel; the `url` is '' (default namespace, connects to the page origin =
 * the Sukhan deployment).
 */

export type RealtimeTransport = 'websocket' | 'polling'

export interface RealtimeConfig {
  /** Socket.IO connection URL. May be relative ('' or '/?XTransformPort=3003'). */
  url: string
  /** Socket.IO path. '/api/realtime' on Vercel; '/' on Docker default. */
  path: string
  transports: RealtimeTransport[]
  /** Vercel WebSocket requires addTrailingSlash:false to avoid a 308. */
  addTrailingSlash: boolean
}

/** Vercel / serverless: WebSocket-only, path '/api/realtime', default namespace. */
const VERCEL_CONFIG: RealtimeConfig = {
  url: '',
  path: '/api/realtime',
  transports: ['websocket'],
  addTrailingSlash: false,
}

/**
 * Resolve the realtime endpoint config from server/build-time env vars.
 *
 * Resolution order:
 *   1. Vercel mode (NEXT_PUBLIC_VERCEL=1 or VERCEL=1) -> WebSocket-only,
 *      path '/api/realtime', url '' (page origin = Sukhan deployment).
 *   2. Explicit NEXT_PUBLIC_REALTIME_URL -> used as-is; path is
 *      '/api/realtime' if the URL contains '/api/realtime' (serverless WS
 *      pattern), else '/'. Transports follow the same rule.
 *   3. Docker / dev default (behind Caddy) -> url '/?XTransformPort=3003',
 *      path '/', transports ['websocket','polling'].
 */
export function resolveRealtimeConfig(): RealtimeConfig {
  const isVercel =
    process.env.NEXT_PUBLIC_VERCEL === '1' || process.env.VERCEL === '1'
  if (isVercel) return VERCEL_CONFIG

  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL
  if (explicit) {
    const isApiRealtime = explicit.includes('/api/realtime')
    return {
      url: explicit,
      path: isApiRealtime ? '/api/realtime' : '/',
      transports: isApiRealtime ? ['websocket'] : ['websocket', 'polling'],
      addTrailingSlash: false,
    }
  }

  return {
    url: '/?XTransformPort=3003',
    path: '/',
    transports: ['websocket', 'polling'],
    addTrailingSlash: false,
  }
}

/**
 * Resolve a (possibly relative) realtime URL against an absolute API origin.
 *
 * Used by the cross-origin NPM widget: the backend config response returns a
 * possibly-relative `url` (e.g. '' or '/?XTransformPort=3003'). The NPM
 * widget resolves it against its Sukhan `apiUrl` (the Sukhan API origin) so
 * the Socket.IO connection targets the Sukhan backend, NOT the host
 * customer page origin.
 *
 *   resolveRealtimeUrl('', 'https://app.sukhan.chat') -> 'https://app.sukhan.chat'
 *   resolveRealtimeUrl('/?XTransformPort=3003', 'https://app.sukhan.chat')
 *     -> 'https://app.sukhan.chat/?XTransformPort=3003'
 *   resolveRealtimeUrl('https://rt.other.com', 'https://app.sukhan.chat')
 *     -> 'https://rt.other.com'  (absolute URL used as-is)
 */
export function resolveRealtimeUrl(realtimeUrl: string, apiOrigin: string): string {
  if (!realtimeUrl) return apiOrigin
  try {
    // If it parses as absolute (has a protocol), use as-is.
    const parsed = new URL(realtimeUrl)
    return parsed.toString().replace(/\/$/, '')
  } catch {
    // Relative — resolve against the API origin.
    try {
      return new URL(realtimeUrl, apiOrigin).toString()
    } catch {
      return apiOrigin
    }
  }
}
