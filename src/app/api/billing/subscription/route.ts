import { NextResponse } from 'next/server'
import { withSessionTenant, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { getTenantUsage } from '@/lib/payments/gating'
import { getPlan } from '@/lib/payments/plans'

/**
 * Returns the current tenant's subscription status + usage stats.
 *
 * Response shape:
 *   {
 *     plan: { slug, name, priceToman, limits, ... },
 *     subscription: { id, status, gateway, currentPeriodStart, currentPeriodEnd } | null,
 *     invoices: [{ id, amountToman, gateway, status, refId, createdAt, paidAt }],
 *     usage: { agents: {current, limit}, conversations: {...}, departments: {...} }
 *   }
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!

    const [usage, subscription, invoices] = await Promise.all([
      getTenantUsage(tid),
      db.subscription.findFirst({
        where: { tenantId: tid, status: { in: ['active', 'pending'] } },
        orderBy: { createdAt: 'desc' },
      }),
      db.invoice.findMany({
        where: { tenantId: tid },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ])

    const plan = getPlan(usage.planSlug)

    return { usage, subscription, invoices, plan } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { usage, subscription, invoices, plan } = result.result
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
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          gateway: subscription.gateway,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }
      : null,
    invoices: invoices.map((i) => ({
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
