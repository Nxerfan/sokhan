import { NextResponse, NextRequest } from 'next/server'
import { globalDb } from '@/lib/db'

/**
 * DEV-ONLY reset-password OTP expiry manipulation — CI test barrier
 * (PR #13 stability audit — BLOCKER #3).
 *
 *   POST  /api/auth/reset-password/dev/expire   body: { requestId }
 *
 * Deterministically expires a reset-password OTP request by setting its
 * `expiresAt` to the Unix epoch (1970 — definitely in the past). Used by
 * the behavioral spec `tests/password-reset.spec.ts` to prove that the
 * reset-password/verify route rejects an EXPIRED reset proof with 400
 * `expired` (the verify route checks `otpReq.expiresAt < new Date()`).
 *
 * This mirrors the existing `src/app/api/invitations/dev/expire/route.ts`
 * test-infra pattern — it is NOT a product feature and is NOT reachable in
 * any production deployment.
 *
 * GATING — this route is ONLY available when:
 *   - process.env.NIXIFY_MOCK === 'true'
 *   - process.env.SUKHAN_TEST_HARNESS === 'true'
 *
 * Both flags are the definitive CI/dev mock flags — they are NEVER set in
 * Vercel production or preview deployments. Docker CI runs production-mode
 * builds but sets both flags, so this route IS available in Docker CI
 * (where the behavioral tests run). In any other environment this route
 * returns 404 `not_found` (identical to a non-existent route — its
 * existence is not leakable).
 *
 * SECURITY
 * --------
 *   - The `requestId` is a non-secret correlation ID returned by the
 *     reset-password/start route. It is NOT a capability — possessing it
 *     does not let an attacker verify or complete a reset (those still
 *     require the correct OTP code + a verified OtpRequest row). This
 *     route ONLY mutates `expiresAt` — it does not change `verified`,
 *     `attempts`, `email`, `userId`, or any other field.
 *   - `OtpRequest` is a GLOBAL Prisma model (no `tenantId` column), so the
 *     fail-closed tenant extension is not applicable here — `globalDb`
 *     (the unscoped client) is the correct client.
 *   - The mutation is idempotent.
 */
export async function POST(req: NextRequest) {
  // Hard gate — NEVER available in production or without the CI mock flags.
  if (
    process.env.NIXIFY_MOCK !== 'true' ||
    process.env.SUKHAN_TEST_HARNESS !== 'true'
  ) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const requestId = String(body?.requestId ?? '').trim()
  if (!requestId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // OtpRequest is a global model — look it up by its unique requestId.
  const otpReq = await globalDb.otpRequest.findUnique({
    where: { requestId },
    select: { id: true, purpose: true },
  })
  if (!otpReq || otpReq.purpose !== 'reset_password') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Set expiresAt to the Unix epoch — deterministically in the past.
  // Only mutates expiresAt. No other field is touched (verified/attempts/
  // email/userId remain unchanged).
  await globalDb.otpRequest.update({
    where: { id: otpReq.id },
    data: { expiresAt: new Date(0) },
  })

  return NextResponse.json({ ok: true })
}
