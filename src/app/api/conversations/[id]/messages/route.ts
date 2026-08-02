import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'

/**
 * GET: messages for a conversation (history)
 * POST: agent sends a reply
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async () => {
    const messages = await db.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    return messages
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ messages: result.result })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'agent')) {
      return { forbidden: true as const }
    }

    const body = await req.json()
    const text = String(body.text ?? '').trim()
    const attachments = body.attachments
    if (!text && !attachments) {
      return { error: 'empty_message' as const }
    }

    // Verify conversation exists in this tenant
    const conversation = await db.conversation.findFirst({ where: { id } })
    if (!conversation) {
      return { error: 'not_found' as const }
    }

    // Persist the agent message — tenantId explicit
    const message = await db.message.create({
      data: {
        conversationId: id,
        tenantId: session.user.workspaceId!,
        senderType: 'agent',
        senderUserId: session.user.id,
        contentType: attachments ? 'file' : 'text',
        content: { text: text || undefined, attachments: attachments || undefined },
        status: 'sent',
      },
    })

    // Update conversation metadata + reset unread — tenantId explicit (Module 2 convention)
    await db.conversation.updateMany({
      where: { id, tenantId: session.user.workspaceId! },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 120) || (attachments ? '[attachment]' : ''),
        unreadCount: 0,
        status: conversation.status === 'closed' ? 'open' : conversation.status,
      },
    })

    // Publish to realtime — fan out to the conversation room (includes the widget visitor)
    await publishToRealtime({
      room: room.conversation(id),
      event: EVENTS.MESSAGE_NEW,
      payload: { ...message, isNewConversation: false },
    })

    return { message } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ message: result.result.message })
}
