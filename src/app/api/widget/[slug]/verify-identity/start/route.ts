import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { sendOtp, NixifyError } from '@/lib/nixify/client'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { parseAccessMode } from '@/lib/widget-access-policy'

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
 *   body: { visitorId (REQUIRED), email (REQUIRED), name? }
 *
 * BLOCKER 1: the browser does NOT supply a contactId. The server resolves
 * the Contact itself by the anonymous identity namespace (tenant + visitorId)
 * — NEVER by email, NEVER by a browser-provided Contact ID. A caller cannot
 * nominate an arbitrary Contact to verify.
 *
 * BLOCKER 3: the OTP state is stored in the tenant-scoped WidgetOtpRequest
 * (NOT the global auth OtpRequest), with the Contact + tenant relation.
 *
 * BLOCKER 4: the local purpose is 'widget_verify' (canonical; maps to Nixify
 * 'login' at the wire boundary). A login/signup/reset OTP can never satisfy
 * a widget verification record (different model + purpose).
 *
 * Reuses the existing Nixify sendOtp infrastructure (no parallel OTP subsystem).
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
    return widgetHeaders(NextResponse.json(
      { error: 'mode_mismatch', message: 'OTP verification is for verified_visitor mode' },
      { status: 409 },
    ))
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  }

  // visitorId + email are REQUIRED. name is optional profile metadata.
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 100) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
  if (!visitorId) {
    return widgetHeaders(NextResponse.json({ error: 'visitorId_required' }, { status: 400 }))
  }
  if (!email || !isValidEmail(email)) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))
  }

  // BLOCKER 1: the server resolves the Contact by (tenant, visitorId) — NOT by
  // a browser-supplied contactId, NOT by email. The visitorId is the anonymous
  // identity namespace; email is profile metadata only.
  const contact = await withTenant(tenant.id, async () => {
    let c = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
    })
    if (!c) {
      c = await db.contact.create({
        data: {
          tenantId: tenant.id,
          identifier: visitorId,
          identifierType: 'visitorId',
          name: name || 'Visitor',
          email,
          locale: tenant.defaultLocale,
          metadata: {},
        },
      })
    } else {
      // Update profile metadata (email/name) — NOT the identifier (visitorId is immutable identity).
      c = await db.contact.update({
        where: { id: c.id },
        data: { email, ...(name ? { name } : {}) },
      })
    }
    return c
  })

  // Reuse the Nixify OTP infrastructure. purpose 'widget_verify' (local) → 'login' (wire).
  try {
    const result = await sendOtp(email, 'widget_verify')
    // BLOCKER 3: store in the tenant-scoped WidgetOtpRequest (fail-closed db proxy).
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.create({
        data: {
          tenantId: tenant.id,
          contactId: contact.id,
          email,
          purpose: 'widget_verify',
          providerRequestId: result.otpRequestId,
          expiresAt: new Date(result.expiresAt),
          ipAddress: ip,
        },
      })
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
