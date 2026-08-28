import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

/**
 * POST: visitor submits a CSAT rating for a conversation.
 * Body: { conversationId, rating (1-5), comment? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return widgetHeaders(NextResponse.json({ error: 'no_token' }, { status: 401 }))

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_token' }, { status: 401 }))
  }

  const { contactId, tenantId } = payload as VisitorTokenPayload
  const body = await req.json()
  const conversationId = String(body.conversationId ?? '').slice(0, 100)
  const rating = Number(body.rating)
  const comment = body.comment ? String(body.comment).trim().slice(0, 500) : null

  if (!conversationId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_input' }, { status: 400 }))
  }

  // Verify the conversation belongs to this contact + tenant — tenantId explicit
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId, contactId },
  })
  if (!conversation) {
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  if (conversation.status !== 'closed') {
    return widgetHeaders(NextResponse.json({ error: 'conversation_not_closed' }, { status: 400 }))
  }

  if (conversation.csatRating !== null) {
    return widgetHeaders(NextResponse.json({ error: 'already_rated' }, { status: 400 }))
  }

  await db.conversation.updateMany({
    where: { id: conversationId, tenantId },
    data: { csatRating: rating, csatComment: comment, csatAt: new Date() },
  })

  return widgetHeaders(NextResponse.json({ ok: true }))
}
