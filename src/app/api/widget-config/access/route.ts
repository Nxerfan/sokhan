import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { getIntegrationSecretStatus } from '@/lib/widget-integration-credential'
import { ACCESS_MODES, coerceAccessMode, type AccessMode } from '@/lib/widget-access-policy'

/**
 * Dashboard Access & Identity configuration (feat/widget-visitor-access-modes).
 *
 *   GET   /api/widget-config/access
 *   PATCH /api/widget-config/access
 *
 * GET returns the current access policy + integration-secret STATUS (never the
 * raw secret) + login config. PATCH (admin-only) updates the access mode +
 * login config; an accessMode CHANGE increments policyVersion atomically so
 * stricter policy transitions invalidate older weaker credentials IMMEDIATELY.
 *
 * The integration secret itself is managed via the dedicated
 * /api/widget-config/integration-secret route (POST generate/rotate, DELETE
 * revoke) — the raw secret is returned EXACTLY ONCE there, never here.
 */

/** Validate a login URL — http(s) or relative only (open-redirect prevention). */
function isValidLoginUrl(url: string | null | undefined): boolean {
  if (!url) return true // nullable
  if (url.length > 500) return false
  // Relative path (starts with / but not //), OR an absolute http(s) URL.
  if (/^\/[^/]/.test(url) || url === '/') return true
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }
  return false // reject protocol-relative //, javascript:, data:, etc.
}

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
    const secretStatus = await getIntegrationSecretStatus()
    return {
      accessMode: coerceAccessMode(config.accessMode),
      policyVersion: config.policyVersion,
      integrationSecret: { hasSecret: secretStatus.hasSecret, rotatedAt: secretStatus.rotatedAt },
      loginUrl: config.loginUrl,
      loginButtonLabel: config.loginButtonLabel,
      loginReturnUrlParam: config.loginReturnUrlParam,
      identityEndpointPath: config.identityEndpointPath,
    }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('notFound' in result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(result.result)
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return { error: 'invalid_body' as const }

    const tid = getCurrentTenantId()!
    const existing = await db.widgetConfig.findUnique({
      where: { tenantId: tid },
      select: { accessMode: true, policyVersion: true },
    })
    if (!existing) return { notFound: true as const }

    // Build the update data — only accepted fields, strictly validated.
    const data: {
      accessMode?: string
      loginUrl?: string | null
      loginButtonLabel?: string | null
      loginReturnUrlParam?: string | null
      identityEndpointPath?: string | null
      policyVersion?: { increment: number }
    } = {}

    let accessModeChanged = false

    if (body.accessMode !== undefined) {
      const mode = String(body.accessMode)
      if (!(ACCESS_MODES as readonly string[]).includes(mode)) {
        return { error: 'invalid_access_mode' as const }
      }
      if (mode !== existing.accessMode) {
        data.accessMode = mode
        accessModeChanged = true
      }
    }

    if (body.loginUrl !== undefined) {
      const url = body.loginUrl === null ? null : String(body.loginUrl)
      if (!isValidLoginUrl(url)) return { error: 'invalid_login_url' as const }
      data.loginUrl = url
    }
    if (body.loginButtonLabel !== undefined) {
      const label = body.loginButtonLabel === null ? null : String(body.loginButtonLabel).slice(0, 200)
      data.loginButtonLabel = label
    }
    if (body.loginReturnUrlParam !== undefined) {
      const p = body.loginReturnUrlParam === null ? null : String(body.loginReturnUrlParam).slice(0, 100)
      data.loginReturnUrlParam = p
    }
    if (body.identityEndpointPath !== undefined) {
      const path = body.identityEndpointPath === null ? null : String(body.identityEndpointPath).slice(0, 500)
      // Must be a relative path (same-origin customer endpoint) if provided.
      if (path !== null && !/^\/[^/]/.test(path) && path !== '/') {
        return { error: 'invalid_identity_endpoint_path' as const }
      }
      data.identityEndpointPath = path
    }

    // site_user_only requires an integration secret + identity endpoint to be
    // useful — but we do NOT hard-block saving (the admin may configure the
    // secret/endpoint after switching). The server enforcement will reject
    // sends until the secret/endpoint are configured. (Truthful UX, not a
    // silent failure.)

    if (accessModeChanged) {
      // Atomic: change accessMode + increment policyVersion in ONE update so
      // stricter policy transitions invalidate older weaker credentials
      // IMMEDIATELY (not just on token expiry).
      data.policyVersion = { increment: 1 }
    }

    const updated = await db.widgetConfig.update({
      where: { tenantId: tid },
      data,
      select: { accessMode: true, policyVersion: true },
    })
    return {
      accessMode: coerceAccessMode(updated.accessMode),
      policyVersion: updated.policyVersion,
      accessModeChanged,
    }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('notFound' in result.result) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json(result.result)
}
