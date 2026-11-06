import { NextResponse, NextRequest } from 'next/server'
import { db, getCurrentTenantId } from '@/lib/db'
import { withSessionTenant, hasRole } from '@/lib/auth'

/**
 * GET /api/conversations/[id]/handoff-summary
 *
 * Returns the stored AI-Q6 handoff summary for the conversation.
 *
 * Authorization:
 * - Valid authenticated workspace session.
 * - Agent role or higher.
 * - Tenant and conversation ownership enforced server-side.
 * - Foreign-tenant conversation IDs return 404 without revealing existence.
 * - Unauthenticated access denied with 401/403.
 *
 * Does NOT allow clients to create or overwrite a summary.
 * Does NOT expose summaries through the public widget or visitor APIs.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await withSessionTenant(async ({ session }) => {
    if (!session?.user?.id || !session.user.workspaceId) {
      return { unauthorized: true as const }
    }
    // Agent role or higher required.
    if (session.user.role !== 'owner' && session.user.role !== 'admin' && session.user.role !== 'agent') {
      return { forbidden: true as const }
    }

    const tenantId = getCurrentTenantId()
    if (!tenantId) {
      return { unauthorized: true as const }
    }

    // Verify the conversation belongs to this tenant (fail-closed).
    // A foreign-tenant conversation ID must return 404 without revealing
    // its existence or content.
    const conversation = await db.conversation.findFirst({
      where: { id, tenantId },
      select: { id: true },
    })
    if (!conversation) {
      return { notFound: true as const }
    }

    // Fetch the summary — db proxy auto-injects tenantId (fail-closed).
    const summary = await db.conversationHandoffSummary.findUnique({
      where: { tenantId_conversationId: { tenantId, conversationId: id } },
      select: {
        summaryText: true,
        sourceMessageIds: true,
        createdAt: true,
      },
    })

    if (!summary) {
      return { summary: null } as const
    }

    return {
      summary: {
        text: summary.summaryText,
        sourceMessageIds: summary.sourceMessageIds as string[],
        createdAt: summary.createdAt.toISOString(),
      },
    } as const
  })

  if (!result) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (result.result.unauthorized) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (result.result.forbidden) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('notFound' in result.result) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json({ summary: result.result.summary })
}

/**
 * POST is not supported — clients cannot create or overwrite summaries.
 * Summary creation is triggered automatically by human takeover events.
 */
export async function POST() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 })
}
