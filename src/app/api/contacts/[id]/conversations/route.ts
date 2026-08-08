import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/**
 * GET: list conversations for a specific contact (within the current tenant).
 * Tenant-scoped: the contact must belong to the authenticated tenant.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async () => {
    // Verify the contact belongs to this tenant — tenantId explicit (defense-in-depth)
    const contact = await db.contact.findFirst({
      where: { id, tenantId: getCurrentTenantId()! },
      select: { id: true },
    })
    if (!contact) return { notFound: true as const }

    const conversations = await db.conversation.findMany({
      where: { contactId: id, tenantId: getCurrentTenantId()! },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        lastMessagePreview: true,
        lastMessageAt: true,
        createdAt: true,
      },
    })
    return { conversations } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('notFound' in result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ conversations: result.result.conversations })
}
