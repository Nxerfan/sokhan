import { NextResponse } from 'next/server'
import { withSessionTenant } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { resolveRealtimeConfig } from '@/lib/realtime-config'

/**
 * Authenticated, internal-only widget backend readiness check.
 *
 * IMPORTANT: this endpoint is NOT a "verify installation" check. It cannot
 * prove the script is installed on any customer website. It only verifies
 * Sukhan-side readiness — that the tenant, widget config, and script
 * endpoint are all configured and reachable from the Sukhan backend.
 *
 * It is intentionally distinct from the public widget-config endpoint
 * (`GET /api/widget/<slug>/config`):
 *   - The public endpoint performs WidgetDomain validation against the
 *     request Origin/Referer — meant to gate access from customer websites.
 *     Calling it from the Sukhan dashboard would send the dashboard's own
 *     origin, which is NOT registered as a WidgetDomain and would be
 *     incorrectly rejected as `domain_not_allowed`.
 *   - This internal endpoint is session-authenticated via `withSessionTenant`
 *     and does NOT consult WidgetDomain at all. It reads the tenant's own
 *     slug internally and reports readiness based on rows in the tenant's
 *     own DB tables.
 *
 * No SSRF: this endpoint does NOT fetch arbitrary customer URLs. It does
 * not accept any user-supplied URL input. The only "URL" it reports is
 * the Sukhan origin (the request's own host) — purely informational.
 *
 * Response shape:
 *   {
 *     ready: boolean,            // tenant + WidgetConfig both exist
 *     slug: string,              // tenant's public widget identifier
 *     hasConfig: boolean,        // WidgetConfig row exists for tenant
 *     scriptUrl: string,         // script tag URL the user should embed
 *     realtime: RealtimeConfig,  // same resolver used by the public endpoint
 *   }
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const tenant = await db.tenant.findUnique({
      where: { id: tid },
      select: { id: true, slug: true, name: true, defaultLocale: true },
    })
    if (!tenant) {
      return { ready: false, slug: null, hasConfig: false, scriptUrl: null, realtime: null } as const
    }
    const config = await db.widgetConfig.findUnique({ where: { tenantId: tid } })
    const realtime = resolveRealtimeConfig()
    return {
      ready: !!config,
      slug: tenant.slug,
      hasConfig: !!config,
      scriptUrl: `/api/widget/${tenant.slug}/script`,
      realtime,
    } as const
  })
  if (!result) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json(result.result)
}
