import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import {
  generateOrRotateIntegrationSecret,
  revokeIntegrationSecret,
  getIntegrationSecretStatus,
} from '@/lib/widget-integration-credential'

/**
 * Dashboard integration-secret management (Mode 2, site_user_only).
 *
 *   POST   /api/widget-config/integration-secret   → generate OR rotate
 *   DELETE /api/widget-config/integration-secret   → revoke
 *   GET    /api/widget-config/integration-secret   → status (never raw)
 *
 * The raw secret is returned EXACTLY ONCE on POST (generate/rotate). It is
 * NEVER returned on GET. Both generate/rotate + revoke increment policyVersion
 * atomically (invalidating existing external-identity tokens immediately).
 *
 * Admin-only (manager+). Never browser-visible beyond the one-time POST
 * response shown to the workspace admin in the dashboard.
 */

export async function POST() {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    // Generate (or rotate): replaces the hash + increments policyVersion.
    // The raw secret is returned EXACTLY ONCE — the caller (dashboard) must
    // display it immediately + never persist it.
    const res = await generateOrRotateIntegrationSecret()
    return { rawSecret: res.rawSecret, hasSecret: res.hasSecret, rotatedAt: res.rotatedAt }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json(result.result)
}

export async function DELETE() {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    // Revoke: clears the hash + increments policyVersion. The customer's
    // backend can no longer mint.
    await revokeIntegrationSecret()
    return { revoked: true }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json(result.result)
}

export async function GET() {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    // SAFE — never the raw secret.
    const status = await getIntegrationSecretStatus()
    return { hasSecret: status.hasSecret, rotatedAt: status.rotatedAt }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json(result.result)
}
