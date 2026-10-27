import { NextRequest, NextResponse } from 'next/server'
import { db, globalDb, withTenant } from '@/lib/db'
import { getAuthSecret } from '@/lib/env-check'
import { evaluateVisitorCurrentPolicyAccess, type ContactIdentityClass } from '@/lib/widget-access-policy'
import crypto from 'crypto'

/**
 * Internal endpoint for the Docker realtime service to verify a visitor's
 * CURRENT-policy access before allowing the socket to connect (io.use
 * middleware) AND before allowing a conversation:join (revalidation after
 * a potential policy transition since connect).
 *
 * Auth: X-Internal-Secret header must match NEXTAUTH_SECRET (timing-safe).
 * This endpoint is NOT public — it's for server-to-server use only.
 *
 * Query params:
 *   contactId       — the visitor token's contactId
 *   tenantId        — the visitor token's tenantId
 *   slug            — the visitor token's slug (route binding)
 *   identityLevel   — optional; the visitor token's identityLevel claim
 *                     (may be absent for legacy tokens)
 *   policyVersion   — optional; the visitor token's policyVersion claim
 *                     (may be absent for legacy tokens)
 *
 * Fail-closed behavior:
 *   - Missing/invalid X-Internal-Secret → 403 forbidden.
 *   - Missing contactId/tenantId/slug → 400 missing_params.
 *   - Tenant lookup by slug fails → 403 forbidden (no PII leak).
 *   - Token tenantId does NOT match the slug's tenant → 403 forbidden.
 *   - WidgetConfig missing/invalid accessMode/policyVersion → 503
 *     policy_unavailable.
 *   - Contact not found / wrong tenant → 403 identity_token_invalid.
 *   - Decision denied → 403 with the stable reason.
 *   - Decision allowed → 200 { ok: true }.
 *
 * The response NEVER includes PII (Contact email/name/raw errors/raw
 * DB stack traces). The body is exactly `{ ok: true }` or
 * `{ error: '<stable_reason>' }` for the documented reasons.
 *
 * Rate limiting NOT needed — the X-Internal-Secret gates this endpoint
 * (only the realtime service + the Next.js app itself know the secret).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export async function GET(req: NextRequest) {
  const secret = getAuthSecret()
  const authHeader = req.headers.get('x-internal-secret') || ''
  if (!timingSafeEqualStr(authHeader, secret)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const contactId = url.searchParams.get('contactId')
  const tenantId = url.searchParams.get('tenantId')
  const slug = url.searchParams.get('slug')
  // identityLevel + policyVersion are optional (legacy tokens). Use empty
  // string as the "absent" sentinel so the evaluator sees `undefined` after
  // the empty-string → undefined coercion below.
  const identityLevelRaw = url.searchParams.get('identityLevel')
  const policyVersionRaw = url.searchParams.get('policyVersion')

  if (!contactId || !tenantId || !slug) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 })
  }

  // Look up the tenant by slug (global lookup — Tenant is a global model).
  // Include widgetConfig so we can resolve the CURRENT policy in one query.
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant) {
    // No slug-bound tenant — the token is invalid. Don't reveal whether the
    // slug exists; return forbidden.
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Verify the token's tenantId matches the slug-bound tenant. A token with
  // tenantId A + slug B (where slug B resolves to tenant B) is rejected.
  if (tenant.id !== tenantId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // WidgetConfig missing → policy_unavailable (503). The tenant exists but
  // no access policy is configured — fail closed.
  if (!tenant.widgetConfig) {
    return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  }

  // Resolve the token claims. URL query params are strings; the evaluator
  // expects `unknown`. Pass `undefined` when the query param is absent so
  // legacy tokens (both claims absent) are detected correctly.
  const tokenIdentityLevel = identityLevelRaw === null ? undefined : identityLevelRaw
  const tokenPolicyVersion = policyVersionRaw === null ? undefined : Number(policyVersionRaw)

  // Load the Contact (tenant-scoped). Inside withTenant, db.contact.findUnique
  // auto-injects the tenantId filter (defense-in-depth — the where clause
  // also carries the id). A wrong-tenant Contact resolves to null.
  const contact = await withTenant(tenantId, async () => {
    return db.contact.findUnique({
      where: { id: contactId },
      select: { id: true, tenantId: true, identifierType: true, externalUserId: true, emailVerifiedAt: true },
    })
  })

  if (!contact || contact.tenantId !== tenantId) {
    return NextResponse.json({ error: 'identity_token_invalid' }, { status: 403 })
  }

  const contactIdentityClass: ContactIdentityClass = {
    identifierType: contact.identifierType,
    externalUserId: contact.externalUserId,
    emailVerifiedAt: contact.emailVerifiedAt,
  }

  // Pure evaluator — same as the REST send route + Vercel adapter. Fail
  // closed on every documented reason.
  const decision = evaluateVisitorCurrentPolicyAccess({
    currentAccessMode: tenant.widgetConfig.accessMode,
    currentPolicyVersion: tenant.widgetConfig.policyVersion,
    tokenIdentityLevel,
    tokenPolicyVersion,
    contactIdentityClass,
  })

  if (decision.allowed) {
    return NextResponse.json({ ok: true })
  }
  // policy_unavailable → 503 (the tenant's CURRENT policy is corrupt —
  // the operator must fix it before any visitor can connect).
  if (decision.reason === 'policy_unavailable') {
    return NextResponse.json({ error: 'policy_unavailable' }, { status: 503 })
  }
  // All other reasons are 403 (the visitor's token doesn't satisfy the
  // current policy). The reason is stable + distinguishable but never
  // reveals PII / DB internals.
  return NextResponse.json({ error: decision.reason }, { status: 403 })
}
