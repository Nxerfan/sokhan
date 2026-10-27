import { NextResponse } from 'next/server'
import { db, globalDb } from '@/lib/db'
import { getEffectiveWidgetConfig } from '@/lib/payments/free-plan'
import { checkMessageLimit } from '@/lib/payments/free-plan'
import { getRequestDomain, isDomainAllowed } from '@/lib/payments/domain-validation'
import { resolveRealtimeConfig } from '@/lib/realtime-config'
import { publicAccessConfig } from '@/lib/widget-access-policy'

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

  // Get effective VISUAL config (locked for free plan, custom for paid). The
  // visual customization plan-locking is INDEPENDENT of the visitor access
  // policy — a FREE tenant may have locked Sukhan visuals while still having
  // accessMode=verified_visitor (or site_user_only). Never force anonymous
  // merely because the tenant is on the free plan.
  const config = await getEffectiveWidgetConfig(tenant.id)
  if (!config) {
    return widgetHeaders(NextResponse.json({ error: 'not_configured' }, { status: 404 }))
  }

  // Fetch the REAL stored visitor access policy from WidgetConfig (NOT derived
  // from getEffectiveWidgetConfig — that returns visual-only fields). The
  // public route runs without a tenant session, so use globalDb (unscoped) for
  // the tenant-scoped WidgetConfig read (the lookup is by the unique tenantId).
  const widgetConfig = await globalDb.widgetConfig.findUnique({
    where: { tenantId: tenant.id },
    select: { accessMode: true, policyVersion: true, loginUrl: true, loginButtonLabel: true, loginReturnUrlParam: true, identityEndpointPath: true },
  })
  if (!widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  // publicAccessConfig strictly parses accessMode + policyVersion AND validates
  // the persisted public login fields against the SAME contract as dashboard
  // PATCH. A legacy unsafe value fail-closes -> null -> 503 policy_unavailable.
  // NEVER fabricates a fallback (anonymous) policy.
  const publicPolicy = publicAccessConfig(widgetConfig)
  if (!publicPolicy) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // Additive: realtime endpoint config so the cross-origin NPM widget does
  // not need to know deployment topology. Older clients ignore the field.
  const realtime = resolveRealtimeConfig()

  // Additive: the safe public access-policy fields. Existing clients continue
  // working (additive top-level fields). NEVER expose the raw integration
  // secret, integrationSecretHash, or any server-only credential — only the
  // explicitly safe policy fields selected above.
  return widgetHeaders(NextResponse.json({
    slug,
    name: tenant.name,
    ...config,
    ...publicPolicy,
    realtime,
  }))
}
