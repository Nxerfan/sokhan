import { NextResponse, NextRequest } from 'next/server'
import { db, withTenant } from '@/lib/db'
import { resolveTenantByIntegrationSecret } from '@/lib/widget-integration-credential'
import { signExternalIdentityToken } from '@/lib/widget-identity-tokens'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'
import crypto from 'crypto'

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}
function isValidAvatarUrl(url: string): boolean {
  if (url.length > 500) return false
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

/**
 * Sukhan identity mint endpoint — server-to-server (site_user_only).
 *
 * #1 (concurrency-safe): uses Prisma upsert on the (tenantId, externalUserId)
 * compound unique key — 10 concurrent mints for the same NEW externalUserId
 * all succeed + all tokens resolve to the SAME Contact (exactly one row). No
 * raw Prisma unique-violation / 500 exposed.
 *
 * #2 (strict profile types): if an optional profile field is PRESENT but
 * malformed (not a string) → 400 invalid_profile. No silent String() coercion
 * of objects. email + avatarUrl validated.
 *
 * Blocker 1: external-user Contact lookup by (tenantId, externalUserId) via the
 * new field. identifier=opaque 'ext_'+uuid. anonymous visitorId == externalUserId
 * → TWO separate Contacts.
 * Blocker 5: token carries ONLY claims (no PII). Response {token}.
 * Blocker 14: parseAccessMode strict; mints ONLY if site_user_only.
 * #3: policyVersion validated via parsePolicyVersion before signing.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || ''
  const presentedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!presentedSecret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const tenant = await resolveTenantByIntegrationSecret(presentedSecret)
  if (!tenant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const accessMode = parseAccessMode(tenant.accessMode)
  if (accessMode === null) return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  if (accessMode !== 'site_user_only') return NextResponse.json({ error: 'mode_mismatch' }, { status: 409 })

  // #3: validate policyVersion before signing.
  const policyVersion = parsePolicyVersion(tenant.policyVersion)
  if (policyVersion === null) return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  // Strict externalUserId validation.
  const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId.trim() : ''
  if (!externalUserId || externalUserId.length > 200 || /\p{Cc}/u.test(externalUserId)) {
    return NextResponse.json({ error: 'externalUserId_required' }, { status: 400 })
  }

  // #2: strict optional profile type validation. If PRESENT but not a string → 400.
  const profileFields = ['name', 'username', 'email', 'avatarUrl'] as const
  for (const f of profileFields) {
    if (body[f] !== undefined && typeof body[f] !== 'string') {
      return NextResponse.json({ error: 'invalid_profile', field: f }, { status: 400 })
    }
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : undefined
  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim().slice(0, 200) : undefined
  const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined
  if (email && !isValidEmail(email)) return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
  const avatarUrl = typeof body.avatarUrl === 'string' && body.avatarUrl.trim() ? body.avatarUrl.trim() : undefined
  if (avatarUrl && !isValidAvatarUrl(avatarUrl)) return NextResponse.json({ error: 'invalid_avatar_url' }, { status: 400 })

  // #1: concurrency-safe upsert on (tenantId, externalUserId).
  const { contactId } = await withTenant(tenant.tenantId, async () => {
    // CRITICAL 6: CREATE uses display fallback; UPDATE only mutates supplied fields.
    // Omission preserves existing values (does NOT erase name/email/avatar).
    const createProfile = {
      name: name || username || email || 'Authenticated user',
      email: email ?? null,
      avatarUrl: avatarUrl ?? null,
    }
    const updateProfile: Record<string, string | null> = {}
    if (name) updateProfile.name = name
    if (email) updateProfile.email = email
    if (avatarUrl) updateProfile.avatarUrl = avatarUrl
    // #1: Prisma upsert on a COMPOUND unique (tenantId, externalUserId) does
    // NOT emit INSERT ... ON CONFLICT (only single-field uniques get the
    // atomic path). Under concurrent creates for a NEW externalUserId, the
    // create branch races and throws P2002. Bounded retry: on P2002, another
    // concurrent mint won the create -- re-read the contact by (tenantId,
    // externalUserId) and proceed. Never leak raw P2002 (would surface as 500).
    let resolvedId: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await db.contact.upsert({
          where: { tenantId_externalUserId: { tenantId: tenant.tenantId, externalUserId } },
          create: {
            tenantId: tenant.tenantId,
            identifier: 'ext_' + crypto.randomUUID(),
            identifierType: 'externalUser',
            externalUserId,
            ...createProfile,
            locale: 'fa',
            metadata: {},
          },
          update: updateProfile,
          select: { id: true },
        })
        resolvedId = result.id
        break
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 2) {
          const existing = await db.contact.findUnique({
            where: { tenantId_externalUserId: { tenantId: tenant.tenantId, externalUserId } },
            select: { id: true },
          })
          if (existing) { resolvedId = existing.id; break }
          continue // row vanished between the P2002 and the re-read -- retry
        }
        throw e
      }
    }
    if (!resolvedId) throw new Error('identity resolution failed')
    return { contactId: resolvedId }
  })

  const token = signExternalIdentityToken({ tenantId: tenant.tenantId, externalUserId, contactId, policyVersion })
  return NextResponse.json({ token })
}
