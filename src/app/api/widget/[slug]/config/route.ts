import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getEffectiveWidgetConfig } from '@/lib/payments/free-plan'
import { checkMessageLimit } from '@/lib/payments/free-plan'
import { getRequestDomain, isDomainAllowed } from '@/lib/payments/domain-validation'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } })
}

/**
 * Public widget configuration, resolved by tenant slug.
 * Free plan: returns LOCKED defaults (Sukhan brand, no customization).
 * Paid plans: returns the tenant's configured values.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const tenant = await db.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, defaultLocale: true, defaultDirection: true },
  })
  if (!tenant) {
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Domain validation
  const domain = getRequestDomain(req)
  const domainAllowed = await isDomainAllowed(tenant.id, domain)
  if (!domainAllowed) {
    return widgetHeaders(NextResponse.json({ error: 'domain_not_allowed' }, { status: 403 }))
  }

  // Free plan trial expiry check
  const messageCheck = await checkMessageLimit(tenant.id)
  if (!messageCheck.allowed && messageCheck.reason === 'trial_expired') {
    return widgetHeaders(NextResponse.json({ error: 'trial_expired' }, { status: 403 }))
  }

  // Get effective config (locked for free plan, custom for paid)
  const config = await getEffectiveWidgetConfig(tenant.id)
  if (!config) {
    return widgetHeaders(NextResponse.json({ error: 'not_configured' }, { status: 404 }))
  }

  return widgetHeaders(NextResponse.json({
    slug,
    name: tenant.name,
    ...config,
  }))
}
