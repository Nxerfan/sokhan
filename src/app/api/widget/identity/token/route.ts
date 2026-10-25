import { NextResponse, NextRequest } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { resolveTenantByIntegrationSecret } from '@/lib/widget-integration-credential'
import { signExternalIdentityToken } from '@/lib/widget-identity-tokens'
import { parseAccessMode } from '@/lib/widget-access-policy'
import crypto from 'crypto'

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}
function isSafeString(v: unknown, max = 200): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  return s.length > 0 && s.length <= max && !/\p{Cc}/u.test(s)
}
function isValidAvatarUrl(url: string): boolean {
  if (url.length > 500) return false
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

/**
 * Sukhan identity mint endpoint — server-to-server (site_user_only).
 * POST /api/widget/identity/token  Authorization: Bearer <integration-secret>
 * body: { externalUserId (REQUIRED), name?, username?, email?, avatarUrl? }
 *
 * Blocker 1: external-user Contact lookup uses (tenantId, externalUserId) via the
 * new externalUserId field — NOT the generic identifier. New external Contact:
 * externalUserId=stable sub, identifier=opaque generated ('ext_'+uuid), identifierType='externalUser'.
 * anonymous visitorId == externalUserId → TWO separate Contacts.
 * Blocker 5: the token carries ONLY claims (no profile PII); profile resolved/updated server-side.
 * Blocker 6: strict input validation (typeof string, trim, bounded, reject control chars).
 * Blocker 14: parseAccessMode (strict); mints ONLY if current mode is exactly site_user_only.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || ''
  const presentedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!presentedSecret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const tenant = await resolveTenantByIntegrationSecret(presentedSecret)
  if (!tenant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const accessMode = parseAccessMode(tenant.accessMode)
  if (accessMode === null) return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  if (accessMode !== 'site_user_only') return NextResponse.json({ error: 'mode_mismatch', message: 'Integration secret is for site_user_only mode' }, { status: 409 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  // Blocker 6: strict input validation.
  const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId.trim() : ''
  if (!externalUserId || externalUserId.length > 200 || /\p{Cc}/u.test(externalUserId)) {
    return NextResponse.json({ error: 'externalUserId_required' }, { status: 400 })
  }
  const name = typeof body.name === 'string' && body.name.trim().length > 0 && body.name.trim().length <= 200 ? body.name.trim() : undefined
  const username = typeof body.username === 'string' && body.username.trim().length > 0 && body.username.trim().length <= 200 ? body.username.trim() : undefined
  const email = typeof body.email === 'string' && body.email.trim().length > 0 ? body.email.trim().toLowerCase() : undefined
  if (email && !isValidEmail(email)) return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
  const avatarUrl = typeof body.avatarUrl === 'string' && body.avatarUrl.trim().length > 0 ? body.avatarUrl.trim() : undefined
  if (avatarUrl && !isValidAvatarUrl(avatarUrl)) return NextResponse.json({ error: 'invalid_avatar_url' }, { status: 400 })

  // Blocker 1: resolve/create the Contact by (tenantId, externalUserId) via the new field.
  // The generic `identifier` is an INDEPENDENTLY generated opaque value (NOT externalUserId).
  const { contactId } = await withTenant(tenant.tenantId, async () => {
    let contact = await db.contact.findUnique({
      where: { tenantId_externalUserId: { tenantId: tenant.tenantId, externalUserId } },
      select: { id: true },
    })
    if (!contact) {
      contact = await db.contact.create({
        data: {
          tenantId: tenant.tenantId,
          identifier: 'ext_' + crypto.randomUUID(),
          identifierType: 'externalUser',
          externalUserId,
          name: name || username || email || 'Authenticated user',
          email: email ?? null,
          avatarUrl: avatarUrl ?? null,
          locale: 'fa',
          metadata: {},
        },
        select: { id: true },
      })
    } else {
      // Update profile metadata server-side (Blocker 5: profile NOT in the token).
      const updates: Record<string, string | null> = {}
      if (name) updates.name = name
      if (email) updates.email = email
      if (avatarUrl) updates.avatarUrl = avatarUrl
      if (Object.keys(updates).length > 0) {
        await db.contact.update({ where: { id: contact.id }, data: updates })
      }
    }
    return { contactId: contact.id }
  })

  // Blocker 5: mint ONLY authorization/identity claims (no PII). Response {token} only.
  const token = signExternalIdentityToken({ tenantId: tenant.tenantId, externalUserId, contactId, policyVersion: tenant.policyVersion })
  return NextResponse.json({ token })
}
