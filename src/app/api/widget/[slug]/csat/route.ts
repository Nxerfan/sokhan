import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'

/**
 * POST: visitor submits a CSAT rating for a conversation.
 * Body: { conversationId, rating (1-5), comment? }
 *
 * The visitor is authenticated via their realtime token (same as for messaging).
 * The conversation must belong to the visitor's contact + tenant.
 */
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
  const conversationId = String(body.conversationId ?? '')
  const rating = Number(body.rating)
  const comment = body.comment ? String(body.comment).trim().slice(0, 500) : null

  if (!conversationId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  }

  // Verify the conversation belongs to this contact + tenant — tenantId explicit
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId, contactId },
  })
  if (!conversation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Only allow CSAT on closed conversations
  if (conversation.status !== 'closed') {
    return NextResponse.json({ error: 'conversation_not_closed' }, { status: 400 })
  }

  // Don't allow re-rating
  if (conversation.csatRating !== null) {
    return NextResponse.json({ error: 'already_rated' }, { status: 400 })
  }

  // Update the conversation with the CSAT rating — tenantId explicit
  await db.conversation.updateMany({
    where: { id: conversationId, tenantId },
    data: { csatRating: rating, csatComment: comment, csatAt: new Date() },
  })

  return NextResponse.json({ ok: true })
}
