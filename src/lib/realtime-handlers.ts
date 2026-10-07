/**
 * Realtime connection handler logic — extracted for testability.
 *
 * This module contains the connect/connect_error handler logic that
 * manages token refresh, membership state, and reconnection behavior.
 * It is used by realtime-client.ts in production and tested directly
 * in tests/unit/reconnect-handlers.test.ts.
 *
 * Design: the handlers accept a socket-like object and a token-refresh
 * function as dependencies, enabling executable behavioral tests with
 * fake sockets and mocked fetch — no source-string inspection needed.
 */

export interface RealtimeSocket {
  on(event: string, handler: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  connect(): void
  disconnect(): void
  auth: Record<string, unknown> | undefined
  io: { opts: { reconnection: boolean } }
  /** Internal: the last conversation ID joined (for rejoin after reconnect). */
  __lastJoinedConv?: string
}

export interface RealtimeHandlerOptions {
  /** Backoff in ms for membership_check_failed retry. Default: 2000. */
  backoffMs?: number
}

export interface RealtimeHandlers {
  /** Called when the socket connects (or reconnects). */
  onConnect: () => void
  /** Called when the socket connection is rejected by server middleware. */
  onConnectError: (err: Error) => Promise<void>
  /** Teardown — clear any pending timers. */
  cleanup: () => void
}

/**
 * Set up the realtime connection handlers.
 *
 * Returns handlers for `connect` and `connect_error` events that manage:
 *   - token refresh on invalid_token/no_token
 *   - terminal disconnect on membership_inactive
 *   - transient retry on membership_check_failed
 *   - conversation:join re-emission after reconnect
 *   - stale retry timer cleanup on successful connect
 */
export function setupRealtimeHandlers(
  socket: RealtimeSocket,
  refreshToken: () => Promise<string | null>,
  options: RealtimeHandlerOptions = {},
): RealtimeHandlers {
  const backoff = options.backoffMs ?? 2000
  let membershipRevoked = false
  let membershipCheckRetryTimer: ReturnType<typeof setTimeout> | null = null

  function onConnect() {
    // #4: Clear stale transient retry timer on successful connect.
    // This prevents a stale membership_check_failed retry from firing
    // after the connection has recovered.
    if (membershipCheckRetryTimer) {
      clearTimeout(membershipCheckRetryTimer)
      membershipCheckRetryTimer = null
    }
    // Re-emit conversation:join for the currently open conversation.
    const openConv = socket.__lastJoinedConv
    if (openConv) {
      socket.emit('conversation:join', openConv)
    }
  }

  async function onConnectError(err: Error) {
    const msg = err.message

    // TERMINAL: membership is revoked. Stop everything.
    if (msg === 'membership_inactive') {
      membershipRevoked = true
      socket.io.opts.reconnection = false
      socket.disconnect()
      return
    }

    // TRANSIENT: infrastructure error during membership check.
    // Do NOT fetch a new token — the token is still valid.
    // Retry socket.connect() with bounded backoff.
    if (msg === 'membership_check_failed') {
      if (membershipRevoked) return
      if (membershipCheckRetryTimer) return // prevent duplicate retry timers
      membershipCheckRetryTimer = setTimeout(() => {
        membershipCheckRetryTimer = null
        if (!membershipRevoked) {
          socket.connect()
        }
      }, backoff)
      return
    }

    // EXPIRED TOKEN: refresh + manual reconnect.
    if (msg === 'invalid_token' || msg === 'no_token') {
      if (membershipRevoked) return
      const freshToken = await refreshToken()
      if (freshToken) {
        socket.auth = { token: freshToken }
        // Socket.IO does NOT auto-reconnect after a middleware rejection.
        // We must manually initiate a new connection attempt.
        socket.connect()
      }
    }
  }

  function cleanup() {
    if (membershipCheckRetryTimer) {
      clearTimeout(membershipCheckRetryTimer)
      membershipCheckRetryTimer = null
    }
  }

  return { onConnect, onConnectError, cleanup }
}
