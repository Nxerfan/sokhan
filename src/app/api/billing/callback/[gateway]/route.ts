import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getGateway, isValidGateway } from '@/lib/payments'
import { getPlan } from '@/lib/payments/plans'

/**
 * Payment gateway callback handler.
 *
 * The gateway redirects the customer back here after they complete (or cancel)
 * the payment. We look up the invoice by `invoiceId` query param, verify the
 * payment with the gateway, and update the invoice + subscription + tenant
 * accordingly. Finally we redirect to the dashboard with a success/error
 * query param.
 *
 * Gateway-specific params:
 *   - ZarinPal:  Authority + Status (status OK = "OK")
 *   - IDPay:     track_id + order_id + status (status 100/101 = paid)
 *   - ZarinLink: simple success/fail (pid + status)
 *
 * In test mode, the gateway always returns success — the adapter simulates
 * verification.
 */

function redirectUrl(status: 'success' | 'error' | 'canceled', message?: string): string {
  const params = new URLSearchParams({ billing: status })
  if (message) params.set('message', message)
  return `/?${params.toString()}#billing`
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ gateway: string }> },
) {
  const { gateway: gatewayName } = await params
  const url = new URL(req.url)
  const invoiceId = url.searchParams.get('invoiceId')

  if (!isValidGateway(gatewayName)) {
    return NextResponse.redirect(new URL(redirectUrl('error', 'invalid_gateway'), url.origin))
  }

  if (!invoiceId) {
    return NextResponse.redirect(new URL(redirectUrl('error', 'missing_invoice'), url.origin))
  }

  // Look up the invoice (no tenant context — the callback is hit by the
  // gateway, not by an authenticated user).
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { subscription: true, plan: true },
  })

  if (!invoice) {
    return NextResponse.redirect(new URL(redirectUrl('error', 'invoice_not_found'), url.origin))
  }

  // Already paid — idempotent success redirect.
  if (invoice.status === 'paid') {
    return NextResponse.redirect(new URL(redirectUrl('success'), url.origin))
  }

  // Read gateway-specific status param to detect cancellation early.
  const zarinpalStatus = url.searchParams.get('Status')
  const idpayStatus = url.searchParams.get('status')
  const zarinlinkStatus = url.searchParams.get('status')

  // ZarinPal: Status=NOK means user cancelled.
  if (gatewayName === 'zarinpal' && zarinpalStatus && zarinpalStatus.toUpperCase() === 'NOK') {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'failed' },
    })
    await db.subscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: 'canceled', canceledAt: new Date() },
    })
    return NextResponse.redirect(new URL(redirectUrl('canceled'), url.origin))
  }

  // IDPay: status 10 = cancelled by user.
  if (gatewayName === 'idpay' && idpayStatus === '10') {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'failed' },
    })
    await db.subscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: 'canceled', canceledAt: new Date() },
    })
    return NextResponse.redirect(new URL(redirectUrl('canceled'), url.origin))
  }

  // ZarinLink: status=fail or status=cancel.
  if (gatewayName === 'zarinlink' && zarinlinkStatus && ['fail', 'cancel'].includes(zarinlinkStatus)) {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'failed' },
    })
    await db.subscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: 'canceled', canceledAt: new Date() },
    })
    return NextResponse.redirect(new URL(redirectUrl('canceled'), url.origin))
  }

  // Use the stored authority to verify.
  const authority = invoice.authority ?? ''
  if (!authority) {
    return NextResponse.redirect(new URL(redirectUrl('error', 'missing_authority'), url.origin))
  }

  const gateway = getGateway(gatewayName)
  let verify
  try {
    verify = await gateway.verifyPayment({
      authority,
      amount: invoice.amountToman,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'verify_error'
    return NextResponse.redirect(new URL(redirectUrl('error', message), url.origin))
  }

  if (!verify.success) {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'failed' },
    })
    await db.subscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: 'canceled', canceledAt: new Date() },
    })
    return NextResponse.redirect(new URL(redirectUrl('error', verify.message), url.origin))
  }

  // Payment verified — mark invoice paid, activate subscription, update tenant.
  const now = new Date()
  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'paid',
      refId: verify.refId ?? null,
      paidAt: now,
    },
  })

  await db.subscription.update({
    where: { id: invoice.subscriptionId },
    data: {
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()),
    },
  })

  // Update tenant.plan to the new plan slug (look up from the plan row).
  const plan = invoice.plan
  if (plan) {
    await db.tenant.update({
      where: { id: invoice.tenantId },
      data: { plan: plan.slug },
    })
  }

  // Sanity: confirm the plan slug exists in the catalog.
  if (plan && !getPlan(plan.slug)) {
    // Don't fail the redirect — just log. The tenant.plan column will hold
    // the slug even if the catalog is stale.
    console.warn(`[billing/callback] plan slug "${plan.slug}" not found in catalog`)
  }

  return NextResponse.redirect(new URL(redirectUrl('success'), url.origin))
}
