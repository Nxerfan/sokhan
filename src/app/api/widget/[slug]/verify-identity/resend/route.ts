import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { resendOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'

const MAX_RESENDS = 3

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
 * Verified Visitor OTP — RESEND (verified_visitor access mode).
 *
 *   POST /api/widget/<slug>/verify-identity/resend
 *   body: { visitorId (REQUIRED), email?, requestId? }
 *
 * Resends the OTP for an EXISTING active WidgetOtpRequest. The resend is BOUND
 * to the persisted pending email on the WidgetOtpRequest — a frontend `email`
 * is NEVER trusted to change identity (it is used only for optional
 * correlation: if provided, it must match the persisted pending email).
 *
 * Contract:
 *   - only verified_visitor mode + strict current policyVersion
 *   - resolve the current anonymous visitor Contact (findUnique — NO create;
 *     a resend implies an existing flow; a missing Contact -> request_not_found)
 *   - Contact must be identifierType=visitorId + externalUserId=null (else
 *     identity_conflict)
 *   - target the current active WidgetOtpRequest (status=active, verified=false,
 *     purpose=widget_verify)
 *   - fail closed for: superseded, already verified, expired, resend limit,
 *     wrong visitorId, wrong email/correlation, identity conflict, stale
 *     policy, wrong tenant, provider failure
 *   - call Nixify resendOtp with the PERSISTED pending email
 *   - rotate providerRequestId (old immediately stops being usable locally)
 *   - update expiresAt, increment resendCount, reset attempts=0
 *   - remain status=active, verified=false; preserve pendingName + email
 *   - Contact profile MUST NOT be mutated
 *   - concurrent resends leave exactly one authoritative providerRequestId
 *     (the transactional conditional UPDATE serializes on the row lock)
 *   - no raw Prisma/Nixify/internal errors leak to the client
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
    return widgetHeaders(NextResponse.json({ error: 'mode_mismatch', message: 'OTP resend is for verified_visitor mode' }, { status: 409 }))
  }
  const policyVersion = parsePolicyVersion(tenant.widgetConfig?.policyVersion)
  if (policyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 100) : ''
  if (!visitorId) return widgetHeaders(NextResponse.json({ error: 'visitorId_required' }, { status: 400 }))
  // Optional correlation fields. The email is NEVER trusted to change identity —
  // if provided, it must match the persisted pending email (wrong_correlation
  // otherwise). The requestId, if provided, must match the current active
  // providerRequestId (a stale requestId -> wrong_correlation).
  const frontendEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  const frontendRequestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  if (frontendEmail && !isValidEmail(frontendEmail)) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))
  }

  // === Resolve the Contact by (tenant, visitorId) — findUnique, NO create. ===
  // A resend implies an existing flow; a missing Contact -> request_not_found.
  // Enforce the anonymous identity class (identifierType=visitorId, externalUserId=null).
  const contactResult = await withTenant(tenant.id, async () => {
    const c = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
      select: { id: true, identifierType: true, externalUserId: true },
    })
    if (!c) return { ok: false as const, reason: 'request_not_found' as const }
    if (c.identifierType !== 'visitorId' || c.externalUserId !== null) {
      return { ok: false as const, reason: 'identity_conflict' as const }
    }
    return { ok: true as const, contactId: c.id }
  })
  if (!contactResult.ok) {
    const status = contactResult.reason === 'identity_conflict' ? 403 : 404
    return widgetHeaders(NextResponse.json({ error: contactResult.reason }, { status }))
  }
  const contactId = contactResult.contactId

  // === Find the latest WidgetOtpRequest for this contact (no status filter — ===
  // classify: active / superseded / verified / not_found). The partial unique
  // index guarantees at most one active per (tenant, contact).
  const lookup = await withTenant(tenant.id, async () => {
    const otpReq = await db.widgetOtpRequest.findFirst({
      where: { contactId, purpose: 'widget_verify' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, providerRequestId: true, email: true, pendingName: true, resendCount: true, expiresAt: true, status: true, verified: true },
    })
    if (!otpReq) return { kind: 'not_found' as const }
    if (otpReq.status === 'superseded') return { kind: 'request_superseded' as const }
    if (otpReq.verified || otpReq.status === 'verified') return { kind: 'already_used' as const }
    if (otpReq.status !== 'active') return { kind: 'not_found' as const }
    return { kind: 'ok' as const, otpReq }
  })
  if (lookup.kind !== 'ok') {
    const kindMap = {
      not_found: 'request_not_found',
      request_superseded: 'request_superseded',
      already_used: 'already_used',
    } as const
    const status = lookup.kind === 'not_found' ? 404 : 409
    return widgetHeaders(NextResponse.json({ error: kindMap[lookup.kind] }, { status }))
  }
  const otpReq = lookup.otpReq

  // === Fail closed: expired/ineligible request. ===
  // An already-expired request CANNOT be resent (the visitor must start a fresh
  // flow). The resend would otherwise un-expire a stale request.
  if (otpReq.expiresAt < new Date()) {
    return widgetHeaders(NextResponse.json({ error: 'expired' }, { status: 400 }))
  }

  // === Fail closed: resend limit. ===
  if (otpReq.resendCount >= MAX_RESENDS) {
    return widgetHeaders(NextResponse.json({ error: 'resend_limit' }, { status: 429 }))
  }

  // === Optional correlation: frontend email + requestId must match the ===
  // persisted pending email + current active providerRequestId. A mismatch ->
  // wrong_correlation (the client has stale/wrong correlation data).
  if (frontendEmail && frontendEmail !== otpReq.email) {
    return widgetHeaders(NextResponse.json({ error: 'wrong_correlation' }, { status: 409 }))
  }
  if (frontendRequestId && frontendRequestId !== otpReq.providerRequestId) {
    return widgetHeaders(NextResponse.json({ error: 'wrong_correlation' }, { status: 409 }))
  }

  // === Call Nixify resendOtp with the PERSISTED pending email. ===
  // Nixify is called BEFORE the DB UPDATE — a provider failure leaves NO local
  // state corruption (no DB change happened). The persisted pendingName + email
  // are preserved (the UPDATE below does NOT touch them).
  let result
  try {
    result = await resendOtp(otpReq.email, 'widget_verify')
  } catch (e) {
    if (e instanceof NixifyError) {
      return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    }
    console.error('[widget:verify-identity/resend] Nixify error', { component: 'widget', route: 'verify-identity/resend', errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  // === Transactional conditional rotation. ===
  // Conditional on status=active + verified=false: handles concurrent resend
  // (serializes on the row lock — exactly one authoritative providerRequestId
  // remains) + concurrent verify/supersede (claim loses -> re-read + classify).
  // The conditional UPDATE includes `resendCount < MAX` so concurrent resends
  // are ATOMICALLY bounded: the pre-check (above) is non-atomic, but this
  // updateMany only succeeds for resends where the row is still under the
  // limit. Concurrent resends serialize on the row lock; the first MAX succeed
  // (each rotating the providerRequestId), the rest get count=0 -> re-read ->
  // resend_limit. Exactly one authoritative providerRequestId remains.
  const rotated = await withTenant(tenant.id, async () => {
    const r = await db.widgetOtpRequest.updateMany({
      where: { id: otpReq.id, status: 'active', verified: false, purpose: 'widget_verify', resendCount: { lt: MAX_RESENDS } },
      data: {
        providerRequestId: result.otpRequestId, // rotate — old immediately unusable locally
        expiresAt: new Date(result.expiresAt),
        resendCount: { increment: 1 },
        attempts: 0, // reset
        status: 'active', // remain
        verified: false, // remain
        verifiedAt: null,
      },
    })
    return r.count
  })

  if (rotated === 0) {
    // The conditional claim lost — another concurrent resend/verify/supersede
    // changed the row between the lookup + the UPDATE. Re-read + classify to
    // return a truthful result (no raw error leak).
    const state = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({
        where: { id: otpReq.id },
        select: { status: true, verified: true, providerRequestId: true, expiresAt: true, resendCount: true },
      })
    })
    if (!state) return widgetHeaders(NextResponse.json({ error: 'request_not_found' }, { status: 404 }))
    if (state.status === 'superseded') return widgetHeaders(NextResponse.json({ error: 'request_superseded' }, { status: 409 }))
    if (state.verified || state.status === 'verified') return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 409 }))
    if (state.expiresAt < new Date()) return widgetHeaders(NextResponse.json({ error: 'expired' }, { status: 400 }))
    if (state.resendCount >= MAX_RESENDS) return widgetHeaders(NextResponse.json({ error: 'resend_limit' }, { status: 429 }))
    // Still active but the claim lost (a concurrent resend rotated the
    // providerRequestId). Return the CURRENT authoritative providerRequestId so
    // the client uses the latest. (Our Nixify resend was a no-op locally — the
    // winner's providerRequestId is authoritative.)
    return widgetHeaders(NextResponse.json({ requestId: state.providerRequestId, expiresAt: state.expiresAt.toISOString() }))
  }

  return widgetHeaders(NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt }))
}
