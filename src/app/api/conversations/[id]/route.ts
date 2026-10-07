import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
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
      where: { id, tenantId: getCurrentTenantId()! },
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
    const convId = id  // route parameter is authoritative
    const data: any = {}
    const VALID_STATUSES = ['open', 'pending', 'closed', 'resolved']
    const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent']
    if (body.status && VALID_STATUSES.includes(body.status)) data.status = body.status
    if (body.priority && VALID_PRIORITIES.includes(body.priority)) data.priority = body.priority
    if (body.assignedUserId !== undefined) {
      if (body.assignedUserId === null || body.assignedUserId === '') {
        data.assignedUserId = null
      } else {
        // Validate the target user has an active Membership in this tenant
        const membership = await db.membership.findFirst({
          where: { userId: body.assignedUserId, status: 'active', tenantId: session.user.workspaceId! },
          select: { id: true },
        })
        if (!membership) return { error: 'invalid_assignee' as const }
        data.assignedUserId = body.assignedUserId
      }
    }
    if (body.departmentId !== undefined) {
      if (body.departmentId === null || body.departmentId === '') {
        data.departmentId = null
      } else {
        // Validate the department belongs to this tenant
        const dept = await db.department.findUnique({ where: { id: body.departmentId, tenantId: session.user.workspaceId! } })
        if (!dept) return { error: 'invalid_department' as const }
        data.departmentId = body.departmentId
      }
    }

    // updateMany with tenantId — defense-in-depth
    const updated = await db.conversation.updateMany({
      where: { id: convId, tenantId: session.user.workspaceId! },
      data,
    })
    if (updated.count === 0) return { error: 'not_found' as const }
    const conversation = await db.conversation.findFirst({ where: { id: convId, tenantId: getCurrentTenantId()! } })

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
  if ('error' in result.result) {
    const err = result.result.error
    if (err === 'invalid_assignee') return NextResponse.json({ error: 'invalid_assignee' }, { status: 400 })
    if (err === 'invalid_department') return NextResponse.json({ error: 'invalid_department' }, { status: 400 })
    if (err === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ error: err }, { status: 400 })
  }
  return NextResponse.json({ conversation: result.result.conversation })
}
