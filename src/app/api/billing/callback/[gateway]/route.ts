import { NextResponse, NextRequest } from 'next/server'
import {
  handleCallback,
  createProductionBillingDeps,
  type CallbackRedirect,
} from '@/lib/payments/billing-service'
import { isValidGateway } from '@/lib/payments'

/**
 * Payment gateway callback handler.
 *
 * Unauthenticated (the gateway hits this, not a logged-in user). All billing
 * logic lives in `handleCallback` (src/lib/payments/billing-service.ts):
 *   - NARROW globalDb invoice lookup → withTenant(invoice.tenantId).
 *   - gateway bind (stored gateway === path gateway).
 *   - authority bind (stored authority is the source of truth).
 *   - idempotency (paid is terminal — duplicate success is a no-op).
 *   - expiry (derived from Invoice.createdAt — no schema change).
 *   - atomic success transaction (invoice→paid + new sub→active + prior
 *     active→canceled + tenant.plan, in ONE transaction).
 *   - cancel/failure after paid is a no-op (paid cannot regress).
 *
 * The redirect status derives from the FINAL PERSISTED DB state — never from
 * the raw provider response. Bounded error codes only; no secrets, raw
 * provider bodies, or stack traces in the redirect query.
 */

function buildRedirect(
  redirect: CallbackRedirect,
  code: string | undefined,
  origin: string,
): URL {
  const params = new URLSearchParams({ billing: redirect })
  // Only surface bounded machine-readable codes — never raw provider messages.
  if (code) params.set('code', code)
  return new URL(`/?${params.toString()}#billing`, origin)
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ gateway: string }> },
) {
  const { gateway: gatewayName } = await params
  const url = new URL(req.url)
  const invoiceId = url.searchParams.get('invoiceId') ?? ''

  // Validate the path gateway against the production set. The mock provider
  // is NOT reachable here (production deps exclude it).
  if (!isValidGateway(gatewayName as any)) {
    return NextResponse.redirect(buildRedirect('error', 'invalid_gateway', url.origin))
  }
  if (!invoiceId) {
    return NextResponse.redirect(buildRedirect('error', 'missing_invoice', url.origin))
  }

  const deps = createProductionBillingDeps()
  const result = await handleCallback({
    gatewayName,
    invoiceId,
    query: url.searchParams,
    origin: url.origin,
    deps,
  })

  return NextResponse.redirect(buildRedirect(result.redirect, result.code, url.origin))
}
