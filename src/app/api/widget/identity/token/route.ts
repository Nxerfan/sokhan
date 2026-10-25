import { NextResponse, NextRequest } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { resolveTenantByIntegrationSecret } from '@/lib/widget-integration-credential'
import { signExternalIdentityToken } from '@/lib/widget-identity-tokens'
import { coerceAccessMode } from '@/lib/widget-access-policy'

/**
 * Sukhan identity mint endpoint — server-to-server.
 *
 *   POST /api/widget/identity/token
 *   Authorization: Bearer <integration-secret>
 *   body: { externalUserId (REQUIRED), name?, username?, email?, avatarUrl? }
 *
 * The CUSTOMER's backend calls this (never the browser). The integration
 * secret DETERMINES the tenant (a tenantId in the body is NEVER treated as
 * authority). The customer's server is the identity authority — the browser
 * never receives the integration secret; it receives only the short-lived
 * (≤5 min) Sukhan external identity token returned here.
 *
 * The token binds: tenant, externalUserId, identityLevel=external_user,
 * audience='sukhan-external', issuedAt, expiry, policyVersion. It is NOT
 * dashboard authentication.
 *
 * Identity lookup: (tenantId, externalUserId) — NEVER by email. Two external
 * users sharing an email remain separate Contacts. No dashboard User rows are
 * created for widget visitors.
 *
 * Rejects:
 *   - missing/invalid integration secret (401)
 *   - tenant not in site_user_only mode (409 — the secret is for Mode 2 only)
 *   - missing externalUserId (400)
 *   - invalid profile field types (400)
 */
export async function POST(req: NextRequest) {
  // Auth: the integration secret is a Bearer token. NEVER trust a tenantId in
  // the body — the secret DETERMINES the tenant.
  const authHeader = req.headers.get('authorization') || ''
  const presentedSecret = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : ''
  if (!presentedSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const tenant = await resolveTenantByIntegrationSecret(presentedSecret)
  if (!tenant) {
    // No tenant matches the presented secret. 401 (do not reveal whether the
    // secret is invalid vs the tenant is missing — enumeration resistance).
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const accessMode = coerceAccessMode(tenant.accessMode)
  if (accessMode !== 'site_user_only') {
    // The integration secret is for Mode 2 (site_user_only) ONLY. A secret
    // presented for a tenant in another mode is a configuration mismatch.
    return NextResponse.json(
      { error: 'mode_mismatch', message: 'Integration secret is for site_user_only mode' },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // externalUserId is MANDATORY. It is the stable identity key (semantically a
  // `sub`). Do NOT silently downgrade a missing externalUserId to anonymous.
  const externalUserId = String(body.externalUserId ?? '').trim().slice(0, 200)
  if (!externalUserId) {
    return NextResponse.json({ error: 'externalUserId_required' }, { status: 400 })
  }

  // Optional sanitized profile metadata (display only — NOT an identity authority).
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : undefined
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 200) : undefined
  const email =
    typeof body.email === 'string' && body.email.length <= 254 ? body.email.trim().toLowerCase() : undefined
  const avatarUrl =
    typeof body.avatarUrl === 'string' && /^https?:\/\//i.test(body.avatarUrl) && body.avatarUrl.length <= 500
      ? body.avatarUrl
      : undefined

  // Resolve/create the Contact by (tenantId, externalUserId). Email is NOT the
  // identity key — two external users sharing an email remain separate Contacts.
  // Wrap the tenant-scoped Contact operations in withTenant(tenantId).
  const { contactId } = await withTenant(tenant.tenantId, async () => {
    let contact = await db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.tenantId, identifier: externalUserId } },
      select: { id: true, name: true, email: true, avatarUrl: true },
    })

    const profileUpdates: { name?: string; email?: string | null; avatarUrl?: string | null } = {}
    if (name) profileUpdates.name = name
    if (email) profileUpdates.email = email
    if (avatarUrl) profileUpdates.avatarUrl = avatarUrl

    if (!contact) {
      // Create a NEW Contact with identifier=externalUserId (NOT email).
      contact = await db.contact.create({
        data: {
          tenantId: tenant.tenantId,
          identifier: externalUserId,
          identifierType: 'externalUser',
          name: name || username || email || 'Authenticated user',
          email: email ?? null,
          avatarUrl: avatarUrl ?? null,
          locale: 'fa',
          metadata: {},
        },
        select: { id: true, name: true, email: true, avatarUrl: true },
      })
    } else if (Object.keys(profileUpdates).length > 0) {
      // Update profile metadata only (NOT the identifier — externalUserId is immutable identity).
      contact = await db.contact.update({
        where: { id: contact.id },
        data: profileUpdates,
        select: { id: true, name: true, email: true, avatarUrl: true },
      })
    }
    return { contactId: contact.id }
  })

  // Mint the short-lived (≤5 min) external identity token. Binds tenant +
  // externalUserId + identityLevel=external_user + audience + iat + exp +
  // policyVersion (so a stricter policy transition invalidates it immediately).
  const token = signExternalIdentityToken({
    tenantId: tenant.tenantId,
    externalUserId,
    contactId,
    policyVersion: tenant.policyVersion,
    profile: { name, username, email, avatarUrl },
  })

  return NextResponse.json({ token, contactId })
}
