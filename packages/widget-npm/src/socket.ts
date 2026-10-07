/**
 * Sukhan Widget — Socket.IO connection wrapper (explicit config, no globals).
 *
 * Loads the Socket.IO client from the Sukhan backend
 * (`<apiOrigin>/socket.io.min.js`) and connects to the realtime service
 * using an EXPLICIT endpoint config passed via the constructor.
 *
 * No more `window.__sukhan_api_url` coupling, no more hardcoded
 * `/?XTransformPort=3003` + `path: '/'`. Deployment topology comes from
 * the backend `config.realtime` field, or from an explicit
 * `SukhanOptions.realtime` override.
 *
 * Reliability features:
 *   - Single-flight script load: ONE shared Promise keyed by absolute
 *     script URL. First caller begins load, second waits for the same
 *     load, ONE `<script>` element created, both resolve. Failure
 *     rejects/resets so a later retry can occur.
 *   - Single-flight token refresh: at most ONE refresh operation is in
 *     flight when multiple `connect_error` events arrive while a token
 *     is expired. All reconnect attempts use the resulting latest token.
 *     Refresh failure is bounded — capped retries, no infinite loop.
 *   - Reconnect events: distinct `reconnect` event (vs first-time
 *     `connect`) for gap-recovery hooks. `membership_inactive` is
 *     terminal (no retry).
 */

import type { SocketEvent, SocketHandler, SukhanSocketOptions } from './types'
import type { RealtimeTransport } from './realtime-resolve'

interface SocketIOClient {
  on(event: string, handler: (payload: unknown) => void): void
  emit(event: string, ...args: unknown[]): void
  disconnect(): void
  connect(): void
}

interface SocketIOGlobal {
  (url: string, opts: {
    path: string
    auth: { token: string }
    transports: RealtimeTransport[]
    reconnection: boolean
    addTrailingSlash?: boolean
  }): SocketIOClient
}

export interface SukhanSocketDeps {
  ioFactory?: SocketIOGlobal
  scriptLoader?: (src: string) => Promise<void>
}

const scriptLoaders = new Map<string, Promise<void>>()

/**
 * Lazily load the Socket.IO client. Single-flight per absolute script URL
 * — concurrent callers share one load. Failure resets the entry so a
 * later retry can re-attempt.
 *
 * The loader takes ONLY an absolute script URL — no endpoint config is
 * leaked through the loader.
 */
export function loadScriptOnce(src: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('sukhan: no window (SSR)'))
  }
  const w = window as unknown as { io?: SocketIOGlobal }
  if (w.io) {
    const cached = Promise.resolve()
    scriptLoaders.set(src, cached)
    return cached
  }
  const existing = scriptLoaders.get(src)
  if (existing) return existing
  const p = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      scriptLoaders.delete(src)
      // eslint-disable-next-line no-console
      console.error('[sukhan] failed to load socket.io-client from', src)
      reject(new Error(`sukhan: failed to load socket.io-client from ${src}`))
    }
    document.head.appendChild(s)
  })
  scriptLoaders.set(src, p)
  return p
}

/** Test-only helper: clear the single-flight script-loader cache. */
export function __clearScriptLoaderCache(): void {
  scriptLoaders.clear()
}

export class SukhanSocket {
  private socket: SocketIOClient | null = null
  private handlers: Map<SocketEvent, Set<SocketHandler>> = new Map()
  private connected = false
  private everConnected = false
  private destroyed = false
  private membershipRevoked = false
  private consecutiveRefreshFailures = 0
  private readonly MAX_REFRESH_FAILURES = 5
  private refreshInFlight: Promise<string | null> | null = null

  private readonly token: string
  private readonly clientScriptUrl: string
  private readonly realtimeUrl: string
  private readonly realtimePath: string
  private readonly transports: RealtimeTransport[]
  private readonly addTrailingSlash: boolean
  private readonly deps: SukhanSocketDeps

  onConnect?: () => void
  onReconnect?: () => void
  onTokenExpired?: () => Promise<string | null>

  constructor(options: SukhanSocketOptions, deps?: SukhanSocketDeps) {
    this.token = options.token
    this.clientScriptUrl = options.clientScriptUrl
    this.realtimeUrl = options.realtimeUrl
    this.realtimePath = options.realtimePath
    this.transports = options.transports
    this.addTrailingSlash = options.addTrailingSlash
    this.deps = deps ?? {}
  }

  on(event: SocketEvent, handler: SocketHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  private emit(event: SocketEvent, payload: unknown): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const h of set) {
      try {
        h(payload)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[sukhan] handler error', e)
      }
    }
  }

  connect(): void {
    if (typeof window === 'undefined') return
    if (this.socket) return
    if (this.destroyed) return
    const loader = this.deps.scriptLoader ?? loadScriptOnce
    loader(this.clientScriptUrl)
      .then(() => {
        if (this.destroyed) return
        if (this.socket) return
        const ioFactory =
          this.deps.ioFactory ?? (window as unknown as { io?: SocketIOGlobal }).io
        if (!ioFactory) {
          // eslint-disable-next-line no-console
          console.error('[sukhan] socket.io-client not available after load')
          return
        }
        this.socket = ioFactory(this.realtimeUrl, {
          path: this.realtimePath,
          auth: { token: this.token },
          transports: this.transports,
          reconnection: true,
          addTrailingSlash: this.addTrailingSlash,
        })
        this.registerHandlers()
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[sukhan] socket connect failed', e)
      })
  }

  private registerHandlers(): void {
    if (!this.socket) return
    this.socket.on('connect', () => {
      if (this.destroyed) return
      this.connected = true
      const wasConnected = this.everConnected
      this.everConnected = true
      this.emit('connect', null)
      if (this.onConnect) this.onConnect()
      if (wasConnected) {
        this.emit('reconnect', null)
        if (this.onReconnect) this.onReconnect()
      }
    })
    this.socket.on('disconnect', () => {
      if (this.destroyed) return
      this.connected = false
      this.emit('disconnect', null)
    })
    this.socket.on('connect_error', async (err: unknown) => {
      if (this.destroyed) return
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'membership_inactive' || msg === 'membership_check_failed') {
        this.membershipRevoked = true
        if (this.socket) {
          ;(
            this.socket as SocketIOClient & {
              io?: { opts?: { reconnection?: boolean } }
            },
          ).io!.opts!.reconnection = false
          this.socket.disconnect()
        }
        return
      }
      if (this.membershipRevoked) return
      if (msg === 'invalid_token' || msg === 'no_token') {
        if (this.consecutiveRefreshFailures >= this.MAX_REFRESH_FAILURES) {
          if (this.socket) {
            ;(
              this.socket as SocketIOClient & {
                io?: { opts?: { reconnection?: boolean } }
              },
            ).io!.opts!.reconnection = false
            this.socket.disconnect()
          }
          return
        }
        const fresh = await this.refreshToken()
        if (this.destroyed) return
        if (fresh && this.socket) {
          this.consecutiveRefreshFailures = 0
          ;(this.socket as SocketIOClient & { auth?: unknown }).auth = {
            token: fresh,
          }
          this.socket.connect()
        }
      }
    })
    this.socket.on('message:new', (payload: unknown) =>
      this.emit('message:new', payload),
    )
    this.socket.on('conversation:updated', (payload: unknown) =>
      this.emit('conversation:updated', payload),
    )
    this.socket.on('typing:start', (payload: unknown) =>
      this.emit('typing:start', payload),
    )
    this.socket.on('typing:stop', (payload: unknown) =>
      this.emit('typing:stop', payload),
    )
  }

  /**
   * Single-flight token refresh. Multiple connect_error events collapse
   * into ONE refresh operation. The cap counter is incremented exactly
   * once per refresh op (success resets, failure increments) — concurrent
   * callers don't double-count.
   */
  private async refreshToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight
    if (!this.onTokenExpired) {
      this.consecutiveRefreshFailures++
      return null
    }
    this.refreshInFlight = (async () => {
      try {
        const fresh = await this.onTokenExpired()
        if (fresh) {
          this.consecutiveRefreshFailures = 0
        } else {
          this.consecutiveRefreshFailures++
        }
        return fresh
      } catch {
        this.consecutiveRefreshFailures++
        return null
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  send(event: string, ...args: unknown[]): void {
    if (this.socket) this.socket.emit(event, ...args)
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.socket) {
      try {
        this.socket.disconnect()
      } catch {
        // ignore — already disconnected
      }
      this.socket = null
    }
    this.handlers.clear()
    this.connected = false
    this.refreshInFlight = null
  }
}
