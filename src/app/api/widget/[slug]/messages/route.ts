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

    // === AI-Q2: Durable HTTP idempotency — checked BEFORE the message limit ===
    // A previously persisted visitor message must remain retrievable using
    // its original clientMessageId, even when that message exhausted the
    // Free weekly limit. Authentication, tenant authorization, access
    // policies and domain restrictions have already been enforced above.
    // The message limit is a quota gate for NEW messages — a replay of an
    // already-persisted message must NOT be blocked by it.
    if (clientMessageId) {
      const existing = await db.visitorMessageIdempotency.findUnique({
        where: {
          tenantId_contactId_clientMessageId: {
            tenantId,
            contactId,
            clientMessageId,
          },
        },
        select: { messageId: true, conversationId: true, messageText: true },
      })

      if (existing) {
        // Conflict detection: same key, different text → 409.
        if (existing.messageText !== text) {
          return { kind: 'idempotency_conflict' as const }
        }

        // Idempotent retry — return the original message.
        const origMessage = await db.message.findUnique({
          where: { id: existing.messageId },
        })
        const origConversation = await db.conversation.findUnique({
          where: { id: existing.conversationId },
        })
        if (origMessage && origConversation) {
          return {
            kind: 'ok' as const,
            message: origMessage,
            conversation: origConversation,
            isNew: false,
            isIdempotentRetry: true,
          }
        }
        // If the original message/conversation was deleted (cascade), fall
        // through to create a new one.
      }
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

    // Find or create the conversation. The visitor Message, idempotency
    // claim, AND conversation creation must be inside ONE database
    // transaction so a losing concurrent request cannot leave orphan
    // Messages, Conversations or routing side effects.
    // Uses the fail-closed db proxy (already inside withTenant) — tenantId
    // is auto-injected and enforced by the Prisma extension.
    let conversation: { id: string } | null = null
    let message: { id: string; content: unknown; senderType: string; conversationId: string; createdAt: Date; status: string } | null = null
    let isNew = false

    try {
      const txResult = await db.$transaction(async (tx) => {
        // Find an existing open conversation for this contact.
        let conv = await tx.conversation.findFirst({
          where: { contactId, tenantId, status: 'open' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })

        const createdNew = !conv
        if (!conv) {
          conv = await tx.conversation.create({
            data: {
              tenantId,
              contactId,
              status: 'open',
              channel: 'widget',
              tags: [],
            },
            select: { id: true },
          })
        }

        // Create the visitor Message inside the transaction.
        const msg = await tx.message.create({
          data: {
            conversationId: conv.id,
            tenantId,
            senderType: 'contact',
            senderUserId: null,
            contentType: 'text',
            content: pageContext
              ? { text, pageContext: { pathname: pageContext.pathname, title: pageContext.title } }
              : { text },
            status: 'sent',
          },
          select: { id: true, content: true, senderType: true, conversationId: true, createdAt: true, status: true },
        })

        // Create the idempotency claim inside the SAME transaction.
        // If a concurrent request already created the record, the unique
        // constraint throws — the ENTIRE transaction rolls back (no orphan
        // Message, no orphan Conversation).
        if (clientMessageId) {
          await tx.visitorMessageIdempotency.create({
            data: {
              tenantId,
              contactId,
              clientMessageId,
              messageId: msg.id,
              conversationId: conv.id,
              messageText: text,
            },
          })
        }

        return { conv, msg, createdNew }
      })

      conversation = txResult.conv
      message = txResult.msg
      isNew = txResult.createdNew
    } catch (e) {
      // Concurrent idempotency create — unique constraint violation.
      // The ENTIRE transaction was rolled back (no orphan Message or
      // Conversation). Re-query using the fail-closed db proxy (tenant-
      // scoped) and return the original — with text comparison for
      // conflict detection.
      if (clientMessageId) {
        const concurrent = await db.visitorMessageIdempotency.findUnique({
          where: {
            tenantId_contactId_clientMessageId: {
              tenantId,
              contactId,
              clientMessageId,
            },
          },
          select: { messageId: true, conversationId: true, messageText: true },
        })
        if (concurrent) {
          // Compare text — different content with the same key is a conflict.
          if (concurrent.messageText !== text) {
            return { kind: 'idempotency_conflict' as const }
          }
          const origMessage = await db.message.findUnique({
            where: { id: concurrent.messageId },
            select: { id: true, content: true, senderType: true, conversationId: true, createdAt: true, status: true },
          })
          const origConversation = await db.conversation.findUnique({
            where: { id: concurrent.conversationId },
            select: { id: true },
          })
          if (origMessage && origConversation) {
            return {
              kind: 'ok' as const,
              message: origMessage,
              conversation: origConversation,
              isNew: false,
              isIdempotentRetry: true,
            }
          }
        }
      }
      throw new Error('Failed to persist visitor message')
    }

    // Evaluate routing rules for a new conversation — ONLY after the
    // winning transaction has committed. Losing transactions rolled back
    // their conversation creation, so this fires exactly once.
    if (isNew) {
      await evaluateRoutingRules(conversation!.id, tenantId, text)
    }

    // Update conversation metadata. tenantId auto-injected in where.
    // Only for non-idempotent (first) submissions — retries skip this.
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
  if (result.kind === 'idempotency_conflict') {
    return widgetHeaders(NextResponse.json({ error: 'idempotency_conflict' }, { status: 409 }))
  }
  if (result.kind !== 'ok') {
    // Unreachable — exhaustiveness guard
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  const { message, conversation, isNew } = result
  const isIdempotentRetry = 'isIdempotentRetry' in result && result.isIdempotentRetry

  // === AI-Q2: Idempotent retry short-circuit ===
  // If this is a retry resolved to the original visitor Message, skip all
  // side effects: no Realtime duplicate, no AI reservation, no AI charge.
  // Fetch the original AI reply (if any) so the response includes it.
  if (isIdempotentRetry) {
    let retryAiResponse: { text: string; source: string } | null = null
    try {
      // Check if an AI reservation exists for the original visitor message.
      const reservation = await withTenant(tenantId, () =>
        db.aiReplyReservation.findUnique({
          where: { tenantId_visitorMessageId: { tenantId, visitorMessageId: message.id } },
          select: { status: true, aiMessageId: true },
        }),
      )
      if (reservation?.status === 'committed' && reservation.aiMessageId) {
        const aiMsg = await withTenant(tenantId, () =>
          db.message.findUnique({
            where: { id: reservation.aiMessageId! },
            select: { content: true },
          }),
        )
        if (aiMsg?.content) {
          const c = aiMsg.content as { text?: string; source?: string }
          retryAiResponse = c.text && c.source ? { text: c.text, source: c.source } : null
        }
      }
    } catch {
      // If we can't fetch the original AI reply, return null — the client
      // can reconcile from the message thread.
    }

    return widgetHeaders(NextResponse.json({
      message,
      conversationId: conversation.id,
      aiResponse: retryAiResponse,
      clientMessageId: clientMessageId || undefined,
    }))
  }

  // Publish to realtime — fan out to agents in the conversation room + tenant room.
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
  let aiResponse: { messageId: string; text: string; source: string } | null = null
  try {
    aiResponse = await withTenant(tenantId, () => tryAiResponse(text, tenantId, conversation.id, message.id))
  } catch (e) {
    console.error('[widget:messages] AI error:', e instanceof Error ? e.message : e)
  }

  if (aiResponse) {
    // The AI message is already durably persisted by commitAiReply. The
    // usage charge is already settled. Post-commit operations (metadata
    // update, Realtime publication) are best-effort — a transient failure
    // here must NOT cause the client to believe the AI reply failed and
    // retry (which would charge a second unit).
    try {
      await withTenant(tenantId, async () => {
        await db.conversation.updateMany({
          where: { id: conversation.id },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: `[AI] ${aiResponse!.text.slice(0, 116)}`,
          },
        })
      })
    } catch (e) {
      // Metadata update failure is recoverable — the AI message and its
      // usage charge are already durable. Log and continue.
      console.error('[widget:messages] post-commit metadata error:', e instanceof Error ? e.message : e)
    }

    // Fetch the committed AI message for realtime publication.
    const aiMessage = await withTenant(tenantId, () =>
      db.message.findUnique({ where: { id: aiResponse!.messageId } }),
    ).catch(() => null)

    if (aiMessage) {
      try {
        await publishToRealtime({
          room: room.conversation(conversation.id),
          event: EVENTS.MESSAGE_NEW,
          payload: { ...aiMessage, isNewConversation: false },
        })
      } catch (e) {
        // Realtime publication failure is recoverable — the AI message is
        // already persisted with a stable ID. The client can reconcile via
        // the message ID returned in the response. Do NOT generate another
        // AI reply or charge another unit to retry publication.
        console.error('[widget:messages] post-commit realtime error:', e instanceof Error ? e.message : e)
      }
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
  const { resolveExactFaq } = await import('@/lib/ai/faq-policy')
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
        // AI-Q3: safe deterministic exact matching with ambiguity detection.
        // - 'matched': exactly one canonical match with a nonblank answer →
        //   deliver the owner-authored answer deterministically (no LLM).
        // - 'ambiguous': multiple canonical duplicates → NEVER select an
        //   arbitrary row, NEVER fall through to semantic classification,
        //   NEVER produce a charge. Skip FAQ entirely for this message.
        // - 'none': no canonical match → try semantic classification.
        const exact = resolveExactFaq(visitorMessage, faqPairs)
        if (exact.status === 'matched') {
          generated = { text: exact.answer, source: 'faq' }
        } else if (exact.status === 'none') {
          // Semantic classification (LLM-based) with strict confidence gate.
          const match = await matchFaq(visitorMessage, faqPairs)
          if (match.matched && match.answer) {
            generated = { text: match.answer, source: 'faq' }
          }
        }
        // 'ambiguous' → skip FAQ (no generation, reservation will be released).
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
