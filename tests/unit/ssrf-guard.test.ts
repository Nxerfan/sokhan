/// <reference types="bun-types" />
/**
 * SSRF guard — BEHAVIORAL tests.
 *
 * These tests EXECUTE the guard with mocked DNS + fetch (NO real internet
 * access) and assert runtime behavior:
 *
 *   - Mock DNS (`makeDns`) returns controlled IPs per hostname.
 *   - Mock fetch (`makeFetch`) records every call (url + init + headers)
 *     and returns controlled Responses (status, headers, body, redirects).
 *
 * Coverage (per PR #3 §4 contract):
 *   - Private IPv4 (7 cases): 127.0.0.1, 10.0.0.1, 172.16.0.1, 172.31.0.1
 *     (edge), 192.168.1.1, 169.254.169.254 (metadata), 100.64.0.1 (CGNAT).
 *   - Private IPv6 (3 cases): ::1, fc00::1, fe80::1.
 *   - DNS-based (3 cases): public-only → fetch called; private → blocked;
 *     mixed public+private → blocked (any private record blocks).
 *   - Redirects (2 cases): same-origin → followed; cross-origin → blocked
 *     with `ssrf_cross_origin`.
 *   - Authorization (2 cases): cross-origin redirect never sends
 *     Authorization to the other origin (the other-origin fetch is never
 *     made); same-origin redirect keeps Authorization (sanity).
 *   - Timeout (1 case): fetch AbortError → `ssrf_timeout`.
 *   - WooCommerce cross-origin Link header (2 cases): cross-origin Link
 *     → `ssrf_cross_origin_link`; malformed Link URL → `ssrf_link_malformed`.
 *
 * A small number of static source-inspection checks are retained at the
 * bottom as SECONDARY regression (clearly marked). The bulk is behavioral.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { LookupAddress } from 'node:dns'

import { createSsrfGuard, SsrfError } from '@/lib/security/ssrf-guard'
import { fetchProductPage } from '@/lib/connectors/woocommerce'

// ─────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a mock DNS resolver from a `hostname → IPs[]` map. Returns
 * `LookupAddress[]` (the shape `node:dns/promises` `lookup({all:true})`
 * yields). Throws `DNS_NXDOMAIN` for unmapped hostnames (mirrors real NXDOMAIN).
 */
function makeDns(ipMap: Record<string, string[]>) {
  return async (hostname: string): Promise<LookupAddress[]> => {
    const ips = ipMap[hostname]
    if (!ips) throw new Error(`DNS_NXDOMAIN:${hostname}`)
    return ips.map(address => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  }
}

interface MockResponseSpec {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

/**
 * Build a mock fetch that returns configured Responses keyed by
 * `origin + pathname` (query string + hash are stripped, so URLs differing
 * only by `?per_page=100&page=1` etc. match the same mock entry). Records
 * every call's URL + init (with a snapshot of the headers, so later mutations
 * don't retroactively change recorded calls).
 *
 * If a path has an array of specs, they're consumed in order (one per call).
 */
function makeFetch(responsesByPath: Record<string, MockResponseSpec | MockResponseSpec[]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const u = new URL(urlStr)
    const key = u.origin + u.pathname
    const entry = responsesByPath[key]
    const resp: MockResponseSpec = !entry
      ? { status: 404 }
      : Array.isArray(entry)
        ? (entry.shift() ?? { status: 404 })
        : entry
    // Snapshot init so later calls' Headers objects don't retroactively
    // mutate recorded entries (each fetch in safeFetch gets a fresh
    // reqHeaders instance, but we snapshot anyway for safety).
    calls.push({
      url: urlStr,
      init: init
        ? {
            ...init,
            headers: init.headers ? new Headers(init.headers as HeadersInit) : undefined,
          }
        : undefined,
    })
    const headers = new Headers(resp.headers)
    const bodyStr =
      resp.body === undefined || resp.body === null
        ? null
        : typeof resp.body === 'string'
          ? resp.body
          : JSON.stringify(resp.body)
    return new Response(bodyStr, {
      status: resp.status ?? 200,
      headers,
    })
  }
  return { fn, calls }
}

/** Assert that `p` rejects with an `SsrfError` whose `code` matches. */
async function expectSsrfError(p: Promise<unknown>, code: string) {
  let err: unknown
  try {
    await p
  } catch (e) {
    err = e
  }
  if (!(err instanceof SsrfError)) {
    const got = err === undefined ? 'no throw' : (err as Error)?.constructor?.name ?? String(err)
    throw new Error(`Expected SsrfError with code "${code}", got: ${got}`)
  }
  expect((err as SsrfError).code).toBe(code)
}

// A clearly-public IP (not in any PRIVATE_IPV4_RANGES) for happy-path DNS.
const PUBLIC_IP = '93.184.216.34' // example.com's real-world public IP
const PUBLIC_IP_2 = '203.0.113.99' // documentation range; guard treats as public

// ─────────────────────────────────────────────────────────────────────────
// Private IPv4 — must be blocked, fetch NOT called
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — private IPv4 (blocked, fetch NOT called)', () => {
  const cases: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['10.0.0.1', 'RFC1918 class A'],
    ['172.16.0.1', 'RFC1918 class B lower bound'],
    ['172.31.0.1', 'RFC1918 class B upper bound (edge)'],
    ['192.168.1.1', 'RFC1918 class C'],
    ['169.254.169.254', 'cloud metadata endpoint'],
    ['100.64.0.1', 'CGNAT 100.64.0.0/10'],
  ]
  for (const [ip, label] of cases) {
    test(`${ip} (${label}) → ssrf_private_ip, fetch NOT called`, async () => {
      const mockFetch = makeFetch({})
      const { safeFetch } = createSsrfGuard({ fetchImpl: mockFetch.fn })
      await expectSsrfError(safeFetch(`http://${ip}/x`), 'ssrf_private_ip')
      expect(mockFetch.calls.length).toBe(0)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// Private IPv6 — must be blocked
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — private IPv6 (blocked, fetch NOT called)', () => {
  const cases: Array<[string, string]> = [
    ['::1', 'loopback'],
    ['fc00::1', 'unique local fc00::/7'],
    ['fe80::1', 'link-local fe80::/10'],
  ]
  for (const [ip, label] of cases) {
    test(`[${ip}] (${label}) → ssrf_private_ip, fetch NOT called`, async () => {
      const mockFetch = makeFetch({})
      const { safeFetch } = createSsrfGuard({ fetchImpl: mockFetch.fn })
      await expectSsrfError(safeFetch(`http://[${ip}]/x`), 'ssrf_private_ip')
      expect(mockFetch.calls.length).toBe(0)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// DNS-based resolution
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — DNS resolution', () => {
  test('public-only DNS (all A records public) → fetch IS called', async () => {
    const mockFetch = makeFetch({
      'https://example.com/x': { status: 200, body: { ok: true } },
    })
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'example.com': [PUBLIC_IP] }),
      fetchImpl: mockFetch.fn,
    })
    const res = await safeFetch('https://example.com/x')
    expect(res.status).toBe(200)
    expect(mockFetch.calls.length).toBe(1)
    expect(mockFetch.calls[0].url).toBe('https://example.com/x')
  })

  test('private DNS (resolves to private IP) → fetch NOT called, throws ssrf_dns_private', async () => {
    const mockFetch = makeFetch({})
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'internal.local': ['10.0.0.5'] }),
      fetchImpl: mockFetch.fn,
    })
    await expectSsrfError(safeFetch('https://internal.local/x'), 'ssrf_dns_private')
    expect(mockFetch.calls.length).toBe(0)
  })

  test('mixed public+private DNS → fetch NOT called, throws (any private record blocks)', async () => {
    const mockFetch = makeFetch({})
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'mixed.test': [PUBLIC_IP, '127.0.0.1'] }),
      fetchImpl: mockFetch.fn,
    })
    await expectSsrfError(safeFetch('https://mixed.test/x'), 'ssrf_dns_private')
    expect(mockFetch.calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Redirects (redirect: 'manual' is used by safeFetch)
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — redirects', () => {
  test('same-origin redirect (Location: /b) → second request IS made after re-validation', async () => {
    const mockFetch = makeFetch({
      'https://example.com/a': { status: 302, headers: { Location: '/b' } },
      'https://example.com/b': { status: 200, body: { ok: true } },
    })
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'example.com': [PUBLIC_IP] }),
      fetchImpl: mockFetch.fn,
    })
    const res = await safeFetch('https://example.com/a', {
      allowedOrigin: 'https://example.com',
    })
    expect(res.status).toBe(200)
    expect(mockFetch.calls.length).toBe(2)
    expect(mockFetch.calls[0].url).toBe('https://example.com/a')
    expect(mockFetch.calls[1].url).toBe('https://example.com/b')
  })

  test('cross-origin redirect (Location: https://evil.com/b) → second request NOT made, throws ssrf_cross_origin', async () => {
    const mockFetch = makeFetch({
      'https://example.com/a': { status: 302, headers: { Location: 'https://evil.com/b' } },
    })
    const { safeFetch } = createSsrfGuard({
      // evil.com must resolve to a PUBLIC IP — assertPublicUrl runs BEFORE
      // the cross-origin check, so the DNS step must succeed for the
      // cross-origin guard to fire (and prevent the cross-origin fetch).
      dnsLookup: makeDns({
        'example.com': [PUBLIC_IP],
        'evil.com': [PUBLIC_IP_2],
      }),
      fetchImpl: mockFetch.fn,
    })
    await expectSsrfError(
      safeFetch('https://example.com/a', { allowedOrigin: 'https://example.com' }),
      'ssrf_cross_origin',
    )
    expect(mockFetch.calls.length).toBe(1) // only the original (example.com/a) request
    expect(mockFetch.calls[0].url).toBe('https://example.com/a')
    // The other-origin fetch was never made — no call to evil.com.
    expect(mockFetch.calls.some(c => c.url.includes('evil.com'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Authorization header — never forwarded cross-origin
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — Authorization header', () => {
  test('cross-origin redirect: Authorization NEVER sent to the other origin (other-origin fetch not called at all)', async () => {
    const mockFetch = makeFetch({
      'https://example.com/a': { status: 302, headers: { Location: 'https://evil.com/b' } },
    })
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({
        'example.com': [PUBLIC_IP],
        'evil.com': [PUBLIC_IP_2],
      }),
      fetchImpl: mockFetch.fn,
    })
    await expectSsrfError(
      safeFetch('https://example.com/a', {
        headers: { Authorization: 'Bearer secret' },
        allowedOrigin: 'https://example.com',
      }),
      'ssrf_cross_origin',
    )
    // The other-origin fetch is never made — Authorization cannot leak.
    expect(mockFetch.calls.length).toBe(1)
    expect(mockFetch.calls.some(c => c.url.includes('evil.com'))).toBe(false)
    // The original (same-origin) request DID carry Authorization.
    const originalHeaders = new Headers(mockFetch.calls[0].init?.headers as HeadersInit)
    expect(originalHeaders.get('Authorization')).toBe('Bearer secret')
  })

  test('same-origin redirect: Authorization IS forwarded on both requests (sanity)', async () => {
    const mockFetch = makeFetch({
      'https://example.com/a': { status: 302, headers: { Location: '/b' } },
      'https://example.com/b': { status: 200, body: { ok: true } },
    })
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'example.com': [PUBLIC_IP] }),
      fetchImpl: mockFetch.fn,
    })
    await safeFetch('https://example.com/a', {
      headers: { Authorization: 'Bearer secret' },
      allowedOrigin: 'https://example.com',
    })
    expect(mockFetch.calls.length).toBe(2)
    for (const call of mockFetch.calls) {
      const h = new Headers(call.init?.headers as HeadersInit)
      expect(h.get('Authorization')).toBe('Bearer secret')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Timeout — AbortError → ssrf_timeout
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — timeout', () => {
  test('fetch aborts with AbortError → safeFetch throws ssrf_timeout', async () => {
    const mockFetch = async (): Promise<Response> => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    }
    const { safeFetch } = createSsrfGuard({
      dnsLookup: makeDns({ 'example.com': [PUBLIC_IP] }),
      fetchImpl: mockFetch,
    })
    await expectSsrfError(safeFetch('https://example.com/x'), 'ssrf_timeout')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// WooCommerce cross-origin Link header — explicit bounded security failure
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF behavioral — WooCommerce cross-origin Link header', () => {
  const wooConfig = {
    storeUrl: 'https://shop.example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
  }

  test('cross-origin Link header → throws ssrf_cross_origin_link', async () => {
    // Mock safeFetch returns a 200 with a cross-origin Link header pointing
    // at evil.com — the sync must NOT follow it; it must throw.
    const mockSafeFetch = async (): Promise<Response> =>
      new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Link: '<https://evil.com/wp-json/wc/v3/products?page=2>; rel="next"',
        },
      })
    await expectSsrfError(
      fetchProductPage(
        'https://shop.example.com/wp-json/wc/v3/products',
        wooConfig,
        1,
        { safeFetch: mockSafeFetch },
      ),
      'ssrf_cross_origin_link',
    )
  })

  test('malformed Link header URL → throws ssrf_link_malformed', async () => {
    const mockSafeFetch = async (): Promise<Response> =>
      new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Link: '<not-a-valid-url>; rel="next"',
        },
      })
    await expectSsrfError(
      fetchProductPage(
        'https://shop.example.com/wp-json/wc/v3/products',
        wooConfig,
        1,
        { safeFetch: mockSafeFetch },
      ),
      'ssrf_link_malformed',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
// SECONDARY static source-inspection regression (max 2-3, clearly marked)
// These do NOT replace the behavioral tests above — they are a fast
// secondary check that the guard's key defensive primitives have not been
// accidentally deleted from the source.
// ─────────────────────────────────────────────────────────────────────────

describe('SSRF static regression (source-inspection — SECONDARY)', () => {
  function readSrc(relPath: string): string {
    return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
  }

  test('static: safeFetch uses redirect: manual', () => {
    const source = readSrc('src/lib/security/ssrf-guard.ts')
    expect(source).toContain("redirect: 'manual'")
  })

  test('static: safeFetch uses AbortController timeout', () => {
    const source = readSrc('src/lib/security/ssrf-guard.ts')
    expect(source).toContain('AbortController')
  })

  test('static: ssrf_cross_origin error code is present', () => {
    const source = readSrc('src/lib/security/ssrf-guard.ts')
    expect(source).toContain('ssrf_cross_origin')
  })
})
