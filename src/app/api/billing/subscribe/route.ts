import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { isPaidPlan } from '@/lib/payments/plans'
import {
  createCheckout,
  transitionToFreePlan,
  createProductionBillingDeps,
  BillingError,
} from '@/lib/payments/billing-service'
import { isValidGateway } from '@/lib/payments'

/**
 * Create a payment for a plan (or transition to free internally).
 *
 * Body: { planSlug, gateway }
 *
 *   - Free / zero-price plan: internal transition (transitionToFreePlan) —
 *     no provider call, no Invoice.
 *   - Paid plan: createCheckout — pending Subscription + pending Invoice with
 *     a REAL invoice.id callback URL, then provider.createPayment. The
 *     existing ACTIVE subscription is preserved until payment verifies.
 *
 * Authorization: tenant admin only.
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    // Input validation — reject non-string / malformed. No String() coercion.
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'invalid_body' as const }
    }
    const { planSlug, gateway: gatewayName } = body as Record<string, unknown>
    if (typeof planSlug !== 'string' || planSlug.trim() === '') {
      return { error: 'invalid_plan' as const }
    }
    if (typeof gatewayName !== 'string' || gatewayName.trim() === '') {
      return { error: 'invalid_gateway' as const }
    }
    if (!isValidGateway(gatewayName as any)) {
      return { error: 'invalid_gateway' as const }
    }

    const tid = getCurrentTenantId()!
    const origin = new URL(req.url).origin
    const deps = createProductionBillingDeps()

    // Free / zero-price plan: internal transition (no provider).
    if (!isPaidPlan(planSlug)) {
      try {
        const { subscriptionId } = await transitionToFreePlan({ tenantId: tid, deps })
        return { free: true as const, subscriptionId, gatewayUrl: null }
      } catch (err) {
        return { error: billingErrorCode(err) }
      }
    }

    // Paid plan: checkout flow.
    try {
      const checkout = await createCheckout({
        tenantId: tid,
        planSlug,
        gatewayName,
        origin,
        deps,
      })
      return { checkout } as const
    } catch (err) {
      return { error: billingErrorCode(err) }
    }
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('error' in result.result) {
    return NextResponse.json({ error: result.result.error }, { status: 400 })
  }

  const r = result.result
  if ('free' in r && r.free) {
    return NextResponse.json({
      free: true,
      subscriptionId: r.subscriptionId,
      gatewayUrl: null,
    })
  }

  const c = r.checkout
  return NextResponse.json({
    free: false,
    subscriptionId: c.subscriptionId,
    invoiceId: c.invoiceId,
    gateway: c.gateway,
    authority: c.authority,
    gatewayUrl: c.gatewayUrl,
    testMode: c.testMode,
  })
}

/** Map a BillingError to its bounded code; unknown errors → 'internal_error'. */
function billingErrorCode(err: unknown): string {
  if (err instanceof BillingError) return err.code
  return 'internal_error'
}
