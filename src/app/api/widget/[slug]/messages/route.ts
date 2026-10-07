import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'
import { evaluateRoutingRules } from '@/lib/routing-engine'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { withTenant } from '@/lib/db'
import { checkMessageLimit } from '@/lib/payments/free-plan'
import { getRequestDomain, isDomainAllowed } from '@/lib/payments/domain-validation'

const MAX_MESSAGE_LENGTH = 5000
const MAX_MESSAGES_PER_CONVERSATION = 200

/** CORS + rate-limit headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

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
  if (!token) return widgetHeaders(NextResponse.json({ error: 'no_token' }, { status: 401 }))

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_token' }, { status: 401 }))
  }

  const { contactId, tenantId, slug: tokenSlug } = payload as VisitorTokenPayload

  // Bind visitor token to the route slug — token A + slug B must be rejected.
  if (tokenSlug !== slug) {
    return widgetHeaders(NextResponse.json({ error: 'token_slug_mismatch' }, { status: 403 }))
  }
  // Verify the token's tenant corresponds to this slug.
  const tokenTenant = await db.tenant.findUnique({ where: { slug }, select: { id: true } })
  if (!tokenTenant || tokenTenant.id !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'token_tenant_mismatch' }, { status: 403 }))
  }

  const conversationId = new URL(req.url).searchParams.get('conversationId')

  if (!conversationId) {
    return widgetHeaders(NextResponse.json({ messages: [] }))
  }

  // Wrap tenant-scoped DB operations
  const { conversation, messages } = await withTenant(tenantId, async () => {
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, contactId },
    })
    if (!conversation) return { conversation: null, messages: [] as any[] }
    const messages = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    return { conversation, messages }
  })

  if (!conversation) {
    return widgetHeaders(NextResponse.json({ messages: [] }))
  }

  return widgetHeaders(NextResponse.json({ messages, conversationId }))
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // Rate limit — per IP + per tenant
  const ip = getClientIP(req)
  const rateLimit = await checkRateLimit(ip, slug)
  if (!rateLimit.allowed) {
    return widgetHeaders(NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 60) } },
    ))
  }

  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return widgetHeaders(NextResponse.json({ error: 'no_token' }, { status: 401 }))

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_token' }, { status: 401 }))
  }

  const { contactId, tenantId, slug: tokenSlug } = payload as VisitorTokenPayload

  // Bind visitor token to the route slug — token A + slug B must be rejected.
  if (tokenSlug !== slug) {
    return widgetHeaders(NextResponse.json({ error: 'token_slug_mismatch' }, { status: 403 }))
  }
  // Verify the token's tenant corresponds to this slug.
  const tokenTenant = await db.tenant.findUnique({ where: { slug }, select: { id: true } })
  if (!tokenTenant || tokenTenant.id !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'token_tenant_mismatch' }, { status: 403 }))
  }

  const body = await req.json()
  const text = String(body.text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH)
  if (!text) {
    return widgetHeaders(NextResponse.json({ error: 'empty_message' }, { status: 400 }))
  }

  // Wrap ALL tenant-scoped DB work in withTenant. The fail-closed Prisma
  // extension requires a current tenant context for any read/write against
  // tenant-scoped models (WidgetDomain, Message, Conversation, AiConfig,
  // FaqPair, Product, etc.). Without this, the queries throw
  // `TenantContextRequiredError` and the widget POST breaks.
  const result = await withTenant(tenantId, async () => {
    // Free plan checks: domain validation + message limit + trial expiry.
    // These internally query tenant-scoped models (WidgetDomain, Message)
    // so they MUST run inside the tenant context.
    const domain = getRequestDomain(req)
    const domainAllowed = await isDomainAllowed(tenantId, domain)
    if (!domainAllowed) {
      return { kind: 'domain_not_allowed' as const }
    }

    const messageCheck = await checkMessageLimit(tenantId)
    if (!messageCheck.allowed) {
      return { kind: 'message_limit' as const, reason: messageCheck.reason ?? 'message_limit' }
    }

    // Find or create the conversation. tenantId is auto-injected by the
    // fail-closed extension; passing it explicitly is defense-in-depth.
    let conversation = await db.conversation.findFirst({
      where: { contactId, status: 'open' },
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
      // Evaluate routing rules for the new conversation.
      // evaluateRoutingRules wraps itself in withTenant — nesting the same
      // tenantId is a no-op (the inner context simply shadows the outer
      // with the same value).
      await evaluateRoutingRules(conversation.id, tenantId, text)
    }

    // Persist the visitor message. tenantId auto-injected by extension.
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

    // Update conversation metadata. tenantId auto-injected in where.
    await db.conversation.updateMany({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 120),
        unreadCount: { increment: 1 },
      },
    })

    return { kind: 'ok' as const, message, conversation, isNew }
  })

  if (result.kind === 'domain_not_allowed') {
    return widgetHeaders(NextResponse.json({ error: 'domain_not_allowed' }, { status: 403 }))
  }
  if (result.kind === 'message_limit') {
    return widgetHeaders(NextResponse.json({ error: result.reason }, { status: 403 }))
  }
  if (result.kind !== 'ok') {
    // Unreachable — exhaustiveness guard
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  const { message, conversation, isNew } = result

  // Publish to realtime — fan out to agents in the conversation room + tenant room.
  // Not a DB call — outside the withTenant wrap is fine.
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

  // === AI features (Module 4) — fire AFTER the visitor message is persisted ===
  // Both features are opt-in (default OFF) and respect the AI usage cap.
  // If the cap is hit, they gracefully stop firing (fall through to human routing).
  // Runs in a fresh withTenant context — tryAiResponse queries tenant-scoped
  // models (AiConfig, FaqPair, Product, Message, Conversation).
  let aiResponse: { text: string; source: 'faq' | 'product' } | null = null
  try {
    aiResponse = await withTenant(tenantId, () => tryAiResponse(text, tenantId, conversation.id))
  } catch (e) {
    console.error('[widget:messages] AI error:', e instanceof Error ? e.message : e)
  }

  if (aiResponse) {
    // Persist the AI message inside the tenant context
    const aiMessage = await withTenant(tenantId, async () => {
      const m = await db.message.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          senderType: 'ai',
          senderUserId: null,
          contentType: 'text',
          content: { text: aiResponse!.text, source: aiResponse!.source },
          status: 'sent',
        },
      })
      await db.conversation.updateMany({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: `[AI] ${aiResponse!.text.slice(0, 116)}`,
        },
      })
      return m
    })

    // Publish the AI response to realtime (not a DB call — outside context)
    await publishToRealtime({
      room: room.conversation(conversation.id),
      event: EVENTS.MESSAGE_NEW,
      payload: { ...aiMessage, isNewConversation: false },
    })
  }

  return NextResponse.json({ message, conversationId: conversation.id, aiResponse })
}

/**
 * Try to generate an AI response for the visitor's message.
 * Checks: AI config (feature toggles), plan cap (aiActions).
 * Order: FAQ matching first, then product Q&A.
 * Returns null if no AI feature fires (falls through to human routing).
 */
async function tryAiResponse(
  visitorMessage: string,
  tenantId: string,
  conversationId: string,
): Promise<{ text: string; source: 'faq' | 'product' } | null> {
  const { db } = await import('@/lib/db')
  const { checkPlanLimit } = await import('@/lib/payments/gating')
  const { matchFaq, answerProductQuestion } = await import('@/lib/ai')

  // Load AI config
  let aiConfig = await db.aiConfig.findUnique({ where: { tenantId } })
  if (!aiConfig) {
    // Default config — both features OFF
    return null
  }

  // Check plan cap for AI actions
  const capCheck = await checkPlanLimit(tenantId, 'aiActions')
  if (!capCheck.allowed) {
    // Cap hit — graceful fallback to human routing
    return null
  }

  // Feature 1: FAQ matching (if enabled)
  if (aiConfig.faqEnabled) {
    const faqPairs = await db.faqPair.findMany({
      where: { tenantId, enabled: true },
      select: { id: true, question: true, answer: true },
    })

    if (faqPairs.length > 0) {
      const match = await matchFaq(visitorMessage, faqPairs)
      if (match.matched && match.answer) {
        return { text: match.answer, source: 'faq' }
      }
    }
  }

  // Feature 2: Product Q&A (if enabled)
  if (aiConfig.productQaEnabled) {
    const products = await db.product.findMany({
      where: { tenantId },
      select: { id: true, name: true, description: true, price: true, availability: true },
    })

    if (products.length > 0) {
      const result = await answerProductQuestion(visitorMessage, products)
      if (result.answered && result.answer) {
        return { text: result.answer, source: 'product' }
      }
    }
  }

  return null
}
