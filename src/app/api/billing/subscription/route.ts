import { NextResponse } from 'next/server'
import { withSessionTenant, getCurrentTenantId } from '@/lib/auth'
import { getBillingState, createProductionBillingDeps } from '@/lib/payments/billing-service'
import { getPlan } from '@/lib/payments/plans'
import { getTenantUsage } from '@/lib/payments/gating'

/**
 * Returns the current tenant's billing state.
 *
 * The ACTIVE subscription is the effective entitlement. A PENDING
 * subscription (if any) is a checkout in flight and does NOT affect the
 * current entitlement until its payment succeeds — the UI must distinguish
 * the two.
 *
 * Response shape:
 *   {
 *     plan: { slug, name, priceToman, interval, contactSales, limits } | null,
 *     subscription: { id, status, gateway, currentPeriodStart, currentPeriodEnd } | null,
 *       // ^ the ACTIVE (effective) subscription — null if on free with no
 *       //   active row.
 *     pendingSubscription: { id, status, gateway, currentPeriodEnd, createdAt } | null,
 *       // ^ a pending checkout, if any. Does NOT represent current service.
 *     invoices: [{ id, amountToman, gateway, status, refId, createdAt, paidAt }],
 *     usage: { ... }
 *   }
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const deps = createProductionBillingDeps()
    const [state, usage] = await Promise.all([
      getBillingState({ tenantId: tid, deps }),
      getTenantUsage(tid),
    ])
    return { state, usage } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { state, usage } = result.result
  const plan = getPlan(state.planSlug)

  return NextResponse.json({
    plan: plan
      ? {
          slug: plan.slug,
          name: plan.name,
          priceToman: plan.priceToman,
          interval: plan.interval,
          contactSales: plan.contactSales,
          limits: plan.limits,
        }
      : null,
    // The effective (active) subscription.
    subscription: state.activeSubscription
      ? {
          id: state.activeSubscription.id,
          status: state.activeSubscription.status,
          gateway: state.activeSubscription.gateway,
          currentPeriodStart: state.activeSubscription.currentPeriodStart,
          currentPeriodEnd: state.activeSubscription.currentPeriodEnd,
        }
      : null,
    // A pending checkout, if any — the UI shows this distinctly (NOT as the
    // current plan).
    pendingSubscription: state.pendingSubscription
      ? {
          id: state.pendingSubscription.id,
          status: state.pendingSubscription.status,
          gateway: state.pendingSubscription.gateway,
          currentPeriodEnd: state.pendingSubscription.currentPeriodEnd,
          createdAt: state.pendingSubscription.createdAt,
        }
      : null,
    invoices: state.invoices.map((i) => ({
      id: i.id,
      amountToman: i.amountToman,
      gateway: i.gateway,
      status: i.status,
      refId: i.refId,
      createdAt: i.createdAt,
      paidAt: i.paidAt,
    })),
    usage,
  })
}
