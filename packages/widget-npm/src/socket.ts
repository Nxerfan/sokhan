/**
 * Sukhan Widget — Socket.IO connection wrapper.
 *
 * Loads the Socket.IO client from the Sukhan backend (`/socket.io.min.js` —
 * bundled on the same origin as the widget API), then connects to the
 * realtime service via the Caddy gateway (XTransformPort=3003).
 *
 * The realtime token (issued by POST /api/widget/<slug>/contact) is passed
 * in the `auth` field so the realtime service can authenticate the visitor
 * and place them in the tenant's room.
 *
 * Connection strategy: warm-up on identify (BEFORE the first message is
 * sent). This fixes the race condition where an agent replies faster than
 * the socket can load + connect + join, causing the reply to be missed.
 */

import type { SocketEvent, SocketHandler } from './types'

/** The path used to load the Socket.IO client (same origin as the API). */
export const SOCKET_IO_JS_PATH = '/socket.io.min.js'
/** The realtime endpoint — Caddy XTransformPort=3003 routes to the realtime service. */
export const SOCKET_URL = '/?XTransformPort=3003'

/** Minimal Socket.IO client surface — typed subset of the global `io`. */
interface SocketIOClient {
  on(event: string, handler: (payload: unknown) => void): void
  emit(event: string, ...args: unknown[]): void
  disconnect(): void
  connect(): void
}

interface SocketIOGlobal {
  (url: string, opts: { path: string; auth: { token: string }; transports: string[]; reconnection: boolean }): SocketIOClient
}

/** Lazy-load the Socket.IO client from the Sukhan backend. */
function loadSocketIO(callback: () => void): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { io?: SocketIOGlobal }
  if (w.io) {
    callback()
    return
  }
  const apiUrl = (window as unknown as { __sukhan_api_url?: string }).__sukhan_api_url || ''
  const src = apiUrl + SOCKET_IO_JS_PATH
  const s = document.createElement('script')
  s.src = src
  s.async = true
  s.onload = callback
  s.onerror = () => {
    // eslint-disable-next-line no-console
    console.error('[sukhan] failed to load socket.io-client from', src)
  }
  document.head.appendChild(s)
}

/**
 * Wrapper around a single Socket.IO connection for one visitor session.
 *
 * The socket is created lazily — `connect()` triggers the script load (if
 * not already loaded) and then establishes the connection. Handlers are
 * registered via `on()` BEFORE `connect()` is called so no early events are
 * missed.
 */
export class SukhanSocket {
  private socket: SocketIOClient | null = null
  private handlers: Map<SocketEvent, Set<SocketHandler>> = new Map()
  private connected = false
  private token: string
  /** Called when the socket connects — used to join conversation rooms. */
  onConnect?: () => void
  /** Called when the token needs to be refreshed (expired on reconnect). */
  onTokenExpired?: () => Promise<string | null>

  constructor(token: string) {
    this.token = token
  }

  /** Register an event handler. Returns an unsubscribe function. */
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

  /** Lazily load socket.io-client, then connect + register handlers. */
  connect(): void {
    if (typeof window === 'undefined') return
    if (this.socket) return
    loadSocketIO(() => {
      const w = window as unknown as { io?: SocketIOGlobal }
      if (!w.io) {
        // eslint-disable-next-line no-console
        console.error('[sukhan] socket.io-client not available')
        return
      }
      this.socket = w.io(SOCKET_URL, {
        path: '/',
        auth: { token: this.token },
        transports: ['websocket', 'polling'],
        reconnection: true,
      })
      this.socket.on('connect', () => {
        this.connected = true
        this.emit('connect', null)
        if (this.onConnect) this.onConnect()
      })
      this.socket.on('disconnect', () => {
        this.connected = false
        this.emit('disconnect', null)
      })
      // When a reconnect fails due to an expired token, call the refresh
      // callback to get a fresh token (re-identifying with the SAME
      // visitorId — no new Contact). Then update the socket auth.
      this.socket.on('connect_error', async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'invalid_token' || msg === 'no_token') {
          if (this.onTokenExpired) {
            const fresh = await this.onTokenExpired()
            if (fresh && this.socket) {
              this.token = fresh
              ;(this.socket as SocketIOClient & { auth?: unknown }).auth = { token: fresh }
            }
          }
        }
      })
      this.socket.on('message:new', (payload: unknown) => this.emit('message:new', payload))
      this.socket.on('conversation:updated', (payload: unknown) => this.emit('conversation:updated', payload))
      this.socket.on('typing:start', (payload: unknown) => this.emit('typing:start', payload))
      this.socket.on('typing:stop', (payload: unknown) => this.emit('typing:stop', payload))
    })
  }

  /** Emit an event to the server (e.g. conversation:join, typing:start). */
  send(event: string, ...args: unknown[]): void {
    if (this.socket) this.socket.emit(event, ...args)
  }

  /** Whether the socket is currently connected. */
  isConnected(): boolean {
    return this.connected
  }

  /** Disconnect + drop all handlers. Safe to call multiple times. */
  disconnect(): void {
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
  }
}
