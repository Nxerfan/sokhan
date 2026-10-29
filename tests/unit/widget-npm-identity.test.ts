/// <reference types="bun-types" />
/**
 * NPM widget identity-endpoint pure/unit tests (requirement #49).
 *
 * Behaviorally proves:
 *   - same-origin relative endpoint resolution
 *   - same-origin absolute endpoint accepted
 *   - cross-origin absolute endpoint REJECTED (no host cookie leak)
 *   - protocol-relative //, javascript:, data:, backslash → rejected
 *   - parseIdentityResponse: authenticated=false / true+token / every
 *     malformed shape rejected (array, missing, non-boolean, true w/o
 *     token, empty token, non-string token, false-with-token)
 *   - fetchIdentity: 2xx authenticated, 2xx false, non-2xx, malformed JSON,
 *     timeout (abort), network failure → all fail closed (null)
 *   - no token persistence (the fetcher returns the token; it is never
 *     written to localStorage/sessionStorage/cookies — verified by
 *     asserting storage stays empty after a fetch)
 */

import { test, expect, describe, mock } from 'bun:test'
import {
  parseIdentityResponse,
  resolveIdentityEndpoint,
  fetchIdentity,
  IDENTITY_TIMEOUT_MS,
} from '../../packages/widget-npm/src/identity.js'

const PAGE_ORIGIN = 'https://customer.example.com'

describe('parseIdentityResponse (strict shape)', () => {
  test('{authenticated:false} → ok', () => {
    expect(parseIdentityResponse({ authenticated: false })).toEqual({ authenticated: false })
  })
  test('{authenticated:true, token:"abc"} → ok', () => {
    expect(parseIdentityResponse({ authenticated: true, token: 'abc' })).toEqual({ authenticated: true, token: 'abc' })
  })
  test('null → null', () => {
    expect(parseIdentityResponse(null)).toBe(null)
  })
  test('array → null', () => {
    expect(parseIdentityResponse([1, 2])).toBe(null)
  })
  test('missing authenticated → null', () => {
    expect(parseIdentityResponse({ token: 'abc' })).toBe(null)
  })
  test('authenticated not boolean → null', () => {
    expect(parseIdentityResponse({ authenticated: 'true' })).toBe(null)
    expect(parseIdentityResponse({ authenticated: 1 })).toBe(null)
  })
  test('authenticated=true without token → null', () => {
    expect(parseIdentityResponse({ authenticated: true })).toBe(null)
  })
  test('authenticated=true empty/whitespace token → null', () => {
    expect(parseIdentityResponse({ authenticated: true, token: '' })).toBe(null)
    expect(parseIdentityResponse({ authenticated: true, token: '   ' })).toBe(null)
  })
  test('token non-string (object) → null (no String() coercion)', () => {
    expect(parseIdentityResponse({ authenticated: true, token: { nested: 'x' } })).toBe(null)
    expect(parseIdentityResponse({ authenticated: true, token: 123 })).toBe(null)
  })
  test('authenticated=false WITH token → null (ambiguous)', () => {
    expect(parseIdentityResponse({ authenticated: false, token: 'abc' })).toBe(null)
  })
  test('oversized token → null (defensive)', () => {
    expect(parseIdentityResponse({ authenticated: true, token: 'x'.repeat(9000) })).toBe(null)
  })
})

describe('resolveIdentityEndpoint (same-origin only)', () => {
  test('relative path → resolved against page origin', () => {
    expect(resolveIdentityEndpoint({ explicit: '/api/sukhan-identity', pageOrigin: PAGE_ORIGIN })).toBe(
      'https://customer.example.com/api/sukhan-identity',
    )
  })
  test('relative "/" → page origin', () => {
    expect(resolveIdentityEndpoint({ explicit: '/', pageOrigin: PAGE_ORIGIN })).toBe('https://customer.example.com/')
  })
  test('same-origin absolute → accepted', () => {
    expect(resolveIdentityEndpoint({ explicit: 'https://customer.example.com/api/id', pageOrigin: PAGE_ORIGIN })).toBe(
      'https://customer.example.com/api/id',
    )
  })
  test('cross-origin absolute → REJECTED', () => {
    expect(resolveIdentityEndpoint({ explicit: 'https://app.sukhan.chat/api/id', pageOrigin: PAGE_ORIGIN })).toBe(null)
    expect(resolveIdentityEndpoint({ explicit: 'https://evil.example.com/api/id', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('protocol-relative // → rejected', () => {
    expect(resolveIdentityEndpoint({ explicit: '//customer.example.com/api/id', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('javascript: → rejected', () => {
    expect(resolveIdentityEndpoint({ explicit: 'javascript:alert(1)', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('data: → rejected', () => {
    expect(resolveIdentityEndpoint({ explicit: 'data:text/html,<x>', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('backslash confusion → rejected', () => {
    expect(resolveIdentityEndpoint({ explicit: '/\\\\evil.com/x', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('control chars → rejected', () => {
    expect(resolveIdentityEndpoint({ explicit: '/api/id\n', pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('no explicit + no configPath → null (fail closed)', () => {
    expect(resolveIdentityEndpoint({ explicit: undefined, configPath: null, pageOrigin: PAGE_ORIGIN })).toBe(null)
  })
  test('explicit takes priority over configPath', () => {
    expect(
      resolveIdentityEndpoint({ explicit: '/api/explicit', configPath: '/api/config', pageOrigin: PAGE_ORIGIN }),
    ).toBe('https://customer.example.com/api/explicit')
  })
  test('configPath fallback when no explicit', () => {
    expect(resolveIdentityEndpoint({ explicit: undefined, configPath: '/api/config', pageOrigin: PAGE_ORIGIN })).toBe(
      'https://customer.example.com/api/config',
    )
  })
  test('empty explicit falls back to configPath', () => {
    expect(resolveIdentityEndpoint({ explicit: '   ', configPath: '/api/config', pageOrigin: PAGE_ORIGIN })).toBe(
      'https://customer.example.com/api/config',
    )
  })
  test('relative path resolves against page origin, NOT apiUrl/Sukhan origin', () => {
    // The Sukhan origin would be https://app.sukhan.chat — ensure it's NOT used.
    const resolved = resolveIdentityEndpoint({ explicit: '/api/sukhan-identity', pageOrigin: PAGE_ORIGIN })
    expect(resolved).toBe('https://customer.example.com/api/sukhan-identity')
    expect(resolved).not.toContain('app.sukhan.chat')
  })
})

describe('fetchIdentity (bounded, same-origin, fail-closed)', () => {
  function jsonRes(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  }

  test('2xx authenticated=true + token → result', async () => {
    const f = jsonRes({ authenticated: true, token: 'minted-token' })
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toEqual({ authenticated: true, token: 'minted-token' })
  })

  test('2xx authenticated=false → result (logged out)', async () => {
    const f = jsonRes({ authenticated: false })
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toEqual({ authenticated: false })
  })

  test('non-2xx → null (integration unavailable)', async () => {
    const f = jsonRes({ authenticated: false }, 500)
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toBe(null)
  })

  test('malformed JSON → null', async () => {
    const f = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toBe(null)
  })

  test('authenticated=true without token → null', async () => {
    const f = jsonRes({ authenticated: true })
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toBe(null)
  })

  test('network failure → null', async () => {
    const f = (async () => {
      throw new TypeError('network error')
    }) as unknown as typeof fetch
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r).toBe(null)
  })

  test('timeout (abort) → null', async () => {
    // A fetch that never resolves; the AbortController fires after timeoutMs.
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch
    const r = await fetchIdentity('https://customer.example.com/api/id', {
      fetchImpl: f,
      timeoutMs: 50,
    })
    expect(r).toBe(null)
  })

  test('GET method + same-origin credentials + Accept header (no Sukhan secret sent)', async () => {
    let captured: { method?: string; creds?: RequestCredentials; headers?: HeadersInit; auth: string | null } = { auth: null }
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      captured = {
        method: init?.method,
        creds: init?.credentials,
        headers: init?.headers,
        auth: headers.get('authorization'),
      }
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(captured.method).toBe('GET')
    expect(captured.creds).toBe('same-origin')
    expect(new Headers(captured.headers).get('accept')).toBe('application/json')
    expect(captured.auth).toBe(null) // NO Authorization header to the customer endpoint
  })

  test('default timeout constant is bounded (~5000ms)', () => {
    expect(IDENTITY_TIMEOUT_MS).toBe(5000)
  })
})

describe('identity token is memory-only (never persisted)', () => {
  test('after an authenticated fetch, localStorage/sessionStorage do NOT contain the token', async () => {
    // Set up a fake localStorage/sessionStorage (bun may not have them).
    const ls = new Map<string, string>()
    const ss = new Map<string, string>()
    ;(globalThis as unknown as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => ls.set(k, v),
      removeItem: (k: string) => ls.delete(k),
      clear: () => ls.clear(),
      key: (i: number) => Array.from(ls.keys())[i] ?? null,
      length: 0,
    } as unknown as Storage
    ;(globalThis as unknown as { sessionStorage?: Storage }).sessionStorage = {
      getItem: (k: string) => ss.get(k) ?? null,
      setItem: (k: string, v: string) => ss.set(k, v),
      removeItem: (k: string) => ss.delete(k),
      clear: () => ss.clear(),
      key: (i: number) => Array.from(ss.keys())[i] ?? null,
      length: 0,
    } as unknown as Storage

    const f = (async () =>
      new Response(JSON.stringify({ authenticated: true, token: 'secret-minted-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    const r = await fetchIdentity('https://customer.example.com/api/id', { fetchImpl: f })
    expect(r?.authenticated).toBe(true)
    // The fetcher returns the token to the caller; it must NOT write it anywhere.
    const allLs = Array.from(ls.values()).join('')
    const allSs = Array.from(ss.values()).join('')
    expect(allLs).not.toContain('secret-minted-token')
    expect(allSs).not.toContain('secret-minted-token')
  })
})
