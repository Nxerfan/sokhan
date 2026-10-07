/**
 * SSRF protection layer for outbound HTTP requests.
 *
 * Blocks: localhost, loopback, private IPv4/IPv6, link-local,
 * metadata endpoints (169.254.169.254), and hostnames that
 * resolve to private/reserved IP ranges.
 */

import { lookup } from 'node:dns/promises'
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

export async function assertPublicUrl(urlStr: string): Promise<URL> {
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
  const hostname = parsed.hostname
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
      const records = await lookup(hostname, { all: true })
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

export async function safeFetch(
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
      const res = await fetch(currentUrl, {
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

export async function validateOutboundUrl(urlStr: string): Promise<void> {
  await assertPublicUrl(urlStr)
}
