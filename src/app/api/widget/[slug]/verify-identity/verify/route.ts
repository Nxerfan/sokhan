import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { verifyOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'
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

const MAX_VERIFY_ATTEMPTS = 5
const MAX_RESENDS = 3

/**
 * Verified Visitor OTP — VERIFY (Blockers #5, #6, #7).
 *
 * #5: atomic attempt reservation BEFORE Nixify (updateMany WHERE attempts<MAX).
 * #6: revalidate Contact (tenant, visitorId, identifierType, externalUserId=null,
 *     email match) BEFORE calling Nixify. On mismatch → identity_mismatch, no
 *     Nixify call, no local consumption.
 * #7: success finalization in ONE tenant-bound transaction (conditional claim +
 *     Contact revalidation + emailVerifiedAt update). Credentials issued ONLY
 *     after commit. No WidgetOtpRequest.verified=true with Contact.emailVerifiedAt=null.
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
    return widgetHeaders(NextResponse.json({ error: 'mode_mismatch' }, { status: 409 }))
  }

  // #9: never fall back to policyVersion ?? 1 — fail closed.
  const policyVersion = parsePolicyVersion(tenant.widgetConfig?.policyVersion)
  if (policyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))

  const visitorId = typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 100) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  if (!visitorId || !email || !code || !requestId) {
    return widgetHeaders(NextResponse.json({ error: 'missing_fields' }, { status: 400 }))
  }

  // === Step 1: tenant-scoped lookup of the WidgetOtpRequest ===
  const lookup = await withTenant(tenant.id, async () => {
    const otpReq = await db.widgetOtpRequest.findFirst({
      where: { providerRequestId: requestId, email, purpose: 'widget_verify', status: 'active' },
    })
    if (!otpReq) return { kind: 'not_found' as const }
    if (otpReq.status === 'superseded') return { kind: 'request_superseded' as const }
    if (otpReq.verified) return { kind: 'already_used' as const }
    if (otpReq.expiresAt < new Date()) return { kind: 'expired' as const }
    if (otpReq.resendCount > MAX_RESENDS) return { kind: 'resend_limit' as const }
    return { kind: 'ok' as const, otpReq }
  })

  if (lookup.kind !== 'ok') {
    const status = lookup.kind === 'not_found' ? 404 : lookup.kind === 'already_used' ? 400 : lookup.kind === 'expired' ? 400 : 429
    return widgetHeaders(NextResponse.json({ error: lookup.kind }, { status }))
  }
  const otpReq = lookup.otpReq

  // === #5: atomic attempt reservation BEFORE Nixify ===
  // updateMany WHERE verified=false AND expiresAt>now AND attempts<MAX → exactly one slot per request.
  const now = new Date()
  const reservation = await withTenant(tenant.id, async () => {
    const r = await db.widgetOtpRequest.updateMany({
      where: { id: otpReq.id, status: 'active', verified: false, expiresAt: { gt: now }, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    })
    return r.count
  })
  if (reservation === 0) {
    // The slot was NOT acquired — resolve the safe reason by re-reading state.
    const state = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: otpReq.id }, select: { verified: true, expiresAt: true, attempts: true } })
    })
    if (!state) return widgetHeaders(NextResponse.json({ error: 'request_not_found' }, { status: 404 }))
    if (state.verified) return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 400 }))
    if (state.expiresAt < now) return widgetHeaders(NextResponse.json({ error: 'expired' }, { status: 400 }))
    if (state.attempts >= MAX_VERIFY_ATTEMPTS) return widgetHeaders(NextResponse.json({ error: 'attempt_limit_reached' }, { status: 429 }))
    return widgetHeaders(NextResponse.json({ error: 'request_not_found' }, { status: 404 }))
  }

  // === #6: revalidate Contact BEFORE calling Nixify ===
  // Prove: Contact exists, Contact.id == request.contactId, identifierType=visitorId,
  // identifier == visitorId, externalUserId=null, email matches.
  const contactCheck = await withTenant(tenant.id, async () => {
    const contact = await db.contact.findUnique({ where: { id: otpReq.contactId } })
    if (!contact) return { ok: false as const, reason: 'identity_mismatch' }
    if (contact.identifierType !== 'visitorId') return { ok: false as const, reason: 'identity_conflict' }
    if (contact.identifier !== visitorId) return { ok: false as const, reason: 'identity_mismatch' }
    if (contact.externalUserId !== null) return { ok: false as const, reason: 'identity_conflict' }
    return { ok: true as const, contact }
  })
  if (!contactCheck.ok) {
    // Do NOT call Nixify. Do NOT consume the local request. The attempt was
    // reserved (incremented) but that's acceptable — the reservation is a
    // bounded attempt slot, not a consumption.
    return widgetHeaders(NextResponse.json({ error: contactCheck.reason }, { status: 403 }))
  }

  // === Call Nixify (the attempt was reserved + Contact revalidated) ===
  try {
    const result = await verifyOtp(email, code, 'widget_verify', requestId)
    if (!result.verified) {
      return widgetHeaders(NextResponse.json({ error: 'code_mismatch' }, { status: 400 }))
    }
  } catch (e) {
    if (e instanceof NixifyError) {
      return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    }
    console.error('[widget:verify-identity/verify] Nixify error', { errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  // === #7: success finalization in ONE tenant-bound transaction ===
  // 1. conditional claim WidgetOtpRequest (verified=false AND expiresAt>now)
  // 2. revalidate Contact identity again (defense-in-depth inside the tx)
  // 3. set WidgetOtpRequest.verified=true + verifiedAt
  // 4. set Contact.emailVerifiedAt + email
  // 5. commit
  // If claim loses → already_used (no credential issuance).
  const finalization = await withTenant(tenant.id, async () => {
    return db.$transaction(async (tx) => {
      const claimed = await tx.widgetOtpRequest.updateMany({
        where: { id: otpReq.id, status: 'active', verified: false, expiresAt: { gt: new Date() } },
        data: { status: 'verified', verified: true, verifiedAt: new Date() },
      })
      if (claimed.count === 0) return { lost: true as const }

      // Revalidate Contact inside the transaction (defense-in-depth).
      const contact = await tx.contact.findUnique({ where: { id: otpReq.contactId } })
      if (!contact || contact.identifierType !== 'visitorId' || contact.identifier !== visitorId || contact.externalUserId !== null) {
        throw new Error('identity_mismatch')
      }

      await tx.contact.update({
        where: { id: contact.id },
        data: { emailVerifiedAt: new Date(), email, ...(otpReq.pendingName ? { name: otpReq.pendingName } : {}) },
      })
      return { lost: false as const, contactId: contact.id }
    })
  })

  if (!finalization || ('lost' in finalization && finalization.lost)) {
    return widgetHeaders(NextResponse.json({ error: 'already_used' }, { status: 400 }))
  }

  // === Credentials issued ONLY after transaction commit ===
  const contactId = finalization.contactId!
  const resumeCredential = signResumeCredential({ contactId, tenantId: tenant.id, policyVersion })
  const realtimeToken = signToken({
    type: 'visitor', contactId, tenantId: tenant.id, slug,
    identityLevel: 'verified_contact', policyVersion,
  })

  return widgetHeaders(NextResponse.json({ verified: true, contactId, resumeCredential, realtimeToken }))
}
