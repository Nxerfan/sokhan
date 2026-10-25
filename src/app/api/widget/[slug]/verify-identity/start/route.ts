import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { sendOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { coerceAccessMode } from '@/lib/widget-access-policy'

/** CORS headers. */
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
 * Verified Visitor OTP — START (verified_visitor access mode).
 *
 *   POST /api/widget/<slug>/verify-identity/start
 *   body: { email (REQUIRED), contactId (REQUIRED — from the prior /contact call) }
 *
 * Sends an email OTP to the visitor's email. The visitor must then call
 * /verify-identity/verify with the code to establish a verified_contact
 * identity + receive a resume credential.
 *
 * The contactId MUST already exist (created by the prior /contact call with
 * the visitor's visitorId). The OTP is tied to THAT Contact so verification
 * marks that Contact's emailVerifiedAt — no email-based Contact merging.
 *
 * Reuses the existing Nixify OTP infrastructure (sendOtp, purpose
 * 'visitor_verification' → mapped to Nixify 'login'). No parallel OTP
 * subsystem. Production OTP security (hashing, expiry, one-time, rate limit,
 * enumeration resistance) is inherited from the Nixify client + OtpRequest.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const ip = getClientIP(req)
  const rateLimit = await checkRateLimit(ip, slug)
  if (!rateLimit.allowed) {
    return widgetHeaders(NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 60) } },
    ))
  }

  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant) {
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const accessMode = coerceAccessMode(tenant.widgetConfig?.accessMode)
  if (accessMode !== 'verified_visitor') {
    // OTP verification is for Mode 1 only.
    return widgetHeaders(NextResponse.json(
      { error: 'mode_mismatch', message: 'OTP verification is for verified_visitor mode' },
      { status: 409 },
    ))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  }

  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200)
  const contactId = String(body.contactId ?? '').trim().slice(0, 100)
  if (!email || !isValidEmail(email)) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))
  }
  if (!contactId) {
    return widgetHeaders(NextResponse.json({ error: 'contactId_required' }, { status: 400 }))
  }

  // Verify the Contact exists (tenant-scoped) — it must have been created by
  // the prior /contact call. Tie the OTP to THIS contactId (no email-based merging).
  const contactExists = await withTenant(tenant.id, async () => {
    const c = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: contactId } },
      select: { id: true, identifier: true, tenantId: true },
    })
    // The contactId passed is the actual Contact.id (cuid), not the visitorId.
    // Look up by id instead.
    return db.contact.findFirst({ where: { id: contactId, tenantId: tenant.id }, select: { id: true } })
  })
  if (!contactExists) {
    return widgetHeaders(NextResponse.json({ error: 'contact_not_found' }, { status: 404 }))
  }

  // Reuse the Nixify OTP infrastructure.
  try {
    const result = await sendOtp(email, 'visitor_verification')
    await db.otpRequest.create({
      data: {
        email,
        purpose: 'visitor_verification',
        contactId: contactId,
        tenantId: tenant.id,
        requestId: result.otpRequestId,
        expiresAt: new Date(result.expiresAt),
      },
    })
    return widgetHeaders(NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt }))
  } catch (e) {
    if (e instanceof NixifyError) {
      return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    }
    console.error('[widget:verify-identity/start] internal error', { component: 'widget', route: 'verify-identity/start', errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }
}
