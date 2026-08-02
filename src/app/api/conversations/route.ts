import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'

/**
 * Agent conversation list. Supports filtering by status, department, assignee.
 */
export async function GET(req: NextRequest) {
  const result = await withSessionTenant(async () => {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') || 'open'
    const departmentId = url.searchParams.get('departmentId')
    const assignedUserId = url.searchParams.get('assignedUserId')

    const where: any = {}
    if (status !== 'all') where.status = status
    if (departmentId) where.departmentId = departmentId
    if (assignedUserId) where.assignedUserId = assignedUserId

    return db.conversation.findMany({
      where,
      include: {
        contact: { select: { id: true, name: true, email: true, avatarUrl: true } },
        assignedUser: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ conversations: result.result })
}

/**
 * Create a conversation manually (agent-initiated). For MVP, conversations are
 * typically created by the widget; this endpoint exists for completeness.
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'agent')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const conversation = await db.conversation.create({
      data: {
        tenantId: session.user.workspaceId!,
        contactId: body.contactId,
        status: 'open',
        channel: body.channel || 'widget',
        tags: [],
      },
    })
    return { conversation } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ conversation: result.result.conversation })
}
