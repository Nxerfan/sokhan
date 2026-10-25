import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { sendOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'

function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200
}
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

/**
 * Verified Visitor OTP — START (Blockers #1, #2, #8).
 *
 * #1: does NOT write unverified profile data to Contact. Pending email + name
 * are stored on WidgetOtpRequest (pendingName + email). Contact.email/name/
 * emailVerifiedAt are NOT mutated at START. Only after successful verification
 * (inside the verify route's transaction) are Contact.email/name/emailVerifiedAt
 * updated atomically with WidgetOtpRequest.verified.
 *
 * #2: when resolving an existing Contact by (tenant, visitorId), requires
 * identifierType='visitorId' + externalUserId=null. If the visitorId collides
 * with an external-user Contact's opaque identifier → identity_conflict (403).
 * Does NOT mutate that Contact. Does NOT send an OTP.
 *
 * #8: starting a NEW verification supersedes any previous unverified active
 * WidgetOtpRequest for the same Contact (expires the old ones in the same
 * transaction that creates the new one). One authoritative active flow per
 * Contact. Old providerRequestId becomes unusable for local verification.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const ip = getClientIP(req)
  const rateLimit = await checkRateLimit(ip, slug)
  if (!rateLimit.allowed) {
    return widgetHeaders(NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 60) } }))
  }
  const tenant = await db.tenant.findUnique({ where: { slug }, include: { widgetConfig: true } })
  if (!tenant) return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  const accessMode = parseAccessMode(tenant.widgetConfig?.accessMode)
  if (accessMode !== 'verified_visitor') {
    return widgetHeaders(NextResponse.json({ error: 'mode_mismatch', message: 'OTP verification is for verified_visitor mode' }, { status: 409 }))
  }
  const policyVersion = parsePolicyVersion(tenant.widgetConfig?.policyVersion)
  if (policyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 100) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : undefined
  if (!visitorId) return widgetHeaders(NextResponse.json({ error: 'visitorId_required' }, { status: 400 }))
  if (!email || !isValidEmail(email)) return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))

  // #1 + #2: resolve/create the Contact by (tenant, visitorId) — NO Contact
  // profile mutation. Check identifierType + externalUserId on existing.
  const contactResult = await withTenant(tenant.id, async () => {
    let c = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
    })
    if (!c) {
      // #1: create ONLY the minimal anonymous identity record. Email/name are
      // NOT stored on the Contact (they're pending on WidgetOtpRequest).
      c = await db.contact.create({
        data: {
          tenantId: tenant.id, identifier: visitorId, identifierType: 'visitorId',
          name: 'Visitor', email: null, locale: tenant.defaultLocale, metadata: {},
        },
      })
      return { ok: true as const, contactId: c.id }
    }
    // #2: enforce the anonymous identity class.
    if (c.identifierType !== 'visitorId' || c.externalUserId !== null) {
      return { ok: false as const, reason: 'identity_conflict' }
    }
    return { ok: true as const, contactId: c.id }
  })
  if (!contactResult.ok) {
    return widgetHeaders(NextResponse.json({ error: contactResult.reason }, { status: 403 }))
  }
  const contactId = contactResult.contactId

  // Call Nixify sendOtp (reuse the existing infrastructure).
  try {
    const result = await sendOtp(email, 'widget_verify')
    // #1: store pending email + pendingName on WidgetOtpRequest (NOT on Contact).
    // #8: supersede previous unverified active requests for this Contact in the
    // same transaction that creates the new request (one active flow per Contact).
    await withTenant(tenant.id, async () => {
      await db.$transaction(async (tx) => {
        // Expire old unverified active requests for this Contact.
        await tx.widgetOtpRequest.updateMany({
          where: { contactId, verified: false, expiresAt: { gt: new Date() } },
          data: { status: 'superseded', expiresAt: new Date() },
        })
        // Create the new authoritative request.
        await tx.widgetOtpRequest.create({
          data: {
            tenantId: tenant.id, contactId, email,
            pendingName: name ?? null,
            purpose: 'widget_verify',
            providerRequestId: result.otpRequestId,
            expiresAt: new Date(result.expiresAt),
            ipAddress: ip,
          },
        })
      })
    })
    return widgetHeaders(NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt }))
  } catch (e) {
    if (e instanceof NixifyError) return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    console.error('[widget:verify-identity/start] internal error', { component: 'widget', route: 'verify-identity/start', errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }
}
