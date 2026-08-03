import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'
import { evaluateRoutingRules } from '@/lib/routing-engine'

/**
 * Visitor message endpoint — widget sends a message here (REST, persisted),
 * then the realtime service fans it out to agents via the internal publish.
 *
 * GET: message history for the visitor's conversation
 * POST: send a new message from the visitor
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'no_token' }, { status: 401 })

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }

  const { contactId, tenantId } = payload as VisitorTokenPayload
  const conversationId = new URL(req.url).searchParams.get('conversationId')

  if (!conversationId) {
    return NextResponse.json({ messages: [] })
  }

  // Verify the conversation belongs to this contact+tenant
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId, contactId },
  })
  if (!conversation) {
    return NextResponse.json({ messages: [] })
  }

  const messages = await db.message.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })

  return NextResponse.json({ messages, conversationId })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'no_token' }, { status: 401 })

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }

  const { contactId, tenantId } = payload as VisitorTokenPayload
  const body = await req.json()
  const text = String(body.text ?? '').trim()
  if (!text) {
    return NextResponse.json({ error: 'empty_message' }, { status: 400 })
  }

  // Find or create the conversation — tenantId explicit on every write
  let conversation = await db.conversation.findFirst({
    where: { tenantId, contactId, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })

  const isNew = !conversation
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        tenantId,
        contactId,
        status: 'open',
        channel: 'widget',
        tags: [],
      },
    })
    // Evaluate routing rules for the new conversation
    await evaluateRoutingRules(conversation.id, tenantId, text)
  }

  // Persist the message — tenantId explicit
  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      tenantId,
      senderType: 'contact',
      senderUserId: null,
      contentType: 'text',
      content: { text },
      status: 'sent',
    },
  })

  // Update conversation metadata — tenantId explicit in where (defense-in-depth)
  await db.conversation.updateMany({
    where: { id: conversation.id, tenantId },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
      unreadCount: { increment: 1 },
    },
  })

  // Publish to realtime — fan out to agents in the conversation room + tenant room
  await publishToRealtime({
    room: room.conversation(conversation.id),
    event: EVENTS.MESSAGE_NEW,
    payload: { ...message, isNewConversation: isNew },
  })

  if (isNew) {
    await publishToRealtime({
      room: room.tenant(tenantId),
      event: EVENTS.CONVERSATION_NEW,
      payload: { conversationId: conversation.id, contactId, preview: text.slice(0, 120) },
    })
  }

  return NextResponse.json({ message, conversationId: conversation.id })
}
