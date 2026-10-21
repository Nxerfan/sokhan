import { NextResponse, NextRequest } from 'next/server'
import { globalDb, withTenant, db } from '@/lib/db'
import { getPlan } from '@/lib/payments/plans'
import type { PlanSlug } from '@/lib/payments/plans'

/**
 * DEV-ONLY tenant plan change — CI test barrier (D6, BLOCKER 3).
 *
 *   POST  /api/invitations/dev/set-plan   body: { workspace, plan }
 *
 * Deterministically changes the tenant's effective plan for the behavioral
 * plan-downgrade test (D6). The accept route's transactional plan-limit
 * re-check reads the plan via `resolveTenantPlanSlug`, which checks for an
 * active Subscription first, then falls back to `tenant.plan`. This endpoint
 * sets `tenant.plan` directly (no Subscription is created), so the fallback
 * path is exercised.
 *
 * GATING — this route is ONLY available when BOTH:
 *   - process.env.NODE_ENV !== 'production'
 *   - process.env.NIXIFY_MOCK === 'true'
 *
 * `NIXIFY_MOCK=true` is the CI/dev mock-OTP flag — it is NEVER set in
 * production (production requires a real Nixify API key). This route
 * therefore returns 404 in any production deployment, Vercel preview
 * included (Vercel sets NODE_ENV=production). The 404 is identical to
 * the "not found" error so the route's existence is not leakable.
 *
 * SECURITY
 * --------
 *   - The `workspace` is the public tenant slug — resolves to a tenantId
 *     via a GLOBAL Tenant.findUnique (Tenant is not tenant-scoped).
 *   - The `plan` must be a valid PlanSlug ('free' | 'pro' | 'max' |
 *     'self-hosted'). Invalid slugs are rejected.
 *   - No authentication required — this is a CI barrier that mutates the
 *     plan directly. It is gated by the env flags above, NOT by a session.
 *     (In CI, the test orchestrator sets NIXIFY_MOCK=true; in production,
 *     the route does not exist.)
 *   - Only mutates `tenant.plan` + `tenant.updatedAt`. No other field.
 */
export async function POST(req: NextRequest) {
  // Hard gate — NEVER available in production or without the CI mock flag.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NIXIFY_MOCK !== 'true'
  ) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const slug = String(body?.workspace ?? '').trim()
  const plan = String(body?.plan ?? '').trim() as PlanSlug

  if (!slug || !plan) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Validate the plan slug against the catalog.
  const planObj = getPlan(plan)
  if (!planObj) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Resolve slug → tenantId (Tenant is a global model).
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    select: { id: true, plan: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Set the plan directly on the Tenant row. The accept route's
  // resolveTenantPlanSlug checks for an active Subscription first (none
  // here), then falls back to tenant.plan — so this is the value the
  // plan-limit re-check will read.
  await withTenant(tenant.id, () =>
    db.tenant.update({
      where: { id: tenant.id },
      data: { plan, updatedAt: new Date() },
    }),
  )

  return NextResponse.json({ ok: true, plan, tenantId: tenant.id })
}
