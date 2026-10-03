import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'

/** CORS + rate-limit headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

/** Validate email format. */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // Rate limit — per IP + per tenant
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

  const body = await req.json()
  const visitorId = String(body.visitorId ?? '').trim().slice(0, 100)
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200)
  const name = String(body.name ?? '').trim().slice(0, 100)

  if (!visitorId && !email) {
    return widgetHeaders(NextResponse.json({ error: 'visitorId_or_email_required' }, { status: 400 }))
  }

  // Validate email format if provided
  if (email && !isValidEmail(email)) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))
  }

  const identifier = email || visitorId
  const identifierType = email ? 'email' : 'visitorId'

  let contact = await db.contact.findUnique({
    where: { tenantId_identifier: { tenantId: tenant.id, identifier } },
  })

  if (!contact) {
    contact = await db.contact.create({
      data: {
        tenantId: tenant.id,
        identifier,
        identifierType,
        name: name || (email ? email.split('@')[0] : 'Visitor'),
        email: email || null,
        locale: tenant.defaultLocale,
        metadata: {},
      },
    })
  } else if (email && contact.identifierType === 'visitorId') {
    contact = await db.contact.update({
      where: { id: contact.id },
      data: { email, identifierType: 'email', identifier: email, name: name || contact.name },
    })
  }

  const existingConversation = await db.conversation.findFirst({
    where: { tenantId: tenant.id, contactId: contact.id, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })

  const tokenPayload: VisitorTokenPayload = {
    type: 'visitor',
    contactId: contact.id,
    tenantId: tenant.id,
    slug,
  }
  const realtimeToken = signToken(tokenPayload)

  return widgetHeaders(NextResponse.json({
    contactId: contact.id,
    conversationId: existingConversation?.id ?? null,
    realtimeToken,
    locale: tenant.defaultLocale,
    direction: tenant.defaultDirection,
  }))
}
