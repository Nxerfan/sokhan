import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { getPlan, isPaidPlan, ensurePlansSeeded } from '@/lib/payments/plans'
import { getGateway, isValidGateway } from '@/lib/payments'

/**
 * Create a payment for a plan.
 *
 * Body: { planSlug, gateway }
 *
 * Flow:
 *   1. Validate planSlug + gateway.
 *   2. For free plans: activate immediately, no payment needed.
 *   3. For paid plans: create a Subscription (status: pending) + Invoice
 *      (status: pending), call the gateway adapter, return the gateway URL
 *      for the client to redirect to.
 *
 * The callback URL is `/api/billing/callback/{gateway}?invoiceId=...`. The
 * invoiceId is used by the callback to look up the invoice + verify the
 * payment.
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    const body = await req.json().catch(() => null)
    const planSlug = String(body?.planSlug ?? '')
    const gatewayName = String(body?.gateway ?? '')
    const tid = getCurrentTenantId()!

    const plan = getPlan(planSlug)
    if (!plan) return { error: 'invalid_plan' as const }
    if (!isValidGateway(gatewayName)) return { error: 'invalid_gateway' as const }

    // Make sure the DB catalog is in sync.
    await ensurePlansSeeded()
    const planRow = await db.plan.findUnique({ where: { slug: planSlug } })
    if (!planRow) return { error: 'plan_not_found' as const }

    // Free plan: activate immediately, no payment.
    if (!isPaidPlan(planSlug)) {
      // Mark any existing active subscription as canceled.
      await db.subscription.updateMany({
        where: { tenantId: tid, status: 'active' },
        data: { status: 'canceled', canceledAt: new Date() },
      })
      // Create a new active subscription for the free plan.
      const now = new Date()
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      const subscription = await db.subscription.create({
        data: {
          tenantId: tid,
          planId: planRow.id,
          status: 'active',
          gateway: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      })
      // Update tenant.plan.
      await db.tenant.update({ where: { id: tid }, data: { plan: planSlug } })
      return {
        free: true as const,
        subscription,
        gatewayUrl: null,
      }
    }

    // Paid plan: create pending subscription + invoice, call gateway.
    // Mark any existing active subscription as canceled (will be replaced).
    await db.subscription.updateMany({
      where: { tenantId: tid, status: 'active' },
      data: { status: 'canceled', canceledAt: new Date() },
    })

    const now = new Date()
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
    const subscription = await db.subscription.create({
      data: {
        tenantId: tid,
        planId: planRow.id,
        status: 'pending',
        gateway: gatewayName,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    })

    // Build callback URL. The invoiceId is passed as a query param so the
    // callback handler can look up the invoice + verify.
    const origin = new URL(req.url).origin
    const callbackUrl = `${origin}/api/billing/callback/${gatewayName}?invoiceId=PLACEHOLDER`

    const gateway = getGateway(gatewayName)
    const created = await gateway.createPayment({
      amount: plan.priceToman,
      description: `${plan.name} plan — ${plan.priceToman.toLocaleString()} Toman`,
      callbackUrl,
    })

    // Create the invoice with the authority, then patch the callbackUrl with
    // the real invoice id.
    const invoice = await db.invoice.create({
      data: {
        tenantId: tid,
        subscriptionId: subscription.id,
        planId: planRow.id,
        amountToman: plan.priceToman,
        gateway: gatewayName,
        authority: created.authority,
        status: 'pending',
        callbackUrl: `${origin}/api/billing/callback/${gatewayName}?invoiceId=PLACEHOLDER`,
      },
    })

    // Update callbackUrl with the real invoice id (so the gateway redirects
    // back with the invoice id in the query string).
    const realCallbackUrl = `${origin}/api/billing/callback/${gatewayName}?invoiceId=${invoice.id}`
    await db.invoice.update({
      where: { id: invoice.id },
      data: { callbackUrl: realCallbackUrl },
    })

    return {
      free: false as const,
      subscription,
      invoice,
      gateway: gatewayName,
      authority: created.authority,
      gatewayUrl: created.gatewayUrl,
    } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })

  const r = result.result
  if (r.free) {
    return NextResponse.json({
      free: true,
      subscriptionId: r.subscription.id,
      gatewayUrl: null,
    })
  }

  return NextResponse.json({
    free: false,
    subscriptionId: r.subscription.id,
    invoiceId: r.invoice.id,
    gateway: r.gateway,
    authority: r.authority,
    gatewayUrl: r.gatewayUrl,
    testMode: getGateway(r.gateway).testMode,
  })
}
