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
 *   - Single-flight authorization recovery: at most ONE recovery op when
 *     multiple visitor policy `connect_error` events arrive
 *     (`policy_changed` / `verification_required` /
 *     `website_login_required` / `identity_token_invalid` /
 *     `policy_unavailable`). Concurrent auth errors collapse to one
 *     recovery operation. Successful recovery updates the socket auth
 *     token + reconnects. A null/failed recovery is TERMINAL for this
 *     socket (reconnection disabled) — the widget must re-establish
 *     identity (setIdentity/refreshIdentity) which creates a new socket.
 *     The socket does NOT duplicate access-policy logic — it delegates
 *     to the narrow `onAuthorizationError` hook the widget implements.
 *   - Reconnect events: distinct `reconnect` event (vs first-time
 *     `connect`) for gap-recovery hooks. `membership_inactive` is
 *     terminal (no retry).
 */

import type { SocketEvent, SocketHandler, SukhanSocketOptions } from './types.js'
import type { RealtimeTransport } from './realtime-resolve.js'

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
 * The visitor policy `connect_error` reasons the realtime backend now emits
 * (mirrors `VisitorAccessDecision.reason` in `src/lib/widget-access-evaluator.ts`).
 * The socket delegates these ONCE to the widget's `onAuthorizationError`
 * hook — it does NOT interpret access policy itself. Anything else falls
 * through to the existing `invalid_token`/`no_token` refresh path (or the
 * terminal `membership_*` path).
 */
const VISITOR_POLICY_REASONS = new Set([
  'policy_changed',
  'verification_required',
  'website_login_required',
  'identity_token_invalid',
  'policy_unavailable',
])

/**
 * Lazily load the Socket.IO client. Single-flight per absolute script URL
 * — concurrent callers share one load. Failure resets the entry so a later
 * retry can re-attempt.
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

  /**
   * Authorization-recovery state for visitor policy connect errors.
   * `authzTerminal` is set when a recovery op returns null/throws — the
   * socket stops reconnecting until the widget re-establishes identity
   * (setIdentity/refreshIdentity → new socket). This guarantees no
   * infinite connect_error loop on persistent policy failures.
   */
  private authzTerminal = false
  private authzInFlight: Promise<string | null> | null = null

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
  /**
   * Narrow authorization-recovery hook. The widget implements it to:
   *   1. re-fetch public config
   *   2. resolve the CURRENT accessMode
   *   3. execute the correct identity flow
   *   4. return a FRESH realtime token (→ socket updates auth + reconnects)
   *      OR `null` (→ socket stops reconnecting until the user completes
   *      the required identity action).
   * Concurrent policy connect_errors collapse to ONE recovery operation.
   */
  onAuthorizationError?: (reason: string) => Promise<string | null>

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
    if (this.authzTerminal) return // terminal policy failure — do not reconnect
    const loader = this.deps.scriptLoader ?? loadScriptOnce
    loader(this.clientScriptUrl)
      .then(() => {
        if (this.destroyed) return
        if (this.socket) return
        if (this.authzTerminal) return
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
        this.disableReconnectionAndDisconnect()
        return
      }
      if (this.membershipRevoked) return
      // Visitor policy connect errors → delegate ONCE to the widget's
      // authorization-recovery hook (single-flight, terminal-on-null).
      // The socket does NOT interpret access policy itself.
      if (VISITOR_POLICY_REASONS.has(msg)) {
        await this.recoverAuthorization(msg)
        return
      }
      // Legacy token-refresh path (invalid_token / no_token) — preserved
      // exactly (PR5/PR9 single-flight + bounded retries).
      if (msg === 'invalid_token' || msg === 'no_token') {
        if (this.consecutiveRefreshFailures >= this.MAX_REFRESH_FAILURES) {
          this.disableReconnectionAndDisconnect()
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
   * Disable reconnection + disconnect the underlying socket. Used for
   * terminal states (membership revoked, authorization recovery returned
   * null, refresh-failure cap reached). After this the socket will not
   * reconnect on its own — the widget must create a new socket after
   * re-establishing identity.
   */
  private disableReconnectionAndDisconnect(): void {
    if (this.socket) {
      const sk = this.socket as SocketIOClient & { io?: { opts?: { reconnection?: boolean } } }
      if (sk.io?.opts) sk.io.opts.reconnection = false
      try {
        this.socket.disconnect()
      } catch {
        // ignore
      }
    }
  }

  /**
   * Single-flight authorization recovery for visitor policy connect errors.
   * Concurrent `connect_error`s with a policy reason collapse to ONE
   * `onAuthorizationError` call. A successful recovery (returns a fresh
   * token) updates the socket auth + reconnects. A null/throwing recovery
   * is TERMINAL — reconnection is disabled until the widget re-establishes
   * identity (which creates a new socket). No infinite connect_error loop.
   */
  private async recoverAuthorization(reason: string): Promise<void> {
    if (this.authzTerminal) return
    if (this.authzInFlight) {
      // Collapse concurrent errors — await the in-flight recovery; its
      // result drives the (single) reconnect/terminal transition.
      try {
        await this.authzInFlight
      } catch {
        // swallowed — the in-flight op handles state transitions
      }
      return
    }
    const hook = this.onAuthorizationError
    if (!hook) {
      // No recovery hook configured → terminal (do not infinite-loop).
      this.authzTerminal = true
      this.disableReconnectionAndDisconnect()
      return
    }
    this.authzInFlight = (async () => {
      try {
        const fresh = await hook(reason)
        if (this.destroyed) return null
        if (fresh && this.socket) {
          ;(this.socket as SocketIOClient & { auth?: unknown }).auth = {
            token: fresh,
          }
          this.socket.connect()
          return fresh
        }
        // null → terminal until the widget re-establishes identity.
        this.authzTerminal = true
        this.disableReconnectionAndDisconnect()
        return null
      } catch {
        if (this.destroyed) return null
        this.authzTerminal = true
        this.disableReconnectionAndDisconnect()
        return null
      } finally {
        this.authzInFlight = null
      }
    })()
    await this.authzInFlight
  }

  /**
   * Single-flight token refresh. Multiple connect_error events collapse
   * into ONE refresh operation. The cap counter is incremented exactly
   * once per refresh op (success resets, failure increments) — concurrent
   * callers don't double-count.
   */
  private async refreshToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight
    const refreshFn = this.onTokenExpired
    if (!refreshFn) {
      this.consecutiveRefreshFailures++
      return null
    }
    this.refreshInFlight = (async () => {
      try {
        const fresh = await refreshFn()
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
    this.authzInFlight = null
  }
}
