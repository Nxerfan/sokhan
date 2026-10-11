/**
 * Sukhan Widget — pure runtime resolvers (no env access, browser-safe).
 *
 * Re-implements the pure helpers from `src/lib/realtime-config.ts` so the
 * cross-origin NPM widget bundle does NOT import server-only code (the
 * server module reads `process.env`, meaningless in a browser bundle).
 *
 * The NPM widget gets its realtime endpoint config from the BACKEND
 * RESPONSE (`config.realtime`), NOT from env.
 */

export type RealtimeTransport = 'websocket' | 'polling'

export interface RealtimeEndpointConfig {
  url: string
  path: string
  transports: RealtimeTransport[]
  addTrailingSlash: boolean
}

export const HOSTED_API_URL = 'https://app.sukhan.chat'

export const HOSTED_REALTIME_CONFIG: RealtimeEndpointConfig = {
  url: '',
  path: '/api/realtime',
  transports: ['websocket'],
  addTrailingSlash: false,
}

export class SukhanConfigError extends Error {
  readonly code: 'sukhan_invalid_api_url'
  constructor(message: string) {
    super(message)
    this.name = 'SukhanConfigError'
    this.code = 'sukhan_invalid_api_url'
    Object.setPrototypeOf(this, SukhanConfigError.prototype)
  }
}

export function resolveApiUrl(explicit?: string): string {
  if (explicit) {
    let parsed: URL
    try {
      parsed = new URL(explicit)
    } catch {
      throw new SukhanConfigError(
        `sukhan: invalid apiUrl (not a parseable URL): ${explicit}`,
      )
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SukhanConfigError(
        `sukhan: invalid apiUrl (must be http/https, got ${parsed.protocol}): ${explicit}`,
      )
    }
    const s = parsed.toString()
    if (s.endsWith('/') && parsed.pathname === '/' && s.length > 1) {
      return s.slice(0, -1)
    }
    return s
  }
  return HOSTED_API_URL
}

export function resolveRealtimeUrl(realtimeUrl: string, apiOrigin: string): string {
  if (!realtimeUrl) return apiOrigin
  try {
    const parsed = new URL(realtimeUrl)
    const s = parsed.toString()
    if (s.endsWith('/') && parsed.pathname === '/' && s.length > 1) {
      return s.slice(0, -1)
    }
    return s
  } catch {
    try {
      return new URL(realtimeUrl, apiOrigin).toString()
    } catch {
      return apiOrigin
    }
  }
}

export function resolveRealtimeFromConfig(
  apiOrigin: string,
  configRealtime?: RealtimeEndpointConfig | null,
  override?: RealtimeEndpointConfig | null,
): RealtimeEndpointConfig {
  const source: RealtimeEndpointConfig =
    override ?? configRealtime ?? HOSTED_REALTIME_CONFIG
  return {
    url: resolveRealtimeUrl(source.url ?? '', apiOrigin),
    path: source.path,
    transports: source.transports,
    addTrailingSlash: source.addTrailingSlash,
  }
}

export function buildSocketIoScriptUrl(apiUrl: string): string {
  return new URL('/socket.io.min.js', apiUrl).toString()
}
