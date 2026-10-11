/**
 * SSRF protection layer for outbound HTTP requests.
 *
 * Blocks: localhost, loopback, private IPv4/IPv6, link-local,
 * metadata endpoints (169.254.169.254), and hostnames that
 * resolve to private/reserved IP ranges.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEPENDENCY INJECTION (DI)
 * ─────────────────────────────────────────────────────────────────────────
 * Production code imports `assertPublicUrl` / `safeFetch` /
 * `validateOutboundUrl` from this module — these are wired to the
 * PRODUCTION instance of the guard built via `createSsrfGuard()` with NO
 * deps, which means:
 *   - DNS resolver = `node:dns/promises` `lookup` (default).
 *   - HTTP client  = the global `fetch` (default).
 * This is identical to the pre-DI implementation. Production behavior is
 * unchanged.
 *
 * For behavioral tests, `createSsrfGuard({ dnsLookup, fetchImpl })` returns
 * an ISOLATED guard instance with the injected DNS resolver and fetch
 * implementation. This lets tests mock DNS (return controlled IPs) and
 * fetch (record calls, return controlled responses including redirects)
 * WITHOUT any real internet access. Each test builds its own instance —
 * no module-level mutable state, no test-to-test state leakage.
 *
 * `SsrfError` remains a top-level export so existing callers (e.g. the
 * WooCommerce connector) can `instanceof`-check it.
 */

import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { URL } from 'node:url'
import net from 'node:net'

const PRIVATE_IPV4_RANGES = [
  /^127\./,
  /^0\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
]

export class SsrfError extends Error {
  constructor(message: string, public code: string = 'ssrf_blocked') {
    super(message)
    this.name = 'SsrfError'
  }
}

function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some(range => range.test(ip))
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower === '::') return true
  if (/^fe[89ab]/.test(lower)) return true
  if (/^f[cd]/.test(lower)) return true
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7)
    if (net.isIPv4(v4) && isPrivateIPv4(v4)) return true
  }
  return false
}

function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip)
  if (net.isIPv6(ip)) return isPrivateIPv6(ip)
  return true
}

// ─────────────────────────────────────────────────────────────────────────
// Dependency-injection types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Injectable DNS resolver signature. Mirrors the `node:dns/promises`
 * `lookup(hostname, { all: true })` overload used by `assertPublicUrl` —
 * returns ALL resolved addresses (one record per A/AAAA reply).
 */
export type SsrfDnsLookup = (
  hostname: string,
  options?: Record<string, unknown>,
) => Promise<LookupAddress[]>

/** Injectable HTTP client signature. Mirrors the global `fetch`. */
export type SsrfFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface SsrfDeps {
  /** DNS resolver. Defaults to `node:dns/promises` `lookup`. */
  dnsLookup?: SsrfDnsLookup
  /** HTTP client. Defaults to the global `fetch`. */
  fetchImpl?: SsrfFetch
}

/**
 * Wrap `node:dns/promises` `lookup` to satisfy the `SsrfDnsLookup` signature
 * (TS can't auto-narrow the overloaded `lookup` return type to the
 * `all: true` branch, so we cast at the boundary — runtime behavior is
 * exactly `lookup(hostname, { all: true })`).
 */
const defaultDnsLookup: SsrfDnsLookup = (hostname, options) =>
  lookup(hostname, options as any) as unknown as Promise<LookupAddress[]>

/** Wrap the global `fetch` to satisfy the `SsrfFetch` signature. */
const defaultFetch: SsrfFetch = (input, init) =>
  globalThis.fetch(input as any, init as any) as Promise<Response>

// ─────────────────────────────────────────────────────────────────────────
// Guard factory
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build an SSRF guard instance with the given (optional) dependencies.
 *
 * When `deps` is omitted or partial, the missing pieces fall back to the
 * production defaults (`node:dns/promises` `lookup` + global `fetch`). The
 * module-level exported `assertPublicUrl` / `safeFetch` /
 * `validateOutboundUrl` are simply `createSsrfGuard()` — i.e. the
 * production instance — so existing import sites see no behavior change.
 *
 * Tests build their own instance with mocked deps; production never calls
 * this with non-default deps.
 */
export function createSsrfGuard(deps: SsrfDeps = {}) {
  const dnsLookup: SsrfDnsLookup = deps.dnsLookup ?? defaultDnsLookup
  const fetchImpl: SsrfFetch = deps.fetchImpl ?? defaultFetch

  async function assertPublicUrl(urlStr: string): Promise<URL> {
    let parsed: URL
    try {
      parsed = new URL(urlStr)
    } catch {
      throw new SsrfError('Invalid URL', 'ssrf_invalid_url')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfError('Only http(s) schemes allowed', 'ssrf_bad_scheme')
    }
    if (parsed.username || parsed.password) {
      throw new SsrfError('URL credentials forbidden', 'ssrf_url_credentials')
    }
    const hostnameRaw = parsed.hostname
    // Bun's URL parser returns IPv6 literals WITH surrounding brackets
    // (e.g. `"[::1]"`) whereas Node returns the bare address (`"::1"`).
    // `net.isIP` returns 0 for a bracketed string, which would route IPv6
    // literals into the DNS-resolution branch instead of the IP-block
    // branch. Strip the brackets defensively — a no-op in Node production
    // (where the hostname is already bare), and a correctness fix under Bun.
    const hostname =
      hostnameRaw.length >= 2 && hostnameRaw.startsWith('[') && hostnameRaw.endsWith(']')
        ? hostnameRaw.slice(1, -1)
        : hostnameRaw
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new SsrfError('Localhost forbidden', 'ssrf_localhost')
    }
    if (net.isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        throw new SsrfError('Private/reserved IP forbidden', 'ssrf_private_ip')
      }
    } else {
      let addresses: string[]
      try {
        const records = await dnsLookup(hostname, { all: true })
        addresses = records.map(r => r.address)
      } catch {
        throw new SsrfError('DNS resolution failed', 'ssrf_dns_failed')
      }
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          throw new SsrfError(`Hostname resolves to private IP`, 'ssrf_dns_private')
        }
      }
    }
    return parsed
  }

  async function safeFetch(
    urlStr: string,
    options: RequestInit & { timeoutMs?: number; maxRedirects?: number; allowedOrigin?: string } = {},
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? 15000
    const maxRedirects = options.maxRedirects ?? 3
    const allowedOrigin = options.allowedOrigin
    let currentUrl = urlStr
    let redirectCount = 0
    const { headers: rawHeaders, ...restOptions } = options
    const headers = new Headers(rawHeaders)
    const authHeader = headers.get('Authorization')
    const origin = allowedOrigin ? new URL(allowedOrigin).origin : undefined

    for (;;) {
      const parsed = await assertPublicUrl(currentUrl)
      if (origin && parsed.origin !== origin) {
        throw new SsrfError('Cross-origin redirect forbidden', 'ssrf_cross_origin')
      }
      const reqHeaders = new Headers(headers)
      if (authHeader && origin && parsed.origin !== origin) {
        reqHeaders.delete('Authorization')
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(currentUrl, {
          ...restOptions,
          headers: reqHeaders,
          redirect: 'manual',
          signal: controller.signal,
        })
        if (res.status >= 300 && res.status < 400) {
          redirectCount++
          if (redirectCount > maxRedirects) {
            throw new SsrfError('Too many redirects', 'ssrf_too_many_redirects')
          }
          const location = res.headers.get('location')
          if (!location) break
          currentUrl = new URL(location, currentUrl).toString()
          continue
        }
        return res
      } catch (err) {
        if (err instanceof SsrfError) throw err
        if (err instanceof Error && err.name === 'AbortError') {
          throw new SsrfError('Request timed out', 'ssrf_timeout')
        }
        throw new SsrfError(
          `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
          'ssrf_network_error',
        )
      } finally {
        clearTimeout(timeout)
      }
    }
    // unreachable — for(;;) only exits via return or throw
    throw new SsrfError('Unreachable', 'ssrf_unreachable')
  }

  async function validateOutboundUrl(urlStr: string): Promise<void> {
    await assertPublicUrl(urlStr)
  }

  return { assertPublicUrl, safeFetch, validateOutboundUrl }
}

// ─────────────────────────────────────────────────────────────────────────
// Production instance — wired to `node:dns/promises` lookup + global fetch.
// These top-level exports are what application code imports; behavior is
// identical to the pre-DI implementation.
// ─────────────────────────────────────────────────────────────────────────

const _productionGuard = createSsrfGuard()
export const assertPublicUrl = _productionGuard.assertPublicUrl
export const safeFetch = _productionGuard.safeFetch
export const validateOutboundUrl = _productionGuard.validateOutboundUrl
