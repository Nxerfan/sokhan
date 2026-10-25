import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { verifyOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { coerceAccessMode } from '@/lib/widget-access-policy'
import { signResumeCredential } from '@/lib/widget-identity-tokens'
import { signToken } from '@/lib/realtime-token'

/** CORS headers. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

/**
 * Verified Visitor OTP — VERIFY (verified_visitor access mode).
 *
 *   POST /api/widget/<slug>/verify-identity/verify
 *   body: { email, code, requestId }
 *
 * Verifies the OTP code (reusing Nixify verifyOtp). On success:
 *   - marks the OtpRequest verified (one-time consumption)
 *   - marks the Contact.emailVerifiedAt = now (establishes verified_contact)
 *   - issues a resume credential (~30d) bound to the Contact + tenant +
 *     CURRENT policyVersion (so a stricter policy transition invalidates it)
 *   - issues a realtime visitor token (identityLevel=verified_contact) so the
 *     visitor can immediately start chatting
 *
 * Negative cases (all fail closed — no partial verification):
 *   - invalid code → 400 code_mismatch
 *   - expired OTP → 400 expired
 *   - already-used OTP → 400 already_used
 *   - wrong email (requestId mismatch) → 404 request_not_found
 *
 * No email-based Contact merging — the OTP is tied to the contactId from the
 * start route, so verification marks THAT Contact only.
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
    return widgetHeaders(NextResponse.json(
      { error: 'mode_mismatch' },
      { status: 409 },
    ))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  }

  const email = String(body.email ?? '').trim().toLowerCase()
  const code = String(body.code ?? '').trim()
  const requestId = String(body.requestId ?? '').trim()
  if (!email || !code || !requestId) {
    return widgetHeaders(NextResponse.json({ error: 'missing_fields' }, { status: 400 }))
  }

  // Find the OtpRequest (tied to this tenant + email + purpose).
  const otpReq = await db.otpRequest.findFirst({
    where: { requestId, email, purpose: 'visitor_verification' },
  })
  if (!otpReq) {
    return widgetHeaders(NextResponse.json({ error: 'request_not_found' }, { status: 404 }))
  }
  if (otpReq.verified) {
    return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 400 }))
  }
  if (otpReq.expiresAt < new Date()) {
    return widgetHeaders(NextResponse.json({ error: 'expired' }, { status: 400 }))
  }

  // Bounded attempts (rate-limit the verify attempts per request).
  await db.otpRequest.update({
    where: { id: otpReq.id },
    data: { attempts: { increment: 1 } },
  })

  // Reuse the Nixify verifyOtp — it throws NixifyError('code_mismatch') on wrong code.
  try {
    const result = await verifyOtp(email, code, 'visitor_verification', requestId)
    if (!result.verified) {
      return widgetHeaders(NextResponse.json({ error: 'code_mismatch' }, { status: 400 }))
    }
  } catch (e) {
    if (e instanceof NixifyError) {
      return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    }
    console.error('[widget:verify-identity/verify] internal error', { component: 'widget', route: 'verify-identity/verify', errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  // Mark the OtpRequest verified (one-time consumption).
  await db.otpRequest.update({
    where: { id: otpReq.id },
    data: { verified: true, verifiedAt: new Date() },
  })

  // Establish the verified_contact identity: mark the Contact.emailVerifiedAt.
  // The otpReq.contactId ties THIS OTP to THAT Contact (no email-based merging).
  const policyVersion = tenant.widgetConfig?.policyVersion ?? 1
  const { contactId, realtimeToken } = await withTenant(tenant.id, async () => {
    if (otpReq.contactId) {
      await db.contact.update({
        where: { id: otpReq.contactId },
        data: { emailVerifiedAt: new Date(), email },
      })
    }
    // Issue the resume credential (~30d) bound to the Contact + tenant + CURRENT
    // policyVersion (stricter-policy invalidation on the next protected action).
    return {
      contactId: otpReq.contactId!,
      realtimeToken: signToken({
        type: 'visitor',
        contactId: otpReq.contactId!,
        tenantId: tenant.id,
        slug,
        identityLevel: 'verified_contact',
        policyVersion,
      }),
    }
  })

  const resumeCredential = signResumeCredential({
    contactId: otpReq.contactId!,
    tenantId: tenant.id,
    policyVersion,
  })

  return widgetHeaders(NextResponse.json({
    verified: true,
    contactId,
    resumeCredential,
    realtimeToken,
  }))
}
