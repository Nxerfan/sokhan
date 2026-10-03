/**
 * Test helper: OTP-based signup flow.
 *
 * Replaces the deprecated legacy POST /api/auth/signup bypass endpoint.
 * Uses the 3-step OTP flow (start → verify → complete) with the Nixify
 * mock OTP code "123456" (requires NIXIFY_MOCK=true in the dev env).
 *
 * Works with both `fetch` and Playwright's `page.request` patterns.
 */

export const MOCK_OTP_CODE = '123456'

/**
 * Perform a 3-step OTP signup via fetch().
 * Returns the parsed JSON from /complete (contains `tenantId`).
 */
export async function otpSignupFetch(
  base: string,
  email: string,
  workspaceName: string,
  password = 'password123',
): Promise<{ ok: boolean; tenantId?: string; error?: string; status: number }> {
  const headers = { 'Content-Type': 'application/json' }

  // Step 1: start
  const startRes = await fetch(`${base}/api/auth/signup/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email }),
  })
  if (!startRes.ok) {
    return { ok: false, error: (await startRes.json().catch(() => ({}))).error, status: startRes.status }
  }
  const { requestId } = await startRes.json()

  // Step 2: verify (mock code)
  const verifyRes = await fetch(`${base}/api/auth/signup/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, code: MOCK_OTP_CODE, requestId }),
  })
  if (!verifyRes.ok) {
    return { ok: false, error: (await verifyRes.json().catch(() => ({}))).error, status: verifyRes.status }
  }

  // Step 3: complete
  const completeRes = await fetch(`${base}/api/auth/signup/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, requestId, password, workspaceName }),
  })
  const data = await completeRes.json().catch(() => ({}))
  return { ok: completeRes.ok, tenantId: data.tenantId, error: data.error, status: completeRes.status }
}

/**
 * Perform a 3-step OTP signup via Playwright's APIRequestContext.
 * Returns the parsed JSON from /complete.
 */
export async function otpSignupPlaywright(
  request: { post: (url: string, opts: { data: unknown; headers: Record<string, string> }) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }> },
  base: string,
  email: string,
  workspaceName: string,
  password = 'password123',
): Promise<{ ok: boolean; tenantId?: string; status: number }> {
  const headers = { 'Content-Type': 'application/json' }

  // Step 1: start
  const startRes = await request.post(`${base}/api/auth/signup/start`, {
    data: { email },
    headers,
  })
  if (!startRes.ok()) {
    return { ok: false, status: startRes.status() }
  }
  const startData = await startRes.json() as { requestId: string }

  // Step 2: verify
  const verifyRes = await request.post(`${base}/api/auth/signup/verify`, {
    data: { email, code: MOCK_OTP_CODE, requestId: startData.requestId },
    headers,
  })
  if (!verifyRes.ok()) {
    return { ok: false, status: verifyRes.status() }
  }

  // Step 3: complete
  const completeRes = await request.post(`${base}/api/auth/signup/complete`, {
    data: { email, requestId: startData.requestId, password, workspaceName },
    headers,
  })
  const data = await completeRes.json() as { tenantId?: string }
  return { ok: completeRes.ok(), tenantId: data?.tenantId, status: completeRes.status() }
}
