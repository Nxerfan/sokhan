import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { getPlan } from '@/lib/payments/plans'
import type { PlanSlug } from '@/lib/payments/plans'

/**
 * DEV-ONLY tenant plan change — CI test barrier (D6, BLOCKER 3).
 *
 *   POST  /api/invitations/dev/set-plan   body: { plan }
 *
 * Deterministically changes the CURRENT tenant's effective plan for the
 * behavioral plan-downgrade test (D6). Mutates ONLY the current tenant
 * (from the authenticated session), NOT an arbitrary public slug.
 *
 * GATING — this route is ONLY available when BOTH:
 *   - process.env.NIXIFY_MOCK === 'true'   (OTP-provider mock flag)
 *   - process.env.SUKHAN_TEST_HARNESS === 'true'  (dedicated test-harness flag)
 *
 * `NIXIFY_MOCK` is the OTP mock flag — it must NOT double as the sole
 * authorization for arbitrary tenant-plan mutation (BLOCKER 3). The
 * dedicated `SUKHAN_TEST_HARNESS` flag is set ONLY in Docker test
 * overrides (docker-compose.test.yml, docker-compose.lite.test.yml) +
 * the GitHub Actions docker-regression job env. Production compose +
 * Vercel leave it UNSET. This route therefore returns 404 in any
 * production deployment (Vercel preview included), and in any Docker
 * stack that is NOT using the test override compose.
 *
 * AUTHORIZATION
 *   - Requires an authenticated session (withSessionTenant — 401 if none).
 *   - Actor must be owner or admin of the CURRENT tenant
 *     (hasRole(session.user.role, 'admin') — owner rank 5, admin rank 4).
 *   - Mutates ONLY the current tenant (getCurrentTenantId()) — there is
 *     NO workspace-slug parameter. A user cannot mutate a foreign tenant
 *     through this route. A test helper that needs to change a specific
 *     tenant's plan must authenticate as that tenant's owner/admin first.
 *
 * The 404 (for missing flags) is identical to the "not found" error so
 * the route's existence is not leakable. No secret values in source.
 */
export async function POST(req: NextRequest) {
  // Hard gate — BOTH flags required. NEVER available in production or
  // without the dedicated test-harness flag.
  if (
    process.env.NIXIFY_MOCK !== 'true' ||
    process.env.SUKHAN_TEST_HARNESS !== 'true'
  ) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Require an authenticated owner/admin session. Mutates ONLY the
  // current tenant.
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    const body = await req.json().catch(() => null)
    const plan = String(body?.plan ?? '').trim() as PlanSlug
    if (!plan) {
      return { error: 'missing_plan' as const }
    }

    // Validate the plan slug against the catalog.
    const planObj = getPlan(plan)
    if (!planObj) {
      return { error: 'invalid_plan' as const }
    }

    const tid = getCurrentTenantId()!

    // Set the plan directly on the CURRENT tenant row. db.tenant routes
    // through the per-tenant extended client (Tenant is global → no
    // tenant-scoped handler → passthrough to base client). The where
    // clause uses the current tenantId only — no foreign-tenant mutation
    // is possible.
    await db.tenant.update({
      where: { id: tid },
      data: { plan, updatedAt: new Date() },
    })

    return { ok: true as const, plan, tenantId: tid } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('error' in result.result) {
    const err = result.result.error
    const status = err === 'missing_plan' || err === 'invalid_plan' ? 400 : 400
    return NextResponse.json({ error: err }, { status })
  }
  return NextResponse.json({ ok: true, plan: result.result.plan, tenantId: result.result.tenantId })
}
