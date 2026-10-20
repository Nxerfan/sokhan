import { NextResponse, NextRequest } from 'next/server'
import { globalDb, withTenant, db } from '@/lib/db'
import { verifyInvitationToken } from '@/lib/invitations'

/**
 * DEV-ONLY invitation expiry manipulation — CI test barrier (BLOCKER 3).
 *
 *   POST  /api/invitations/dev/expire   body: { workspace, token }
 *
 * Deterministically expires a pending invitation by setting its
 * `expiresAt` to the Unix epoch (1970 — definitely in the past). Used by
 * the behavioral test `tests/invite-workspace-switching.spec.ts` to
 * prove that:
 *   - expired invitations cannot be accepted (accept route checks
 *     isExpired → 410 'expired')
 *   - expired pending invitations do NOT consume a plan-limit seat
 *     (gating.ts counts only `expiresAt > now` pending invitations)
 *
 * GATING — this route is ONLY available when BOTH:
 *   - process.env.NODE_ENV !== 'production'
 *   - process.env.NIXIFY_MOCK === 'true'
 *
 * `NIXIFY_MOCK=true` is the CI/dev mock-OTP flag — it is NEVER set in
 * production (production requires a real Nixify API key). This route
 * therefore returns 404 in any production deployment, Vercel preview
 * included (Vercel sets NODE_ENV=production). The 404 is identical to
 * the "not found" error so the route's existence is not leakable.
 *
 * SECURITY
 * --------
 *   - The raw token IS the auth — same as the public lookup route. The
 *     caller must possess the raw token (which is returned exactly once
 *     at creation) to expire the invitation. An attacker without the raw
 *     token cannot target any invitation.
 *   - The route resolves the tenant from the public slug → tenantId,
 *     then looks up the invitation INSIDE withTenant (fail-closed).
 *   - The route ONLY mutates `expiresAt` — it does not change status,
 *     role, email, tokenHash, or any other field. The mutation is
 *     idempotent.
 *   - This route does NOT require authentication (the raw token is the
 *     capability), matching the public lookup route's contract.
 */
export async function POST(req: NextRequest) {
  // Hard gate — NEVER available in production or without the CI mock flag.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NIXIFY_MOCK !== 'true'
  ) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const slug = String(body?.workspace ?? '').trim()
  const rawToken = String(body?.token ?? '').trim()
  if (!slug || !rawToken) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Resolve slug → tenantId (Tenant is a global model).
  const tenant = await globalDb.tenant.findUnique({
    where: { slug },
    select: { id: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const tokenHash = verifyInvitationToken(rawToken)

  // Look up the invitation INSIDE the tenant context (fail-closed —
  // the extension injects tenantId into the where clause).
  const invitation = await withTenant(tenant.id, () =>
    db.invitation.findUnique({ where: { tokenHash }, select: { id: true } }),
  )
  if (!invitation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Set expiresAt to the Unix epoch — deterministically in the past.
  // Only mutates expiresAt + updatedAt. No other field is touched.
  await withTenant(tenant.id, () =>
    db.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(0), updatedAt: new Date() },
    }),
  )

  return NextResponse.json({ ok: true })
}
