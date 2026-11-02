import { NextRequest, NextResponse } from 'next/server'
import { db, globalDb } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import {
  resolveEffectivePreChatForm,
  type StoredPreChatFormInput,
} from '@/lib/widget/effective-pre-chat-form'
import { validatePreChatSubmission } from '@/lib/widget/pre-chat-form-policy'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  // Prevent browser caching so policy changes propagate immediately.
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

/** Force dynamic rendering — never cache a pre-chat submission response. */
export const dynamic = 'force-dynamic'

/**
 * POST /api/widget/[slug]/pre-chat — visitor submits the pre-chat form.
 *
 * Security contract (Feature 7 — Pre-chat Form):
 *   - Authorization: Bearer visitor token (same verification as the messages
 *     route). Missing/invalid → 401. Token bound to the route slug + tenant
 *     → 403 on mismatch.
 *   - The server re-resolves the EFFECTIVE pre-chat form from the tenant's
 *     stored appearanceV2 + plan entitlements. The visitor NEVER controls
 *     which fields are accepted — `validatePreChatSubmission` rejects every
 *     key not in the effective server-side form (including privilege-
 *     escalation attempts like `emailVerifiedAt`, `identityLevel`, `role`).
 *   - On success, submitted values are stored in the Contact's `metadata`
 *     JSON column under a `preChat` key, preserving existing metadata.
 *   - NEVER sets `emailVerifiedAt`, changes `identityLevel`, alters
 *     `externalUserId`, or mints a stronger token. This endpoint is purely
 *     informational — it does NOT upgrade the visitor's identity class.
 *
 * The public route runs without a tenant session, so tenant-scoped reads
 * (WidgetConfig, Contact) use `globalDb` (the raw PrismaClient, unscoped).
 * The lookup is by the unique `tenantId` / `id` so no cross-tenant leak is
 * possible.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // ---- Authorization: visitor Bearer token (same pattern as messages) ----
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) {
    return widgetHeaders(NextResponse.json({ error: 'no_token' }, { status: 401 }))
  }

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_token' }, { status: 401 }))
  }

  const { contactId, tenantId, slug: tokenSlug } = payload as VisitorTokenPayload

  // Bind visitor token to the route slug — token A + slug B must be rejected.
  if (tokenSlug !== slug) {
    return widgetHeaders(NextResponse.json({ error: 'token_slug_mismatch' }, { status: 403 }))
  }

  // Verify the token's tenant corresponds to this slug + load the plan.
  // `Tenant` is not a tenant-scoped model, so `db` is safe here.
  const tokenTenant = await db.tenant.findUnique({
    where: { slug },
    select: { id: true, plan: true },
  })
  if (!tokenTenant || tokenTenant.id !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'token_tenant_mismatch' }, { status: 403 }))
  }

  // ---- Resolve the EFFECTIVE pre-chat form from the tenant's stored config ----
  // The public route runs without a tenant session — use `globalDb` (unscoped)
  // for the tenant-scoped WidgetConfig read (lookup is by unique `tenantId`).
  const widgetConfig = await globalDb.widgetConfig.findUnique({
    where: { tenantId: tenantId },
    select: { appearanceV2: true },
  })
  if (!widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  const entitlements = getEntitlements(tokenTenant.plan)
  const storedInput: StoredPreChatFormInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveForm = resolveEffectivePreChatForm(storedInput, entitlements)

  // ---- Parse + validate the submission body ----
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return widgetHeaders(NextResponse.json({ error: 'invalid_json' }, { status: 400 }))
  }

  const submissionResult = validatePreChatSubmission(body, effectiveForm)
  if (!submissionResult.ok) {
    // 422 Unprocessable Entity: the request was well-formed but the
    // submission violated the pre-chat form contract (missing required
    // field, unknown field, invalid email/phone, etc.).
    return widgetHeaders(
      NextResponse.json({ error: submissionResult.code }, { status: 422 }),
    )
  }
  const validatedData = submissionResult.data

  // ---- Persist the submitted values into Contact.metadata ----
  // Read the existing metadata first (to preserve any prior keys), then
  // merge under `preChat`. Uses `globalDb` (unscoped) since the public route
  // has no tenant session; the lookup is by `id` (cuid, globally unique) +
  // we additionally verify the contact belongs to the token's tenant.
  const existingContact = await globalDb.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true, metadata: true },
  })
  if (!existingContact || existingContact.tenantId !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'contact_not_found' }, { status: 404 }))
  }

  const existingMetadata =
    (existingContact.metadata && typeof existingContact.metadata === 'object' && !Array.isArray(existingContact.metadata))
      ? existingContact.metadata as Record<string, unknown>
      : {}

  const mergedMetadata = {
    ...existingMetadata,
    preChat: validatedData,
  }

  await globalDb.contact.update({
    where: { id: contactId },
    data: { metadata: mergedMetadata as never },
  })

  return widgetHeaders(NextResponse.json({ ok: true }))
}
