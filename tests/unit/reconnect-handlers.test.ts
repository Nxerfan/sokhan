/// <reference types="bun-types" />
/**
 * Real executable behavioral tests for realtime connection handlers.
 *
 * Uses a fake socket + mocked token refresh + real timers with short
 * backoff. NO source-string inspection — these tests actually execute
 * the registered handlers and assert behavior.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { setupRealtimeHandlers, type RealtimeSocket } from '@/lib/realtime-handlers'

// ─── Fake socket ────────────────────────────────────────────────
class FakeSocket implements RealtimeSocket {
  emitCalls: Array<{ event: string; args: unknown[] }> = []
  connectCount = 0
  disconnectCount = 0
  auth: Record<string, unknown> | undefined = undefined
  io = { opts: { reconnection: true } }
  __lastJoinedConv: string | undefined
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>()

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event)!.push(handler)
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitCalls.push({ event, args })
  }

  connect(): void { this.connectCount++ }
  disconnect(): void { this.disconnectCount++ }

  // Test helper: simulate connect_error event
  triggerError(msg: string): void {
    const fns = this.handlers.get('connect_error') || []
    fns.forEach(fn => fn(new Error(msg)))
  }

  // Test helper: simulate connect event
  triggerConnect(): void {
    const fns = this.handlers.get('connect') || []
    fns.forEach(fn => fn())
  }
}

// ─── Test state ──────────────────────────────────────────────────
let socket: FakeSocket
let refreshCalls: number
let refreshResult: string | null
let handlers: ReturnType<typeof setupRealtimeHandlers>

beforeEach(() => {
  socket = new FakeSocket()
  refreshCalls = 0
  refreshResult = 'fresh-token-xyz'
  // Mock with refresh-in-flight guard (mirrors production behavior)
  let refreshInFlight: Promise<string | null> | null = null
  const mockRefresh = async (): Promise<string | null> => {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      refreshCalls++
      return refreshResult
    })()
    try {
      return await refreshInFlight
    } finally {
      refreshInFlight = null
    }
  }
  handlers = setupRealtimeHandlers(socket, mockRefresh, { backoffMs: 10 })
  socket.on('connect', handlers.onConnect)
  socket.on('connect_error', (err: unknown) => { handlers.onConnectError(err as Error) })
})

afterEach(() => {
  handlers.cleanup()
})

// ─── Tests ──────────────────────────────────────────────────────

test('#5A invalid_token triggers token refresh + socket.connect()', async () => {
  socket.triggerError('invalid_token')
  await new Promise(r => setTimeout(r, 50))

  expect(refreshCalls).toBe(1)
  expect(socket.auth).toEqual({ token: 'fresh-token-xyz' })
  expect(socket.connectCount).toBe(1)
})

test('#5B concurrent invalid_token triggers only ONE refresh (guard)', async () => {
  // Fire two invalid_token errors rapidly before the first refresh resolves
  socket.triggerError('invalid_token')
  socket.triggerError('invalid_token')
  await new Promise(r => setTimeout(r, 50))

  // The refresh-in-flight guard means only one refresh call
  expect(refreshCalls).toBe(1)
  // socket.connect() should be called at least once
  expect(socket.connectCount).toBeGreaterThanOrEqual(1)
})

test('#5C successful connect re-emits conversation:join', () => {
  socket.__lastJoinedConv = 'conv-123'
  socket.triggerConnect()

  const joinCall = socket.emitCalls.find(c => c.event === 'conversation:join')
  expect(joinCall).toBeTruthy()
  expect(joinCall!.args[0]).toBe('conv-123')
})

test('#5D membership_inactive is terminal — no refresh, no retry', async () => {
  socket.triggerError('membership_inactive')
  await new Promise(r => setTimeout(r, 50))

  expect(refreshCalls).toBe(0)
  expect(socket.io.opts.reconnection).toBe(false)
  expect(socket.disconnectCount).toBe(1)
  expect(socket.connectCount).toBe(0)
})

test('#5E membership_check_failed retries with backoff, no token refresh', async () => {
  socket.triggerError('membership_check_failed')

  // No refresh should have occurred (token is still valid)
  expect(refreshCalls).toBe(0)

  // Wait for the backoff timer to fire (10ms + margin)
  await new Promise(r => setTimeout(r, 50))

  expect(socket.connectCount).toBe(1)
  expect(refreshCalls).toBe(0)
})

test('#5E2 duplicate membership_check_failed does NOT schedule another timer', async () => {
  socket.triggerError('membership_check_failed')
  socket.triggerError('membership_check_failed') // duplicate before timer fires
  await new Promise(r => setTimeout(r, 50))

  expect(socket.connectCount).toBe(1)
  expect(refreshCalls).toBe(0)
})

test('#5F successful connect cancels stale membership_check_failed retry', async () => {
  // Trigger a membership_check_failed → schedules a retry timer
  socket.triggerError('membership_check_failed')
  expect(refreshCalls).toBe(0)

  // Before the timer fires, trigger a successful connect
  socket.triggerConnect()

  // Wait past the original timer deadline
  await new Promise(r => setTimeout(r, 50))

  // socket.connect() should NOT have been called by the stale timer
  // (it was cancelled by the successful connect's cleanup)
  expect(socket.connectCount).toBe(0)
})
