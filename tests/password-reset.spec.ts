import { test, expect, type Browser } from '@playwright/test'
import { otpSignupFetch, MOCK_OTP_CODE } from './helpers/otp-signup'

/**
 * Password reset CI behavioral journey (PR #13 stability audit — BLOCKER #3).
 *
 * Password reset is an existing user-facing authentication capability. It
 * must NOT remain only in a legacy/non-CI suite. This spec adds ONE
 * behavioral journey to the normal regression suite (runs in BOTH Full and
 * Lite Docker editions).
 *
 * Uses the repository's SUPPORTED test/mock OTP mechanism ONLY:
 *   - NIXIFY_MOCK=true → the mock OTP code is `123456` (MOCK_OTP_CODE).
 *   - The new test-only `POST /api/auth/reset-password/dev/expire` route
 *     (gated behind NIXIFY_MOCK + SUKHAN_TEST_HARNESS — identical pattern
 *     to the existing `invitations/dev/expire`) deterministically expires an
 *     OTP so the "expired reset proof fails closed" path can be proven
 *     WITHOUT waiting for the 10-minute mock TTL.
 *
 * Production OTP security is NOT weakened:
 *   - The mock code path is NEVER active in production (NIXIFY_MOCK is unset).
 *   - The dev/expire route returns 404 in any production/Vercel deployment.
 *   - No OTP is exposed in production behavior.
 *
 * KNOWN SECURITY DECISION (documented truthfully, not invented here):
 *   The reset-password/complete route does NOT invalidate existing sessions.
 *   A user who is signed in on another device and resets their password
 *   will keep that existing session alive until its JWT expires. This is the
 *   CURRENT product contract — this spec does NOT invent session revocation.
 *
 * COVERAGE (user-required journey):
 *   1. create a real user (OTP signup) with password A
 *   2. start password reset
 *   3. complete OTP verification (mock code 123456)
 *   4. set a new password B
 *   5. old password A fails to authenticate
 *   6. new password B succeeds to authenticate
 *   7. unrelated user cannot use the reset request (email mismatch → 404)
 *   8. invalid reset proof fails closed:
 *        - wrong code → 400 code_mismatch
 *        - already-used verified proof → 400 already_used
 *        - unverified proof → complete rejected 403 otp_not_verified
 *        - expired proof → verify rejected 400 expired
 */

const BASE = 'http://127.0.0.1:81'
const OLD_PASSWORD = 'password123'
const NEW_PASSWORD = 'newpass456'

const H = { 'Content-Type': 'application/json' }

async function startReset(email: string): Promise<{ requestId: string; expiresAt: string }> {
  const res = await fetch(`${BASE}/api/auth/reset-password/start`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error(`reset start failed: ${res.status}`)
  return (await res.json()) as { requestId: string; expiresAt: string }
}

async function verifyReset(email: string, code: string, requestId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/auth/reset-password/verify`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, code, requestId }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function completeReset(email: string, requestId: string, newPassword: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/auth/reset-password/complete`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, requestId, newPassword }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function devExpireOtp(requestId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/reset-password/dev/expire`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ requestId }),
  })
  if (!res.ok) throw new Error(`dev/expire failed: ${res.status} (is NIXIFY_MOCK + SUKHAN_TEST_HARNESS set?)`)
}

/** Attempt a credentials login on a FRESH cookie context. Returns whether
 *  the session was established (user present in /api/auth/session). */
async function attemptLogin(browser: Browser, email: string, password: string): Promise<boolean> {
  const ctx = await browser.newContext()
  try {
    const page = await ctx.newPage()
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    await page.request.post(`${BASE}/api/auth/callback/credentials`, {
      form: { email, password, csrfToken, json: 'true' },
      maxRedirects: 0,
    })
    // Bounded poll for session propagation (same pattern as setupTenant).
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      if (sessionRes.ok()) {
        const sb = await sessionRes.json().catch(() => ({}))
        if (sb && sb.user) return true
      }
      await page.waitForTimeout(250)
    }
    return false
  } finally {
    await ctx.close().catch(() => {})
  }
}

test.describe('Password reset CI journey (PR #13 BLOCKER #3)', () => {
  let userEmail: string
  let requestId: string

  test.beforeAll(async () => {
    // 1. Create a REAL user via OTP signup. The signup complete sets the
    //    password hash for OLD_PASSWORD.
    const suffix = `${Date.now()}-${process.pid}`
    userEmail = `pr-${suffix}@iws.test`
    const signup = await otpSignupFetch(BASE, userEmail, `PR Tenant ${suffix}`, OLD_PASSWORD)
    if (!signup.ok) throw new Error(`signup failed for ${userEmail}: status=${signup.status}`)
  })

  test('start + verify + complete the existing OTP reset path', async () => {
    // 2. Start reset.
    const started = await startReset(userEmail)
    expect(started.requestId, 'start returns a requestId').toBeTruthy()
    requestId = started.requestId

    // 3. Verify the mock OTP code.
    const verified = await verifyReset(userEmail, MOCK_OTP_CODE, requestId)
    expect(verified.status, `verify should be 200 (got ${verified.status}: ${JSON.stringify(verified.body)})`).toBe(200)
    expect(verified.body.verified).toBe(true)

    // 4. Set the new password.
    const completed = await completeReset(userEmail, requestId, NEW_PASSWORD)
    expect(completed.status, `complete should be 200 (got ${completed.status}: ${JSON.stringify(completed.body)})`).toBe(200)
    expect(completed.body.ok).toBe(true)
  })

  test('old password fails to authenticate', async ({ browser }) => {
    const ok = await attemptLogin(browser, userEmail, OLD_PASSWORD)
    expect(ok, 'old password must NOT authenticate after reset').toBe(false)
  })

  test('new password succeeds to authenticate', async ({ browser }) => {
    const ok = await attemptLogin(browser, userEmail, NEW_PASSWORD)
    expect(ok, 'new password must authenticate').toBe(true)
  })

  test('unrelated user cannot use the reset request (email mismatch)', async () => {
    // A fresh reset for the original user.
    const started = await startReset(userEmail)
    // An UNRELATED email tries to verify with this requestId → the verify
    // route looks up by (requestId, email) → no row → 404 request_not_found.
    const otherEmail = `other-${Date.now()}@iws.test`
    const res = await verifyReset(otherEmail, MOCK_OTP_CODE, started.requestId)
    expect(res.status, 'unrelated email must be rejected with 404 request_not_found').toBe(404)
    expect(res.body.error).toBe('request_not_found')
  })

  test('invalid code fails closed (code_mismatch)', async () => {
    const started = await startReset(userEmail)
    const res = await verifyReset(userEmail, '000000', started.requestId)
    expect(res.status, 'wrong code must be rejected with 400 code_mismatch').toBe(400)
    expect(res.body.error).toBe('code_mismatch')
  })

  test('already-used verified proof fails closed (already_used)', async () => {
    // Verify once successfully, then re-verify the same requestId.
    const started = await startReset(userEmail)
    const first = await verifyReset(userEmail, MOCK_OTP_CODE, started.requestId)
    expect(first.status).toBe(200)
    const second = await verifyReset(userEmail, MOCK_OTP_CODE, started.requestId)
    expect(second.status, 're-using a verified proof must be rejected with 400 already_used').toBe(400)
    expect(second.body.error).toBe('already_used')
  })

  test('unverified proof cannot complete (otp_not_verified)', async () => {
    // Start but DO NOT verify, then attempt to complete.
    const started = await startReset(userEmail)
    const res = await completeReset(userEmail, started.requestId, 'yet-another-pass-1')
    expect(res.status, 'completing without verification must be rejected with 403 otp_not_verified').toBe(403)
    expect(res.body.error).toBe('otp_not_verified')
  })

  test('expired reset proof fails closed (expired)', async () => {
    // Start a fresh reset, then deterministically expire the OTP via the
    // test-only dev/expire route, then attempt to verify → 400 expired.
    const started = await startReset(userEmail)
    await devExpireOtp(started.requestId)
    const res = await verifyReset(userEmail, MOCK_OTP_CODE, started.requestId)
    expect(res.status, 'expired proof must be rejected with 400 expired').toBe(400)
    expect(res.body.error).toBe('expired')
  })
})
