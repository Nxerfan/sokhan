import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { verifyOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { parseAccessMode } from '@/lib/widget-access-policy'
import { signResumeCredential } from '@/lib/widget-identity-tokens'
import { signToken } from '@/lib/realtime-token'

function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

/** BLOCKER 6: bounded max verification attempts. */
const MAX_VERIFY_ATTEMPTS = 5

/**
 * Verified Visitor OTP — VERIFY (verified_visitor access mode).
 *
 *   POST /api/widget/<slug>/verify-identity/verify
 *   body: { visitorId (REQUIRED), email (REQUIRED), code (REQUIRED), requestId (REQUIRED) }
 *
 * BLOCKER 5: the lookup is scoped by tenant + Contact + providerRequestId +
 * normalized email + widget-verify purpose. The Contact is revalidated as
 * belonging to the same tenant + same visitor identity (visitorId) that
 * initiated verification. No global requestId-only authority.
 *
 * BLOCKER 6: a bounded max attempt limit (5) is enforced — attempts >= MAX
 * → fail closed with 'attempt_limit_reached' (no Nixify call after the limit).
 *
 * BLOCKER 8: after successful provider verification, the local WidgetOtpRequest
 * is atomically claimed via a conditional write (updateMany WHERE verified=false
 * AND expiresAt>now). Exactly one request may transition to verified; a
 * concurrent loser gets 'already_used' + no second resume credential.
 *
 * BLOCKER 9: never falls back to policyVersion ?? 1 — if WidgetConfig is
 * missing or policyVersion invalid, FAIL CLOSED (no credential minted).
 *
 * BLOCKER 4: the local purpose is 'widget_verify' (a login/signup/reset OTP
 * can never satisfy this — different model + purpose).
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

  const accessMode = parseAccessMode(tenant.widgetConfig?.accessMode)
  if (accessMode !== 'verified_visitor') {
    return widgetHeaders(NextResponse.json({ error: 'mode_mismatch' }, { status: 409 }))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  }

  const visitorId = typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 100) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  if (!visitorId || !email || !code || !requestId) {
    return widgetHeaders(NextResponse.json({ error: 'missing_fields' }, { status: 400 }))
  }

  // BLOCKER 5: tenant-scoped lookup by providerRequestId + email + purpose.
  // The db proxy (withTenant) injects tenantId; the WidgetOtpRequest must
  // belong to THIS tenant. The contactId (for the Contact revalidation) is
  // resolved from the record itself — NOT from the browser.
  const lookup = await withTenant(tenant.id, async () => {
    const otpReq = await db.widgetOtpRequest.findFirst({
      where: { providerRequestId: requestId, email, purpose: 'widget_verify' },
    })
    if (!otpReq) return { notFound: true as const }
    return { otpReq }
  })
  if (!lookup || ('notFound' in lookup)) {
    // Do not reveal whether the requestId vs email is wrong (enumeration resistance).
    return widgetHeaders(NextResponse.json({ error: 'request_not_found' }, { status: 404 }))
  }
  const otpReq = lookup.otpReq

  if (otpReq.verified) {
    return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 400 }))
  }
  if (otpReq.expiresAt < new Date()) {
    return widgetHeaders(NextResponse.json({ error: 'expired' }, { status: 400 }))
  }
  // BLOCKER 6: enforce the max attempt limit BEFORE calling Nixify.
  if (otpReq.attempts >= MAX_VERIFY_ATTEMPTS) {
    return widgetHeaders(NextResponse.json({ error: 'attempt_limit_reached' }, { status: 429 }))
  }

  // Increment attempts (bookkeeping; the limit check above is authoritative).
  await withTenant(tenant.id, async () => {
    await db.widgetOtpRequest.update({
      where: { id: otpReq.id },
      data: { attempts: { increment: 1 } },
    })
  })

  // Verify the code via Nixify (reuses the existing infrastructure).
  try {
    const result = await verifyOtp(email, code, 'widget_verify', requestId)
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

  // BLOCKER 8: atomically claim/consume the local record. Exactly one request
  // may transition verified=false → true; a concurrent loser gets count=0.
  const now = new Date()
  const claim = await withTenant(tenant.id, async () => {
    const claimed = await db.widgetOtpRequest.updateMany({
      where: { id: otpReq.id, verified: false, expiresAt: { gt: now } },
      data: { verified: true, verifiedAt: now },
    })
    return claimed.count
  })
  if (claim === 0) {
    // A concurrent verifier already claimed it (or it expired between the check + the claim).
    return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 400 }))
  }

  // BLOCKER 5: revalidate the Contact belongs to the same tenant + same visitor
  // identity (visitorId) that initiated verification. The visitorId from the
  // request body must match the Contact's identifier.
  const result = await withTenant(tenant.id, async () => {
    const contact = await db.contact.findUnique({ where: { id: otpReq.contactId } })
    if (!contact || contact.identifier !== visitorId) {
      return { invalid: true as const }
    }
    // Establish the verified_contact identity: mark emailVerifiedAt.
    await db.contact.update({
      where: { id: contact.id },
      data: { emailVerifiedAt: now, email },
    })
    return { contactId: contact.id }
  })
  if (!result || ('invalid' in result)) {
    // The Contact does not match the visitor identity — fail closed (no credential).
    return widgetHeaders(NextResponse.json({ error: 'identity_mismatch' }, { status: 403 }))
  }

  // BLOCKER 9: never fall back to policyVersion ?? 1. If WidgetConfig is
  // missing or policyVersion is invalid/missing, FAIL CLOSED (no credential).
  if (!tenant.widgetConfig || typeof tenant.widgetConfig.policyVersion !== 'number') {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const policyVersion = tenant.widgetConfig.policyVersion

  const contactId = result.contactId
  const resumeCredential = signResumeCredential({ contactId, tenantId: tenant.id, policyVersion })
  const realtimeToken = signToken({
    type: 'visitor', contactId, tenantId: tenant.id, slug,
    identityLevel: 'verified_contact', policyVersion,
  })

  return widgetHeaders(NextResponse.json({
    verified: true, contactId, resumeCredential, realtimeToken,
  }))
}
