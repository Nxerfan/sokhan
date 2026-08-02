import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'

/**
 * GET: conversation detail (with messages + contact + assignment)
 * PATCH: update conversation status / assignment / department
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async () => {
    const conversation = await db.conversation.findFirst({
      where: { id },
      include: {
        contact: { select: { id: true, name: true, email: true, avatarUrl: true, locale: true } },
        assignedUser: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
        },
      },
    })
    return conversation
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Mark unread as read for this agent — create/update participant, reset unread
  return NextResponse.json({ conversation: result.result })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'agent')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const data: any = {}
    if (body.status) data.status = body.status
    if (body.assignedUserId !== undefined) data.assignedUserId = body.assignedUserId || null
    if (body.departmentId !== undefined) data.departmentId = body.departmentId || null
    if (body.priority) data.priority = body.priority

    // updateMany with tenantId — defense-in-depth (Module 2 convention)
    await db.conversation.updateMany({
      where: { id, tenantId: session.user.workspaceId! },
      data,
    })
    const conversation = await db.conversation.findFirst({ where: { id } })

    // If assigned to a user, add them as participant — tenantId explicit
    if (body.assignedUserId) {
      await db.participant.upsert({
        where: { conversationId_userId: { conversationId: id, userId: body.assignedUserId } },
        create: { conversationId: id, userId: body.assignedUserId, tenantId: session.user.workspaceId! },
        update: {},
      })
    }

    // Publish update to the conversation room + tenant room
    await publishToRealtime({
      room: room.conversation(id),
      event: EVENTS.CONVERSATION_UPDATED,
      payload: { conversationId: id, changes: data },
    })
    await publishToRealtime({
      room: room.tenant(session.user.workspaceId!),
      event: EVENTS.CONVERSATION_UPDATED,
      payload: { conversationId: id, changes: data },
    })

    return { conversation } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ conversation: result.result.conversation })
}
