/**
 * Widget domain validation.
 *
 * Validates that the requesting Origin/Referer header matches an allowed
 * domain for the tenant. Free plan: 1 domain, Pro: 3, Max: 8.
 */

import { db } from '@/lib/db'
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

  const domains = await db.widgetDomain.findMany({
    where: { tenantId },
    select: { domain: true },
  })

  // If no domains configured, allow all (backward compat for existing tenants)
  if (domains.length === 0) return true

  return domains.some(d => d.domain === domain)
}

/** Get the website limit for a tenant's plan. */
export async function getWebsiteLimit(tenantId: string): Promise<number> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  })
  if (!tenant) return 0

  const plan = getPlan(tenant.plan)
  return plan?.limits.websites ?? 0
}
