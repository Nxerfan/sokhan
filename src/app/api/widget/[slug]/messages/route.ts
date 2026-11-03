import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'
import { evaluateRoutingRules } from '@/lib/routing-engine'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { withTenant } from '@/lib/db'
import { checkMessageLimit } from '@/lib/payments/free-plan'
import { getRequestDomain, isDomainAllowed } from '@/lib/payments/domain-validation'
import { parseAccessMode, parsePolicyVersion, evaluateSendAuthorization, resolveLegacyTokenIdentity } from '@/lib/widget-access-policy'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import { resolveEffectivePreChatForm } from '@/lib/widget/effective-pre-chat-form'
import { shouldRequirePreChat, isPreChatComplete } from '@/lib/widget/pre-chat-form-policy'
import { resolveEffectiveContextChat } from '@/lib/widget/effective-context-chat'
import { acceptPageContext, type PageContext } from '@/lib/widget/context-chat-types'

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
  // Verify the token's tenant corresponds to this slug + load the CURRENT
  // WidgetConfig (for current-policy send authorization).
  const tokenTenant = await db.tenant.findUnique({ where: { slug }, include: { widgetConfig: true } })
  if (!tokenTenant || tokenTenant.id !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'token_tenant_mismatch' }, { status: 403 }))
  }

  const body = await req.json()
  const text = String(body.text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH)
  if (!text) {
    return widgetHeaders(NextResponse.json({ error: 'empty_message' }, { status: 400 }))
  }

  // === CURRENT-policy resolution (#1, #2). Strict — never coerce. ===
  if (!tokenTenant.widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const accessMode = parseAccessMode(tokenTenant.widgetConfig.accessMode)
  if (accessMode === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const currentPolicyVersion = parsePolicyVersion(tokenTenant.widgetConfig.policyVersion)
  if (currentPolicyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // clientMessageId — ephemeral per-send correlation identifier generated
  // by the widget. NOT persisted to PostgreSQL. Used only to reconcile
  // the widget's optimistic placeholder with the persisted server message.
  // Bounded to 100 chars (trimmed). No character-set validation — the
  // widget generates 'cmsg_<seq>_<timestamp>' which is safe ASCII.
  const clientMessageId = String(body.clientMessageId ?? '').trim().slice(0, 100)

  // === Context Chat (Feature 11) — server-authoritative resolution ===
  // Resolve the tenant's CURRENT Context Chat entitlement + effective
  // configuration from the CURRENT authenticated tenant (never from
  // client-controlled data — an incoming `enabled`/plan flag is ignored).
  // The public config exposes ONLY the effective boolean; a stored paid-era
  // preference never authorizes context on Free. acceptPageContext then
  // validates the OPTIONAL visitor-supplied `pageContext`:
  //   - Effective disabled (Free / disabled / unknown) → ANY supplied
  //     context (including forged payloads) is dropped → null.
  //   - No explicit context with this send → null (no automatic scraping).
  //   - Malformed context → null (an invalid context is never persisted
  //     and never corrupts the valid message text).
  // The context is persisted alongside the text ONLY on the visitor's own
  // message — never on an AI/agent/system message — and is treated as
  // user-controlled information (NOT authenticated proof of the page).
  const contextChatEntitlements = getEntitlements(tokenTenant.plan)
  const effectiveContextChat = resolveEffectiveContextChat(
    { appearanceV2: tokenTenant.widgetConfig?.appearanceV2 },
    contextChatEntitlements,
  )
  let pageContext: PageContext | null = null
  try {
    pageContext = acceptPageContext(body.pageContext, effectiveContextChat.enabled)
  } catch {
    pageContext = null
  }

  // Wrap ALL tenant-scoped DB work in withTenant. The fail-closed Prisma
  // extension requires a current tenant context for any read/write against
  // tenant-scoped models (WidgetDomain, Message, Conversation, AiConfig,
  // FaqPair, Product, etc.). Without this, the queries throw
  // `TenantContextRequiredError` and the widget POST breaks.
  const result = await withTenant(tenantId, async () => {
    // === CURRENT-policy send authorization (#1, #3-9) — BEFORE any persistence. ===
    // Resolve the token's identityLevel. Legacy (both claims absent) is accepted
    // ONLY in anonymous mode. Partial/malformed claims -> identity_token_invalid.
    const isLegacy = payload.identityLevel === undefined && payload.policyVersion === undefined
    const resolvedIdentity = resolveLegacyTokenIdentity({ currentAccessMode: accessMode, tokenIdentityLevel: payload.identityLevel, tokenPolicyVersion: payload.policyVersion })
    if (resolvedIdentity === null) {
      if (isLegacy) {
        // Both claims absent + non-anonymous mode -> mode-specific deny.
        const reason = accessMode === 'verified_visitor' ? 'verification_required' : 'website_login_required'
        return { kind: 'authorization_denied' as const, reason }
      }
      // Partial/malformed modern claims -> identity_token_invalid (#7).
      return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
    }

    // Revalidate the Contact against the route tenant + identity class (#8, #9).
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      select: { id: true, tenantId: true, identifierType: true, externalUserId: true, emailVerifiedAt: true },
    })
    if (!contact || contact.tenantId !== tenantId) {
      return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
    }
    if (resolvedIdentity === 'anonymous' || resolvedIdentity === 'verified_contact') {
      if (contact.identifierType !== 'visitorId' || contact.externalUserId !== null) {
        return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
      }
      if (resolvedIdentity === 'verified_contact' && contact.emailVerifiedAt === null) {
        return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
      }
    } else if (resolvedIdentity === 'external_user') {
      if (contact.identifierType !== 'externalUser' || contact.externalUserId === null) {
        return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
      }
    }

    // Evaluate CURRENT send authorization (#3, #5).
    const decision = evaluateSendAuthorization({
      accessMode,
      currentPolicyVersion,
      identityLevel: resolvedIdentity,
      presentedPolicyVersion: payload.policyVersion,
    })
    if (!decision.allowed) {
      const reason = decision.reason
      if (reason === 'policy_unavailable') return { kind: 'authorization_denied' as const, reason: 'policy_unavailable' }
      if (reason === 'policy_changed') return { kind: 'authorization_denied' as const, reason: 'policy_changed' }
      if (reason === 'verification_required') return { kind: 'authorization_denied' as const, reason: 'verification_required' }
      if (reason === 'website_login_required') return { kind: 'authorization_denied' as const, reason: 'website_login_required' }
      return { kind: 'authorization_denied' as const, reason: 'identity_token_invalid' }
    }

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

    // === Pre-chat Form server-side gate (Feature 7) ===
    // Before persisting the visitor's first message, check if a pre-chat form
    // is required and has not been completed. This is a SERVER-SIDE check —
    // the client cannot bypass it.
    //
    // An existing visitor with a previously persisted VISITOR message in ANY
    // conversation (open, pending, resolved, closed) is exempt — they already
    // started a conversation before the form was configured. Only the visitor's
    // OWN messages count (senderType: 'contact'); agent/AI/system messages do
    // NOT exempt the visitor.
    {
      // Efficient existence query: check if this contact has ANY persisted
      // visitor message across ALL their conversations (any status). Uses
      // a bounded count (take: 1) so it doesn't load full message histories.
      const visitorMessageCount = await db.message.count({
        where: {
          senderType: 'contact',
          conversation: {
            contactId,
            tenantId,
          },
        },
        take: 1,
      })
      const hasPersistedVisitorMessage = visitorMessageCount > 0

      if (!hasPersistedVisitorMessage) {
        // Resolve the effective pre-chat form from the tenant's config + plan.
        const widgetConfig = await db.widgetConfig.findUnique({
          where: { tenantId },
          select: { appearanceV2: true },
        })
        const entitlements = getEntitlements(tokenTenant.plan)
        const effectiveForm = resolveEffectivePreChatForm(
          { appearanceV2: widgetConfig?.appearanceV2 },
          entitlements,
        )

        // Validate stored pre-chat values against the CURRENT required fields.
        const fullContact = await db.contact.findUnique({
          where: { id: contactId },
          select: { metadata: true },
        })
        const contactMetadata = fullContact?.metadata as Record<string, unknown> | null
        const storedPreChat = contactMetadata?.preChat as Record<string, unknown> | undefined
        const hasCompletedForm = isPreChatComplete(effectiveForm, storedPreChat)

        if (shouldRequirePreChat(effectiveForm, hasPersistedVisitorMessage, hasCompletedForm)) {
          return { kind: 'pre_chat_required' as const }
        }
      }
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
    // Context Chat (Feature 11): the sanitized authorized pageContext (or
    // null) is persisted inside the EXISTING Message JSON content alongside
    // the text — no schema change, no extra table. Ordinary messages
    // without context keep the plain { text } content shape.
    const message = await db.message.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        senderType: 'contact',
        senderUserId: null,
        contentType: 'text',
        // Fresh object literal (spread into primitives) so the Prisma
        // InputJsonValue typing accepts the nested page context.
        content: pageContext
          ? { text, pageContext: { pathname: pageContext.pathname, title: pageContext.title } }
          : { text },
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

  if (result.kind === 'authorization_denied') {
    const status = result.reason === 'policy_unavailable' ? 503 : 403
    return widgetHeaders(NextResponse.json({ error: result.reason }, { status }))
  }
  if (result.kind === 'domain_not_allowed') {
    return widgetHeaders(NextResponse.json({ error: 'domain_not_allowed' }, { status: 403 }))
  }
  if (result.kind === 'message_limit') {
    return widgetHeaders(NextResponse.json({ error: result.reason }, { status: 403 }))
  }
  if (result.kind === 'pre_chat_required') {
    return widgetHeaders(NextResponse.json({ error: 'pre_chat_required' }, { status: 403 }))
  }
  if (result.kind !== 'ok') {
    // Unreachable — exhaustiveness guard
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  const { message, conversation, isNew } = result

  // Publish to realtime — fan out to agents in the conversation room + tenant room.
  // Include the ephemeral clientMessageId in the message:new payload so the
  // widget can reconcile its optimistic placeholder with the exact persisted
  // message (not just by text, which is unsafe for duplicate identical sends).
  await publishToRealtime({
    room: room.conversation(conversation.id),
    event: EVENTS.MESSAGE_NEW,
    payload: { ...message, isNewConversation: isNew, clientMessageId: clientMessageId || undefined },
  })

  if (isNew) {
    await publishToRealtime({
      room: room.tenant(tenantId),
      event: EVENTS.CONVERSATION_NEW,
      payload: { conversationId: conversation.id, contactId, preview: text.slice(0, 120) },
    })
  }

  // === AI features — fire AFTER the visitor message is persisted ===
  // AI-Q2: atomic reserve → generate → commit/release flow.
  // - Reserve one AI capacity unit before generation (atomic, respects quota).
  // - If quota exhausted, no AI; human chat continues normally.
  // - If no answer produced, release the reservation (frees the slot).
  // - If an answer is produced, atomically commit (persist AI message +
  //   settle reservation + update usage counters in one transaction).
  // - Realtime publication happens after durable commit; failure doesn't
  //   double-charge.
  // - If any provider or accounting operation fails, the visitor's
  //   already-persisted message is NOT destroyed.
  let aiResponse: { messageId: string; text: string; source: string } | null = null
  try {
    aiResponse = await withTenant(tenantId, () => tryAiResponse(text, tenantId, conversation.id, message.id))
  } catch (e) {
    console.error('[widget:messages] AI error:', e instanceof Error ? e.message : e)
  }

  if (aiResponse) {
    // The AI message is already persisted by commitAiReply. Update the
    // conversation metadata and publish to realtime.
    await withTenant(tenantId, async () => {
      await db.conversation.updateMany({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: `[AI] ${aiResponse!.text.slice(0, 116)}`,
        },
      })
    })

    // Fetch the committed AI message for realtime publication.
    const aiMessage = await withTenant(tenantId, () =>
      db.message.findUnique({ where: { id: aiResponse!.messageId } }),
    )

    if (aiMessage) {
      await publishToRealtime({
        room: room.conversation(conversation.id),
        event: EVENTS.MESSAGE_NEW,
        payload: { ...aiMessage, isNewConversation: false },
      })
    }
  }

  return widgetHeaders(NextResponse.json({
    message,
    conversationId: conversation.id,
    aiResponse: aiResponse ? { text: aiResponse.text, source: aiResponse.source } : null,
    clientMessageId: clientMessageId || undefined,
  }))
}

/**
 * Try to generate an AI response for the visitor's message.
 *
 * AI-Q2 flow:
 * 1. Check AI config (feature toggles).
 * 2. Reserve one AI capacity unit (atomic, respects quota).
 * 3. If reservation succeeds, attempt exact FAQ → semantic FAQ → Product Q&A.
 * 4. If no answer, release the reservation (no charge).
 * 5. If an answer is produced, atomically commit (persist AI message +
 *    settle reservation + update usage).
 * 6. Return the committed messageId + text + source, or null.
 *
 * The `visitorMessageId` (the persisted visitor Message ID) is used for
 * reservation idempotency — a duplicate reservation for the same visitor
 * message returns the original, never allocates a second slot.
 */
async function tryAiResponse(
  visitorMessage: string,
  tenantId: string,
  conversationId: string,
  visitorMessageId: string,
): Promise<{ messageId: string; text: string; source: 'faq' | 'product' } | null> {
  const { db } = await import('@/lib/db')
  const { matchFaq, answerProductQuestion } = await import('@/lib/ai')
  const { reserveAiReply, commitAiReply, releaseAiReply } = await import('@/lib/ai/usage-service')

  // Load AI config
  const aiConfig = await db.aiConfig.findUnique({ where: { tenantId } })
  if (!aiConfig) return null

  // At least one feature must be enabled.
  if (!aiConfig.faqEnabled && !aiConfig.productQaEnabled) return null

  // --- Reserve one AI capacity unit (atomic, respects quota) ---
  const reservation = await reserveAiReply({ tenantId, conversationId, visitorMessageId })
  if (reservation.status !== 'reserved') {
    // limit_reached (Free zero, exhausted quota), in_progress (duplicate),
    // or already_committed (retry) — no new generation.
    return null
  }

  // --- Generate the AI response ---
  let generated: { text: string; source: 'faq' | 'product' } | null = null

  try {
    // Feature 1: FAQ matching (if enabled)
    if (aiConfig.faqEnabled) {
      const faqPairs = await db.faqPair.findMany({
        where: { tenantId, enabled: true },
        select: { id: true, question: true, answer: true },
      })

      if (faqPairs.length > 0) {
        // Exact-match fast path (deterministic, no LLM)
        const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
        const exact = faqPairs.find(f => norm(f.question) === norm(visitorMessage))
        if (exact) {
          generated = { text: exact.answer, source: 'faq' }
        } else {
          // Semantic classification (LLM-based)
          const match = await matchFaq(visitorMessage, faqPairs)
          if (match.matched && match.answer) {
            generated = { text: match.answer, source: 'faq' }
          }
        }
      }
    }

    // Feature 2: Product Q&A (if enabled)
    if (!generated && aiConfig.productQaEnabled) {
      const products = await db.product.findMany({
        where: { tenantId },
        select: { id: true, name: true, description: true, price: true, availability: true },
      })

      if (products.length > 0) {
        const result = await answerProductQuestion(visitorMessage, products)
        if (result.answered && result.answer) {
          generated = { text: result.answer, source: 'product' }
        }
      }
    }
  } catch (e) {
    console.error('[widget:messages] AI generation error:', e instanceof Error ? e.message : e)
  }

  // --- Commit or release ---
  if (!generated) {
    // No answer — release the reservation (frees the slot, no charge).
    await releaseAiReply({ tenantId, reservationId: reservation.reservationId })
    return null
  }

  // Atomically commit: persist AI message + settle reservation + update usage.
  const commit = await commitAiReply({
    tenantId,
    reservationId: reservation.reservationId,
    conversationId,
    text: generated.text,
    source: generated.source,
  })

  if (commit.status !== 'committed') {
    // Reservation was stale/reclaimed — no charge, no message.
    return null
  }

  return { messageId: commit.messageId, text: generated.text, source: generated.source }
}
