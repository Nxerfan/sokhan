/**
 * Widget domain validation.
 *
 * Validates that the requesting Origin/Referer header matches an allowed
 * domain for the tenant. Free plan: 1 domain, Pro: 3, Max: 8.
 */

import { db, withTenant } from '@/lib/db'
import { getPlan } from './plans'

/** Normalize a domain: lowercase, strip protocol/path/port. */
export function normalizeDomain(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .trim()
}

/**
 * Strict domain validator. Used when a domain is about to be PERSISTED to
 * the `WidgetDomain` table. Rejects anything that isn't a clean hostname
 * (optionally with a scheme).
 *
 * Rejected:
 *   - empty / whitespace-only
 *   - scheme-only strings ("http://", "https://")
 *   - path-only strings ("/path", "/")
 *   - URLs with credentials (user:pass@host)
 *   - control characters (\n, \r, \t, \0, etc.)
 *   - malformed hostnames (empty labels "example..com", leading/trailing dots)
 *   - URLs with a query or fragment
 *
 * Accepted (normalised to bare hostname):
 *   - "example.com"
 *   - "www.example.com" → "example.com" (www. stripped by normalizeDomain)
 *   - "https://example.com"
 *   - "http://example.com"
 *
 * Returns the normalised hostname (lowercase, no scheme, no www., no port,
 * no path) or throws an Error describing the rejection.
 */
export function validateDomain(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('domain must be a string')
  }
  const raw = input
  if (raw.trim() === '') {
    throw new Error('domain must not be empty')
  }

  // Reject any control characters (CR, LF, tab, NUL, etc.) — these could be
  // used to smuggle headers or confuse downstream parsers.
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error('domain must not contain control characters')
  }

  // Reject anything that looks like it has URL credentials before parsing —
  // `new URL` silently accepts "user:pass@host" which we never want to allow.
  if (/[\/@]/.test(raw) && raw.includes('@')) {
    throw new Error('domain must not contain URL credentials')
  }

  let parsed: URL
  let candidate: string
  if (/^https?:\/\//i.test(raw)) {
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error('domain is not a valid URL')
    }
    if (parsed.username || parsed.password) {
      throw new Error('domain must not contain URL credentials')
    }
    if (parsed.pathname && parsed.pathname !== '/') {
      throw new Error('domain must not contain a path')
    }
    if (parsed.search) {
      throw new Error('domain must not contain a query string')
    }
    if (parsed.hash) {
      throw new Error('domain must not contain a fragment')
    }
    candidate = parsed.hostname
  } else {
    // Bare hostname — but we still need to reject path-only or scheme-only.
    if (raw.startsWith('/') || raw.startsWith('.')) {
      throw new Error('domain must not be path-only')
    }
    if (/^[a-z]+:\/\//i.test(raw)) {
      // Some other scheme (ftp://, file://, etc.)
      throw new Error('only http(s) schemes allowed')
    }
    // Reject if there's any path/query/fragment — split on the first /, ?, #.
    const splitMatch = raw.split(/[/?#]/)[0]
    if (splitMatch === '') {
      throw new Error('domain hostname is empty')
    }
    candidate = splitMatch
  }

  candidate = candidate.toLowerCase().trim()
  if (candidate === '') {
    throw new Error('domain hostname is empty')
  }

  // Reject hostnames with empty labels ("example..com") or leading/trailing
  // dots. Each label must be 1-63 chars of [a-z0-9-] (no leading/trailing
  // hyphens).
  const labels = candidate.split('.')
  if (labels.length < 2) {
    // A bare TLD like "com" isn't a valid customer domain.
    throw new Error('domain must have at least one label and a TLD')
  }
  for (const label of labels) {
    if (label === '') {
      throw new Error('domain must not contain empty labels')
    }
    if (label.length > 63) {
      throw new Error('domain label too long')
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      throw new Error('domain label contains invalid characters')
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      throw new Error('domain label must not start or end with a hyphen')
    }
  }

  // Strip leading "www." for canonical comparison with stored domains.
  return candidate.replace(/^www\./, '')
}

/** Extract the domain from request headers (Origin or Referer). */
export function getRequestDomain(req: Request): string | null {
  const origin = req.headers.get('origin')
  if (origin) return normalizeDomain(origin)

  const referer = req.headers.get('referer')
  if (referer) return normalizeDomain(referer)

  return null
}

/**
 * Check if a domain is allowed for a tenant.
 * Returns true if the domain matches an allowed domain, or if no domains
 * are configured yet (backward compat — first request auto-registers).
 */
export async function isDomainAllowed(tenantId: string, domain: string | null): Promise<boolean> {
  if (!domain) return true // No domain header — allow (could be a direct API call)

  // WidgetDomain is a tenant-scoped model — must run inside withTenant.
  return withTenant(tenantId, async () => {
    const domains = await db.widgetDomain.findMany({
      select: { domain: true },
    })

    // If no domains configured, allow all (backward compat for existing tenants)
    if (domains.length === 0) return true

    return domains.some(d => d.domain === domain)
  })
}

/** Get the website limit for a tenant's plan. */
export async function getWebsiteLimit(tenantId: string): Promise<number> {
  // Tenant is a global model (not in TENANT_SCOPED_MODELS) — no withTenant wrap needed.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  })
  if (!tenant) return 0

  const plan = getPlan(tenant.plan)
  return plan?.limits.websites ?? 0
}
