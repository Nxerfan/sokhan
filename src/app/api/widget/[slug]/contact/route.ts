import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signToken, verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'

/**
 * Visitor identification endpoint — called by the widget on first load or when
 * the visitor provides an email. Dedupes by (tenantId, identifier).
 *
 * Returns a realtime visitor token for Socket.IO auth + the contactId +
 * existing open conversation if any.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json()
  const visitorId = String(body.visitorId ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const name = String(body.name ?? '').trim()

  if (!visitorId && !email) {
    return NextResponse.json({ error: 'visitorId_or_email_required' }, { status: 400 })
  }

  const identifier = email || visitorId
  const identifierType = email ? 'email' : 'visitorId'

  // Find or create contact — tenantId passed explicitly (Module 2 convention)
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

  return NextResponse.json({
    contactId: contact.id,
    conversationId: existingConversation?.id ?? null,
    realtimeToken,
    locale: tenant.defaultLocale,
    direction: tenant.defaultDirection,
  })
}
