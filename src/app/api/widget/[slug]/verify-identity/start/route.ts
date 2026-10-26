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
  // Concurrency-safe: Prisma upsert on the COMPOUND unique (tenantId,
  // identifier) does NOT emit INSERT ... ON CONFLICT, so concurrent first-time
  // STARTs for the same visitorId race on the create branch -> P2002. Bounded
  // retry: on P2002, another concurrent START won the create -- re-read the
  // Contact by (tenantId, visitorId) + revalidate the identity class. Never
  // leak raw P2002 to the client (would surface as an expected-contention 500).
  // If bounded resolution genuinely cannot succeed, return a stable safe
  // conflict (verification_conflict, 409). Nixify is NOT called until Contact
  // resolution succeeds.
  const contactResult = await withTenant(tenant.id, async () => {
    let c: { id: string; identifierType: string; externalUserId: string | null } | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        c = await db.contact.upsert({
          where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
          create: {
            tenantId: tenant.id, identifier: visitorId, identifierType: 'visitorId',
            name: 'Visitor', email: null, locale: tenant.defaultLocale, metadata: {},
          },
          update: {}, // NO Contact profile mutation at START
          select: { id: true, identifierType: true, externalUserId: true },
        })
        break
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 2) {
          // Another concurrent first-time START won the create -- re-read.
          const existing = await db.contact.findUnique({
            where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
            select: { id: true, identifierType: true, externalUserId: true },
          })
          if (existing) { c = existing; break }
          continue // row vanished between the P2002 and the re-read -- retry
        }
        if (e?.code === 'P2002') {
          // Exhausted bounded retries -- stable safe conflict (no raw P2002).
          return { ok: false as const, reason: 'verification_conflict' as const }
        }
        throw e
      }
    }
    // #2: enforce the anonymous identity class (identifierType='visitorId',
    // externalUserId=null). A visitorId colliding with an external-user
    // Contact's opaque identifier -> identity_conflict (403).
    if (!c || c.identifierType !== 'visitorId' || c.externalUserId !== null) {
      return { ok: false as const, reason: 'identity_conflict' as const }
    }
    return { ok: true as const, contactId: c.id }
  })
  if (!contactResult.ok) {
    const status = contactResult.reason === 'verification_conflict' ? 409 : 403
    return widgetHeaders(NextResponse.json({ error: contactResult.reason }, { status }))
  }
  const contactId = contactResult.contactId

  // Call Nixify sendOtp (reuse the existing infrastructure).
  try {
    const result = await sendOtp(email, 'widget_verify')
    // #1: store pending email + pendingName on WidgetOtpRequest (NOT on Contact).
    // #8: supersede previous unverified active requests for this Contact in the
    // same transaction that creates the new request (one active flow per Contact).
    // #3: bounded P2002 retry on the partial unique index (concurrent START contention).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // #4: re-check if this providerRequestId already exists (dedup).
        // BINDING: an existing providerRequestId counts as idempotent success
        // ONLY if it is bound to the SAME contactId + normalized email +
        // purpose='widget_verify' AND status='active'. Any binding mismatch
        // (different contact/email) OR a non-active status -> verification_conflict
        // (no rebind, no new row). Prevents a replayed/captured provider response
        // from being silently re-bound to a different Contact.
        const existing = await withTenant(tenant.id, async () => {
          return db.widgetOtpRequest.findUnique({
            where: { providerRequestId: result.otpRequestId },
            select: { id: true, status: true, contactId: true, email: true, purpose: true },
          })
        })
        if (existing) {
          const bindingMatch =
            existing.contactId === contactId &&
            existing.email === email &&
            existing.purpose === 'widget_verify'
          if (bindingMatch && existing.status === 'active') break // idempotent success
          // binding mismatch OR non-active (superseded/verified) -> conflict
          return widgetHeaders(NextResponse.json({ error: 'verification_conflict' }, { status: 409 }))
        }
        await withTenant(tenant.id, async () => {
          await db.$transaction(async (tx) => {
            await tx.widgetOtpRequest.updateMany({
              where: { contactId, status: 'active' },
              data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() },
            })
            await tx.widgetOtpRequest.create({
              data: {
                tenantId: tenant.id, contactId, email,
                pendingName: name ?? null,
                purpose: 'widget_verify',
                providerRequestId: result.otpRequestId,
                expiresAt: new Date(result.expiresAt),
                status: 'active', verified: false, verifiedAt: null,
                ipAddress: ip,
              },
            })
          })
        })
        break
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 2) continue
        if (e?.code === 'P2002') {
          return widgetHeaders(NextResponse.json({ error: 'verification_conflict' }, { status: 409 }))
        }
        throw e
      }
    }
    return widgetHeaders(NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt }))
  } catch (e) {
    if (e instanceof NixifyError) return widgetHeaders(NextResponse.json({ error: e.code }, { status: e.statusCode }))
    console.error('[widget:verify-identity/start] internal error', { component: 'widget', route: 'verify-identity/start', errorName: e instanceof Error ? e.name : 'unknown' })
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }
}
