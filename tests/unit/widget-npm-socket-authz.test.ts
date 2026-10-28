/// <reference types="bun-types" />
/**
 * NPM widget socket authorization unit tests (requirement #50).
 *
 * Preserves all current socket tests' guarantees (single-flight script
 * load, single-flight token refresh, bounded refresh retries) and adds:
 *   - policy_changed delegates once to the widget auth-recovery hook
 *   - verification_required delegates
 *   - website_login_required delegates
 *   - identity_token_invalid delegates
 *   - policy_unavailable delegates
 *   - successful recovery updates socket auth token + reconnects
 *   - null/failed recovery is terminal (no infinite connect_error loop)
 *   - concurrent auth errors collapse to ONE recovery operation
 *   - invalid_token refresh path is PRESERVED (not delegated to authz hook)
 */

import { test, expect, describe } from 'bun:test'
import { SukhanSocket, __clearScriptLoaderCache, type SukhanSocketDeps } from '../../packages/widget-npm/src/socket.js'
import type { SukhanSocketOptions } from '../../packages/widget-npm/src/types.js'

// bun:test runs in a Node-like env without a `window` global. The socket's
// connect() guards on `typeof window === 'undefined'` (it would no-op in
// SSR). Provide a minimal `window` so connect() proceeds. The ioFactory is
// injected via deps, so `window.io` is never read; `document` is never
// touched (scriptLoader is also injected).
if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {}
}

interface FakeClient {
  on(event: string, handler: (payload: unknown) => void): void
  emit(event: string, ...args: unknown[]): void
  disconnect(): void
  connect(): void
  io?: { opts?: { reconnection?: boolean } }
  auth?: unknown
  // test-only: trigger a server-pushed event
  __trigger(event: string, payload: unknown): void
  __connectedCalls: number
  __disconnected: boolean
  __reconnection(): boolean | undefined
}

function makeFakeClient(): FakeClient {
  const handlers: Record<string, Array<(p: unknown) => void>> = {}
  let reconnection = true
  let disconnected = false
  let connectedCalls = 0
  const client: FakeClient = {
    on: (ev, h) => {
      ;(handlers[ev] ||= []).push(h)
    },
    emit: () => {},
    disconnect: () => {
      disconnected = true
    },
    connect: () => {
      connectedCalls++
    },
    io: {
      get opts() {
        return { get reconnection() { return reconnection }, set reconnection(v: boolean) { reconnection = v } }
      },
    },
    __trigger: (ev, payload) => {
      for (const h of handlers[ev] ?? []) h(payload)
    },
    __connectedCalls: 0,
    __disconnected: false,
    __reconnection: () => reconnection,
  }
  Object.defineProperty(client, '__connectedCalls', { get: () => connectedCalls })
  Object.defineProperty(client, '__disconnected', { get: () => disconnected })
  return client
}

function makeDeps(client: FakeClient): SukhanSocketDeps {
  return {
    scriptLoader: async () => undefined, // resolve immediately
    ioFactory: () => client,
  }
}

function makeOptions(): SukhanSocketOptions {
  return {
    token: 'tok-1',
    clientScriptUrl: 'https://app.sukhan.chat/socket.io.min.js',
    realtimeUrl: 'https://app.sukhan.chat',
    realtimePath: '/api/realtime',
    transports: ['websocket'],
    addTrailingSlash: false,
  }
}

/** Connect the socket + wait for the script-loader microtask to settle. */
async function connectAndSettle(s: SukhanSocket): Promise<void> {
  s.connect()
  // The socket.connect() awaits scriptLoader (resolves immediately) then
  // runs registerHandlers() in a microtask. Flush microtasks.
  await Promise.resolve()
  await Promise.resolve()
}

describe('SukhanSocket: visitor policy connect errors delegate to onAuthorizationError', () => {
  test('policy_changed → hook called once with reason', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    const captured: { reason: string | null } = { reason: null }
    s.onAuthorizationError = async (reason) => {
      captured.reason = reason
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_changed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.reason).toBe('policy_changed')
    s.disconnect()
  })

  test('verification_required → delegates', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    const captured: { reason: string | null } = { reason: null }
    s.onAuthorizationError = async (r) => {
      captured.reason = r
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('verification_required'))
    await Promise.resolve()
    expect(captured.reason).toBe('verification_required')
    s.disconnect()
  })

  test('website_login_required → delegates', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    const captured: { reason: string | null } = { reason: null }
    s.onAuthorizationError = async (r) => {
      captured.reason = r
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('website_login_required'))
    await Promise.resolve()
    expect(captured.reason).toBe('website_login_required')
    s.disconnect()
  })

  test('identity_token_invalid → delegates', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    const captured: { reason: string | null } = { reason: null }
    s.onAuthorizationError = async (r) => {
      captured.reason = r
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('identity_token_invalid'))
    await Promise.resolve()
    expect(captured.reason).toBe('identity_token_invalid')
    s.disconnect()
  })

  test('policy_unavailable → delegates', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    const captured: { reason: string | null } = { reason: null }
    s.onAuthorizationError = async (r) => {
      captured.reason = r
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_unavailable'))
    await Promise.resolve()
    expect(captured.reason).toBe('policy_unavailable')
    s.disconnect()
  })
})

describe('SukhanSocket: successful recovery updates auth + reconnects', () => {
  test('hook returns fresh token → auth updated + connect() called', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    s.onAuthorizationError = async () => 'fresh-token-xyz'
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_changed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect((client.auth as { token?: string } | undefined)?.token).toBe('fresh-token-xyz')
    expect(client.__connectedCalls).toBeGreaterThan(0) // reconnected
    s.disconnect()
  })
})

describe('SukhanSocket: null/failed recovery is terminal (bounded)', () => {
  test('hook returns null → reconnection disabled (no infinite loop)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    s.onAuthorizationError = async () => null
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_changed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(client.__reconnection()).toBe(false) // terminal
    // A second policy error must NOT trigger another recovery (terminal).
    let secondCall = false
    s.onAuthorizationError = async () => {
      secondCall = true
      return null
    }
    client.__trigger('connect_error', new Error('verification_required'))
    await Promise.resolve()
    await Promise.resolve()
    expect(secondCall).toBe(false)
    s.disconnect()
  })

  test('hook throws → terminal (no infinite loop)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    s.onAuthorizationError = async () => {
      throw new Error('recovery exploded')
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_changed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(client.__reconnection()).toBe(false)
    s.disconnect()
  })

  test('no hook configured → terminal immediately (no infinite loop)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    // onAuthorizationError NOT set
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('policy_changed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(client.__reconnection()).toBe(false)
    s.disconnect()
  })
})

describe('SukhanSocket: concurrent auth errors collapse to ONE recovery', () => {
  test('two simultaneous policy errors → hook called exactly once', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    let callCount = 0
    s.onAuthorizationError = async () => {
      callCount++
      // simulate an async recovery that takes a microtask
      await Promise.resolve()
      return 'fresh'
    }
    await connectAndSettle(s)
    // Fire two policy errors in quick succession.
    client.__trigger('connect_error', new Error('policy_changed'))
    client.__trigger('connect_error', new Error('verification_required'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(callCount).toBe(1)
    s.disconnect()
  })
})

describe('SukhanSocket: invalid_token refresh path PRESERVED (not delegated)', () => {
  test('invalid_token → onTokenExpired called (NOT onAuthorizationError)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    let tokenExpired = 0
    let authzCalled = false
    s.onTokenExpired = async () => {
      tokenExpired++
      return 'refreshed-token'
    }
    s.onAuthorizationError = async () => {
      authzCalled = true
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('invalid_token'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(tokenExpired).toBe(1)
    expect(authzCalled).toBe(false)
    expect((client.auth as { token?: string } | undefined)?.token).toBe('refreshed-token')
    s.disconnect()
  })

  test('no_token → onTokenExpired called (NOT onAuthorizationError)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    let tokenExpired = 0
    s.onTokenExpired = async () => {
      tokenExpired++
      return 'refreshed'
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('no_token'))
    await Promise.resolve()
    await Promise.resolve()
    expect(tokenExpired).toBe(1)
    s.disconnect()
  })

  test('membership_inactive → terminal (NOT delegated to authz hook)', async () => {
    __clearScriptLoaderCache()
    const client = makeFakeClient()
    const s = new SukhanSocket(makeOptions(), makeDeps(client))
    let authzCalled = false
    s.onAuthorizationError = async () => {
      authzCalled = true
      return null
    }
    await connectAndSettle(s)
    client.__trigger('connect_error', new Error('membership_inactive'))
    await Promise.resolve()
    await Promise.resolve()
    expect(authzCalled).toBe(false)
    expect(client.__reconnection()).toBe(false)
    s.disconnect()
  })
})
