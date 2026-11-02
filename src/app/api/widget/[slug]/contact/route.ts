import { NextRequest, NextResponse } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { signToken } from '@/lib/realtime-token'
import { verifyResumeCredential, verifyExternalIdentityToken } from '@/lib/widget-identity-tokens'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import { resolveEffectivePreChatForm } from '@/lib/widget/effective-pre-chat-form'
import { isPreChatComplete } from '@/lib/widget/pre-chat-form-policy'

/** CORS + rate-limit headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  const ip = getClientIP(req)
  const rateLimit = await checkRateLimit(ip, slug)
  if (!rateLimit.allowed) {
    return widgetHeaders(NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 60) } },
    ))
  }

  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant) {
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // #1 Strictly resolve the CURRENT policy. Never coerce, never fall back.
  if (!tenant.widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const accessMode = parseAccessMode(tenant.widgetConfig.accessMode)
  if (accessMode === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const policyVersion = parsePolicyVersion(tenant.widgetConfig.policyVersion)
  if (policyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // #2 Read the bearer credential (Authorization: Bearer <credential>).
  const authHeader = req.headers.get('authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

  // #19 The mode is AUTHORITATIVE.
  if (accessMode === 'anonymous') {
    return anonymousBootstrap(req, tenant, slug, policyVersion)
  }
  if (accessMode === 'verified_visitor') {
    return verifiedVisitorBootstrap(tenant, slug, policyVersion, bearer)
  }
  if (accessMode === 'site_user_only') {
    return siteUserBootstrap(tenant, slug, policyVersion, bearer)
  }
  return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
}

async function anonymousBootstrap(
  req: NextRequest,
  tenant: { id: string; defaultLocale: string; defaultDirection: string; plan: string; widgetConfig: { appearanceV2: unknown } | null },
  slug: string,
  policyVersion: number,
) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_body' }, { status: 400 }))
  }
  const visitorId = String(body.visitorId ?? '').trim().slice(0, 100)
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200)
  const name = String(body.name ?? '').trim().slice(0, 100)
  if (!visitorId) {
    return widgetHeaders(NextResponse.json({ error: 'visitorId_required' }, { status: 400 }))
  }
  if (email && !isValidEmail(email)) {
    return widgetHeaders(NextResponse.json({ error: 'invalid_email' }, { status: 400 }))
  }

  const result = await withTenant(tenant.id, async () => {
    let contact = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
    })
    if (contact && (contact.identifierType !== 'visitorId' || contact.externalUserId !== null)) {
      return { identityConflict: true as const }
    }
    if (!contact) {
      contact = await db.contact.create({
        data: {
          tenantId: tenant.id,
          identifier: visitorId,
          identifierType: 'visitorId',
          name: name || 'Visitor',
          email: email || null,
          locale: tenant.defaultLocale,
          metadata: {},
        },
      })
    } else {
      const updateData: { email?: string | null; name?: string } = {}
      if (email) updateData.email = email
      if (name) updateData.name = name
      if (Object.keys(updateData).length > 0) {
        contact = await db.contact.update({ where: { id: contact.id }, data: updateData })
      }
    }
    const existingConversation = await db.conversation.findFirst({
      where: { tenantId: tenant.id, contactId: contact.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    return { identityConflict: false as const, contact, existingConversation }
  })

  if ('identityConflict' in result && result.identityConflict) {
    return widgetHeaders(NextResponse.json({ error: 'identity_conflict' }, { status: 403 }))
  }
  const { contact, existingConversation } = result as { contact: { id: string; metadata: unknown }; existingConversation: { id: string } | null }

  const realtimeToken = signToken({
    type: 'visitor',
    contactId: contact.id,
    tenantId: tenant.id,
    slug,
    identityLevel: 'anonymous',
    policyVersion,
  })

  // Compute server-authoritative preChatCompleted. A returning visitor with
  // a previously persisted VISITOR message in ANY conversation (open/closed/
  // resolved/pending) is exempt from the form — they already started a chat
  // before the form was configured. Only the visitor's OWN messages count.
  const entitlements = getEntitlements(tenant.plan)
  const effectiveForm = resolveEffectivePreChatForm(
    { appearanceV2: tenant.widgetConfig?.appearanceV2 },
    entitlements,
  )
  const contactMetadata = (contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata))
    ? contact.metadata as Record<string, unknown>
    : {}

  // Check if this contact has ANY persisted visitor message across ALL
  // conversations (any status). Uses take:1 for an efficient existence check.
  const visitorMessageCount = await withTenant(tenant.id, async () => {
    return db.message.count({
      where: {
        senderType: 'contact',
        conversation: { contactId: contact.id, tenantId: tenant.id },
      },
      take: 1,
    })
  })
  const hasPersistedVisitorMessage = visitorMessageCount > 0

  // Form is completed if: (a) the visitor already has a persisted message
  // (exempt — pre-dates the form), or (b) the stored pre-chat values satisfy
  // the CURRENT effective form's required fields.
  const preChatCompleted = hasPersistedVisitorMessage || isPreChatComplete(
    effectiveForm,
    contactMetadata.preChat as Record<string, unknown> | undefined,
  )

  return widgetHeaders(NextResponse.json({
    contactId: contact.id,
    conversationId: existingConversation?.id ?? null,
    realtimeToken,
    locale: tenant.defaultLocale,
    direction: tenant.defaultDirection,
    preChatCompleted,
  }))
}

async function verifiedVisitorBootstrap(
  tenant: { id: string; defaultLocale: string; defaultDirection: string; plan: string; widgetConfig: { appearanceV2: unknown } | null },
  slug: string,
  policyVersion: number,
  bearer: string,
) {
  if (!bearer) {
    return widgetHeaders(NextResponse.json({ error: 'verification_required' }, { status: 403 }))
  }
  const resume = verifyResumeCredential(bearer, tenant.id, policyVersion)
  if (!resume) {
    return widgetHeaders(NextResponse.json({ error: 'verification_required' }, { status: 403 }))
  }

  const result = await withTenant(tenant.id, async () => {
    const contact = await db.contact.findUnique({ where: { id: resume.contactId } })
    if (!contact) return { ok: false as const }
    if (contact.tenantId !== tenant.id) return { ok: false as const }
    if (contact.identifierType !== 'visitorId') return { ok: false as const }
    if (contact.externalUserId !== null) return { ok: false as const }
    if (contact.emailVerifiedAt === null) return { ok: false as const }
    const existingConversation = await db.conversation.findFirst({
      where: { tenantId: tenant.id, contactId: contact.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    return { ok: true as const, contact, existingConversation }
  })
  if (!result.ok) {
    return widgetHeaders(NextResponse.json({ error: 'verification_required' }, { status: 403 }))
  }
  const { contact, existingConversation } = result

  const realtimeToken = signToken({
    type: 'visitor',
    contactId: contact.id,
    tenantId: tenant.id,
    slug,
    identityLevel: 'verified_contact',
    policyVersion,
  })

  const entitlements = getEntitlements(tenant.plan)
  const effectiveForm = resolveEffectivePreChatForm(
    { appearanceV2: tenant.widgetConfig?.appearanceV2 },
    entitlements,
  )
  const contactMetadata = (contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata))
    ? contact.metadata as Record<string, unknown>
    : {}
  // Historical visitor message exemption (same as anonymous bootstrap).
  const visitorMsgCount = await withTenant(tenant.id, async () => {
    return db.message.count({
      where: { senderType: 'contact', conversation: { contactId: contact.id, tenantId: tenant.id } },
      take: 1,
    })
  })
  const preChatCompleted = visitorMsgCount > 0 || isPreChatComplete(
    effectiveForm, contactMetadata.preChat as Record<string, unknown> | undefined,
  )

  return widgetHeaders(NextResponse.json({
    contactId: contact.id,
    conversationId: existingConversation?.id ?? null,
    realtimeToken,
    locale: tenant.defaultLocale,
    direction: tenant.defaultDirection,
    preChatCompleted,
  }))
}

async function siteUserBootstrap(
  tenant: { id: string; defaultLocale: string; defaultDirection: string; plan: string; widgetConfig: { appearanceV2: unknown } | null },
  slug: string,
  policyVersion: number,
  bearer: string,
) {
  if (!bearer) {
    return widgetHeaders(NextResponse.json({ error: 'website_login_required' }, { status: 403 }))
  }
  const ext = verifyExternalIdentityToken(bearer, tenant.id, policyVersion)
  if (!ext) {
    return widgetHeaders(NextResponse.json({ error: 'website_login_required' }, { status: 403 }))
  }
  if (!ext.contactId || !ext.externalUserId) {
    return widgetHeaders(NextResponse.json({ error: 'website_login_required' }, { status: 403 }))
  }

  const result = await withTenant(tenant.id, async () => {
    const contact = await db.contact.findUnique({ where: { id: ext.contactId! } })
    if (!contact) return { ok: false as const }
    if (contact.tenantId !== tenant.id) return { ok: false as const }
    if (contact.identifierType !== 'externalUser') return { ok: false as const }
    if (contact.externalUserId !== ext.externalUserId) return { ok: false as const }
    const existingConversation = await db.conversation.findFirst({
      where: { tenantId: tenant.id, contactId: contact.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    return { ok: true as const, contact, existingConversation }
  })
  if (!result.ok) {
    return widgetHeaders(NextResponse.json({ error: 'website_login_required' }, { status: 403 }))
  }
  const { contact, existingConversation } = result

  const realtimeToken = signToken({
    type: 'visitor',
    contactId: contact.id,
    tenantId: tenant.id,
    slug,
    identityLevel: 'external_user',
    policyVersion,
  })

  const entitlements = getEntitlements(tenant.plan)
  const effectiveForm = resolveEffectivePreChatForm(
    { appearanceV2: tenant.widgetConfig?.appearanceV2 },
    entitlements,
  )
  const contactMetadata = (contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata))
    ? contact.metadata as Record<string, unknown>
    : {}
  // Historical visitor message exemption (same as anonymous bootstrap).
  const visitorMsgCount = await withTenant(tenant.id, async () => {
    return db.message.count({
      where: { senderType: 'contact', conversation: { contactId: contact.id, tenantId: tenant.id } },
      take: 1,
    })
  })
  const preChatCompleted = visitorMsgCount > 0 || isPreChatComplete(
    effectiveForm, contactMetadata.preChat as Record<string, unknown> | undefined,
  )

  return widgetHeaders(NextResponse.json({
    contactId: contact.id,
    conversationId: existingConversation?.id ?? null,
    realtimeToken,
    locale: tenant.defaultLocale,
    direction: tenant.defaultDirection,
    preChatCompleted,
  }))
}
