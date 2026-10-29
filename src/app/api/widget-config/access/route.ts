import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { getIntegrationSecretStatus } from '@/lib/widget-integration-credential'
import { parseAccessMode, parsePolicyVersion, isValidLoginUrl, isValidLoginButtonLabel, isValidReturnUrlParam, isValidIdentityEndpointPath, ALLOWED_PATCH_KEYS } from '@/lib/widget-access-policy'

/**
 * Dashboard Access & Identity configuration (feat/widget-visitor-access-modes).
 *
 *   GET   /api/widget-config/access
 *   PATCH /api/widget-config/access
 *
 * STRICT contract (no coercion):
 *   - GET uses parseAccessMode + parsePolicyVersion; a corrupt DB value NEVER
 *     silently becomes 'anonymous' -> 503 policy_unavailable. No fabricated
 *     fallback policy.
 *   - PATCH strictly validates JSON types (no String()/slice() coercion). A
 *     wrong type is rejected. Unknown fields are rejected (no silent ignore of
 *     typos). An array as the top-level body is rejected. Client input can
 *     NEVER set policyVersion / integrationSecretHash / etc.
 *   - PATCH fail-closes on a corrupt CURRENT policy (parseAccessMode +
 *     parsePolicyVersion of the existing row) -> 503 policy_unavailable. PATCH
 *     is NOT an accidental repair path for corrupt policy state.
 *   - policyVersion transition: an accessMode CHANGE increments policyVersion
 *     exactly once (atomic). Same-mode + non-mode PATCH do NOT increment.
 *   - GET NEVER returns the raw integration secret or the hash (only hasSecret
 *     + rotatedAt).
 *
 * PATCH remains admin-only. The integration secret itself is managed via the
 * dedicated /api/widget-config/integration-secret route.
 */

export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const config = await db.widgetConfig.findUnique({
      where: { tenantId: tid },
      select: {
        accessMode: true,
        policyVersion: true,
        loginUrl: true,
        loginButtonLabel: true,
        loginReturnUrlParam: true,
        identityEndpointPath: true,
      },
    })
    if (!config) return { notFound: true as const }
    // STRICT parse — a corrupt DB value NEVER silently becomes 'anonymous'.
    const accessMode = parseAccessMode(config.accessMode)
    if (accessMode === null) return { policyUnavailable: true as const }
    const policyVersion = parsePolicyVersion(config.policyVersion)
    if (policyVersion === null) return { policyUnavailable: true as const }
    const secretStatus = await getIntegrationSecretStatus()
    return {
      accessMode,
      policyVersion,
      integrationSecret: { hasSecret: secretStatus.hasSecret, rotatedAt: secretStatus.rotatedAt },
      loginUrl: config.loginUrl,
      loginButtonLabel: config.loginButtonLabel,
      loginReturnUrlParam: config.loginReturnUrlParam,
      identityEndpointPath: config.identityEndpointPath,
    }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('notFound' in result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if ('policyUnavailable' in result.result) return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  return NextResponse.json(result.result)
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json().catch(() => null)
    // Reject non-object OR array top-level body.
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_body' as const }

    const tid = getCurrentTenantId()!
    const existing = await db.widgetConfig.findUnique({
      where: { tenantId: tid },
      select: { accessMode: true, policyVersion: true, loginUrl: true, loginButtonLabel: true, loginReturnUrlParam: true, identityEndpointPath: true },
    })
    if (!existing) return { notFound: true as const }

    // Reject unknown fields (no silent ignore of typos). This also blocks any
    // client attempt to set policyVersion / integrationSecretHash / etc.
    for (const k of Object.keys(body)) {
      if (!(ALLOWED_PATCH_KEYS as readonly string[]).includes(k)) return { error: 'unknown_field' as const }
    }

    // Fail closed on a corrupt CURRENT policy — PATCH is NOT a repair path.
    if (parseAccessMode(existing.accessMode) === null || parsePolicyVersion(existing.policyVersion) === null) {
      return { policyUnavailable: true as const }
    }

    const data: {
      accessMode?: string
      loginUrl?: string | null
      loginButtonLabel?: string | null
      loginReturnUrlParam?: string | null
      identityEndpointPath?: string | null
      policyVersion?: { increment: number }
    } = {}
    let accessModeChanged = false

    // Strict accessMode — string + parseAccessMode (no String() coercion, no
    // trim). Rejects " anonymous ", numbers, booleans, objects, arrays.
    if (body.accessMode !== undefined) {
      if (typeof body.accessMode !== 'string') return { error: 'invalid_access_mode' as const }
      const mode = parseAccessMode(body.accessMode)
      if (mode === null) return { error: 'invalid_access_mode' as const }
      if (mode !== existing.accessMode) {
        data.accessMode = mode
        accessModeChanged = true
      }
    }

    // Strict loginUrl — null OR valid string. No String() coercion.
    if (body.loginUrl !== undefined) {
      if (body.loginUrl === null) {
        data.loginUrl = null
      } else if (typeof body.loginUrl === 'string') {
        if (!isValidLoginUrl(body.loginUrl)) return { error: 'invalid_login_url' as const }
        data.loginUrl = body.loginUrl
      } else {
        return { error: 'invalid_login_url' as const }
      }
    }

    // Strict loginButtonLabel — null OR non-empty string <= 200. No slice.
    if (body.loginButtonLabel !== undefined) {
      if (body.loginButtonLabel === null) {
        data.loginButtonLabel = null
      } else if (typeof body.loginButtonLabel === 'string') {
        if (!isValidLoginButtonLabel(body.loginButtonLabel)) return { error: 'invalid_login_button_label' as const }
        data.loginButtonLabel = body.loginButtonLabel
      } else {
        return { error: 'invalid_login_button_label' as const }
      }
    }

    // Strict loginReturnUrlParam — null OR safe parameter name <= 100. No slice.
    if (body.loginReturnUrlParam !== undefined) {
      if (body.loginReturnUrlParam === null) {
        data.loginReturnUrlParam = null
      } else if (typeof body.loginReturnUrlParam === 'string') {
        if (!isValidReturnUrlParam(body.loginReturnUrlParam)) return { error: 'invalid_login_return_url_param' as const }
        data.loginReturnUrlParam = body.loginReturnUrlParam
      } else {
        return { error: 'invalid_login_return_url_param' as const }
      }
    }

    // Strict identityEndpointPath — null OR same-origin relative path <= 500. No slice.
    if (body.identityEndpointPath !== undefined) {
      if (body.identityEndpointPath === null) {
        data.identityEndpointPath = null
      } else if (typeof body.identityEndpointPath === 'string') {
        if (!isValidIdentityEndpointPath(body.identityEndpointPath)) return { error: 'invalid_identity_endpoint_path' as const }
        data.identityEndpointPath = body.identityEndpointPath
      } else {
        return { error: 'invalid_identity_endpoint_path' as const }
      }
    }

    // site_user_only may be saved BEFORE the integration secret / identity
    // endpoint are configured (the admin configures these in separate steps).
    // Runtime enforcement (fail-closed when integration is incomplete) is a
    // later phase — NOT implemented here.

    // policyVersion transition: an accessMode CHANGE increments exactly once
    // (atomic). Same-mode + non-mode PATCH do NOT increment.
    if (accessModeChanged) {
      data.policyVersion = { increment: 1 }
    }

    const updated = await db.widgetConfig.update({
      where: { tenantId: tid },
      data,
      select: { accessMode: true, policyVersion: true },
    })
    // Strict parse the updated (should be valid; be strict anyway).
    const updatedAccessMode = parseAccessMode(updated.accessMode)
    const updatedPolicyVersion = parsePolicyVersion(updated.policyVersion)
    if (updatedAccessMode === null || updatedPolicyVersion === null) {
      return { policyUnavailable: true as const }
    }
    return {
      accessMode: updatedAccessMode,
      policyVersion: updatedPolicyVersion,
      accessModeChanged,
    }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('notFound' in result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if ('policyUnavailable' in result.result) return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json(result.result)
}
