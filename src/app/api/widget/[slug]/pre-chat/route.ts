import { NextRequest, NextResponse } from 'next/server'
import { db, globalDb, withTenant } from '@/lib/db'
import { verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import {
  resolveEffectivePreChatForm,
  type StoredPreChatFormInput,
} from '@/lib/widget/effective-pre-chat-form'
import { validatePreChatSubmission } from '@/lib/widget/pre-chat-form-policy'
import { parseAccessMode, parsePolicyVersion, evaluateSendAuthorization, resolveLegacyTokenIdentity } from '@/lib/widget-access-policy'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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

export const dynamic = 'force-dynamic'

/**
 * POST /api/widget/[slug]/pre-chat — visitor submits the pre-chat form.
 *
 * Authorization: same CURRENT-policy enforcement as /messages:
 *   - Visitor Bearer token verified (401 missing/invalid).
 *   - Token slug + tenant bound to the route (403 mismatch).
 *   - CURRENT accessMode + policyVersion resolved strictly.
 *   - Contact identity class verified (anonymous / verified_contact / external_user).
 *   - evaluateSendAuthorization enforces the current policy.
 *   - Stale tokens from a prior access-mode are rejected.
 *
 * NEVER sets emailVerifiedAt, changes identityLevel, alters externalUserId,
 * or mints a stronger token. Pre-chat submission is NOT identity verification.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // ---- Token verification (same as messages) ----
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) {
    return widgetHeaders(NextResponse.json({ error: 'no_token' }, { status: 401 }))
  }

  const payload = verifyToken(token)
  if (!payload || payload.type !== 'visitor') {
    return widgetHeaders(NextResponse.json({ error: 'invalid_token' }, { status: 401 }))
  }

  const { contactId, tenantId, slug: tokenSlug } = payload as VisitorTokenPayload
  if (tokenSlug !== slug) {
    return widgetHeaders(NextResponse.json({ error: 'token_slug_mismatch' }, { status: 403 }))
  }

  // Load tenant + widgetConfig for CURRENT-policy authorization.
  const tokenTenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tokenTenant || tokenTenant.id !== tenantId) {
    return widgetHeaders(NextResponse.json({ error: 'token_tenant_mismatch' }, { status: 403 }))
  }

  if (!tokenTenant.widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // ---- CURRENT-policy resolution (strict — same as messages) ----
  const accessMode = parseAccessMode(tokenTenant.widgetConfig.accessMode)
  if (accessMode === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  const currentPolicyVersion = parsePolicyVersion(tokenTenant.widgetConfig.policyVersion)
  if (currentPolicyVersion === null) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // ---- Parse body early (before tenant-scoped work) ----
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return widgetHeaders(NextResponse.json({ error: 'invalid_json' }, { status: 400 }))
  }

  // ---- Tenant-scoped authorization + form resolution + persistence ----
  const result = await withTenant(tenantId, async () => {
    // === CURRENT-policy send authorization (same as messages) ===
    const isLegacy = payload.identityLevel === undefined && payload.policyVersion === undefined
    const resolvedIdentity = resolveLegacyTokenIdentity({
      currentAccessMode: accessMode,
      tokenIdentityLevel: payload.identityLevel,
      tokenPolicyVersion: payload.policyVersion,
    })
    if (resolvedIdentity === null) {
      const reason = isLegacy
        ? (accessMode === 'verified_visitor' ? 'verification_required' : 'website_login_required')
        : 'identity_token_invalid'
      return { kind: 'authorization_denied' as const, reason }
    }

    // Revalidate the Contact against the current tenant + identity class.
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      select: { id: true, tenantId: true, identifierType: true, externalUserId: true, emailVerifiedAt: true, metadata: true },
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

    // Evaluate CURRENT send authorization.
    const decision = evaluateSendAuthorization({
      accessMode,
      currentPolicyVersion,
      identityLevel: resolvedIdentity,
      presentedPolicyVersion: payload.policyVersion,
    })
    if (!decision.allowed) {
      return { kind: 'authorization_denied' as const, reason: decision.reason }
    }

    // ---- Resolve the EFFECTIVE pre-chat form ----
    const entitlements = getEntitlements(tokenTenant.plan)
    const storedInput: StoredPreChatFormInput = {
      appearanceV2: tokenTenant.widgetConfig?.appearanceV2,
    }
    const effectiveForm = resolveEffectivePreChatForm(storedInput, entitlements)

    // ---- Validate the submission ----
    const submissionResult = validatePreChatSubmission(body, effectiveForm)
    if (!submissionResult.ok) {
      return { kind: 'validation_error' as const, code: submissionResult.code }
    }
    const validatedData = submissionResult.data

    // ---- Persist into Contact.metadata (preserving existing) ----
    const existingMetadata =
      (contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata))
        ? contact.metadata as Record<string, unknown>
        : {}

    const mergedMetadata = {
      ...existingMetadata,
      preChat: validatedData,
    }

    await db.contact.update({
      where: { id: contactId },
      data: { metadata: mergedMetadata as never },
    })

    return { kind: 'ok' as const }
  })

  if (result.kind === 'authorization_denied') {
    const status = result.reason === 'policy_unavailable' ? 503 : 403
    return widgetHeaders(NextResponse.json({ error: result.reason }, { status }))
  }
  if (result.kind === 'validation_error') {
    return widgetHeaders(NextResponse.json({ error: result.code }, { status: 422 }))
  }
  if (result.kind !== 'ok') {
    return widgetHeaders(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
  }

  return widgetHeaders(NextResponse.json({ ok: true }))
}
