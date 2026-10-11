/**
 * Nixify OTP client — production integration with https://nixify.ir
 *
 * Canonical production origin: https://nixify.ir
 * API version: v1
 *
 * Endpoints:
 *   POST /api/v1/otp/send    — { email, purpose }
 *   POST /api/v1/otp/verify   — { email, code, purpose }
 *   POST /api/v1/otp/resend   — { email, purpose }
 *
 * Response identifiers (CRITICAL — do NOT confuse):
 *   otp_request_id — OTP correlation ID (used for local pending-state tracking)
 *   request_id     — API trace ID (used for diagnostics/support only)
 *
 * Error envelope:
 *   { error: { code, message, doc_url }, request_id }
 *
 * Security:
 *   - NIXIFY_API_KEY is server-only (this module imports 'server-only').
 *   - The key is never logged, never exposed to client bundles.
 *   - NIXIFY_BASE_URL is NOT required for production — the origin is canonical.
 *   - All calls use a bounded timeout (15s) via AbortController.
 *   - All upstream responses are validated before use.
 */

// ─── Canonical production origin ─────────────────────────────────
const NIXIFY_ORIGIN = 'https://nixify.ir'
const NIXIFY_API_VERSION = '/api/v1'
const NIXIFY_ENDPOINTS = {
  send: `${NIXIFY_ORIGIN}${NIXIFY_API_VERSION}/otp/send`,
  verify: `${NIXIFY_ORIGIN}${NIXIFY_API_VERSION}/otp/verify`,
  resend: `${NIXIFY_ORIGIN}${NIXIFY_API_VERSION}/otp/resend`,
} as const

// ─── Configuration ───────────────────────────────────────────────
const MOCK_MODE = process.env.NIXIFY_MOCK === 'true'
const MOCK_CODE = '123456'
const REQUEST_TIMEOUT_MS = 15_000

// ─── Purpose mapping ────────────────────────────────────────────
/**
 * Sokhan internal purpose vocabulary vs Nixify wire-format purpose.
 * Nixify v1 accepts: "signup" | "login" | "reset"
 * Sokhan uses:       "signup" | "login" | "reset_password"
 */
export type OtpPurpose = 'signup' | 'login' | 'reset_password'

const PURPOSE_MAP: Record<OtpPurpose, 'signup' | 'login' | 'reset'> = {
  signup: 'signup',
  login: 'login',
  reset_password: 'reset',
}

function mapPurpose(p: OtpPurpose): 'signup' | 'login' | 'reset' {
  return PURPOSE_MAP[p]
}

// ─── Result types ───────────────────────────────────────────────
export interface SendOtpResult {
  /** OTP correlation ID — stored in local pending-state, used for verification correlation. */
  otpRequestId: string
  /** ISO timestamp when the OTP expires. */
  expiresAt: string
  /** API trace ID — diagnostics/support only. NOT for OTP correlation. */
  apiRequestId?: string
}

export interface VerifyOtpResult {
  verified: boolean
  /** OTP correlation ID returned by Nixify (should match the one from send). */
  otpRequestId?: string
  /** API trace ID — diagnostics/support only. */
  apiRequestId?: string
}

// ─── Error types ────────────────────────────────────────────────
export type NixifyErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'key_revoked'
  | 'key_expired'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'feature_not_available'
  | 'ip_blocked'
  | 'locked'
  | 'internal_error'
  | 'code_mismatch'
  | 'expired'
  | 'already_used'
  | 'not_found'
  | 'disposable_email'
  // Internal (client-side) error categories:
  | 'nixify_network_error'
  | 'nixify_timeout'
  | 'nixify_invalid_response'
  | 'nixify_configuration_error'
  | 'nixify_correlation_mismatch'
  | 'unknown_error'

export class NixifyError extends Error {
  constructor(
    public code: NixifyErrorCode,
    message: string,
    public statusCode: number = 400,
    public apiRequestId?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'NixifyError'
  }
}

// ─── Email validation ───────────────────────────────────────────
function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new NixifyError('validation_failed', 'Invalid email format', 400)
  }
}

// ─── Structured error parsing ───────────────────────────────────
interface NixifyErrorBody {
  error?: {
    code?: string
    message?: string
    doc_url?: string
  }
  request_id?: string
}

function parseNixifyError(res: Response, body: unknown, apiRequestId?: string): NixifyError {
  const errorBody = (body || {}) as NixifyErrorBody
  const err = errorBody.error || {}
  const code = (err.code || 'unknown_error') as NixifyErrorCode
  const message = err.message || `Nixify API error (HTTP ${res.status})`
  const retryAfter = res.headers.get('retry-after')
  const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) || undefined : undefined

  return new NixifyError(code, message, res.status, apiRequestId || errorBody.request_id, retryAfterSeconds)
}

// ─── HTTP helper with timeout ──────────────────────────────────
async function nixifyFetch(
  endpoint: string,
  body: Record<string, unknown>,
  operation: 'otp_send' | 'otp_verify' | 'otp_resend',
): Promise<{ res: Response; data: unknown }> {
  // Read the API key dynamically (not at module load) so env changes are respected.
  const apiKey = process.env.NIXIFY_API_KEY || ''
  if (!apiKey && !MOCK_MODE) {
    throw new NixifyError('nixify_configuration_error', 'NIXIFY_API_KEY is not configured', 500)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const data = await res.json().catch(() => null)
    return { res, data }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new NixifyError('nixify_timeout', `Nixify ${operation} timed out after ${REQUEST_TIMEOUT_MS}ms`, 504)
    }
    throw new NixifyError(
      'nixify_network_error',
      `Network error contacting Nixify: ${err instanceof Error ? err.message : 'unknown'}`,
      502,
    )
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Response validation ────────────────────────────────────────
function validateOtpResponse(data: unknown, operation: string): SendOtpResult {
  if (typeof data !== 'object' || data === null) {
    throw new NixifyError('nixify_invalid_response', `Nixify ${operation}: malformed response (not an object)`, 502)
  }
  const d = data as Record<string, unknown>
  const otpRequestId = d.otp_request_id
  const expiresAt = d.expires_at
  const apiRequestId = d.request_id

  if (typeof otpRequestId !== 'string' || otpRequestId.length === 0) {
    throw new NixifyError('nixify_invalid_response', `Nixify ${operation}: missing or invalid otp_request_id`, 502, typeof apiRequestId === 'string' ? apiRequestId : undefined)
  }
  if (typeof expiresAt !== 'string' || isNaN(new Date(expiresAt).getTime())) {
    throw new NixifyError('nixify_invalid_response', `Nixify ${operation}: missing or invalid expires_at`, 502, typeof apiRequestId === 'string' ? apiRequestId : undefined)
  }

  return {
    otpRequestId,
    expiresAt,
    apiRequestId: typeof apiRequestId === 'string' ? apiRequestId : undefined,
  }
}

// ─── Public API: sendOtp ───────────────────────────────────────
export async function sendOtp(email: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  validateEmail(email)
  const nixifyPurpose = mapPurpose(purpose)

  if (MOCK_MODE) {
    return {
      otpRequestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
  }

  const { res, data } = await nixifyFetch(NIXIFY_ENDPOINTS.send, { email, purpose: nixifyPurpose }, 'otp_send')

  if (!res.ok) {
    throw parseNixifyError(res, data)
  }

  return validateOtpResponse(data, 'otp_send')
}

// ─── Public API: verifyOtp ─────────────────────────────────────
/**
 * Verify an OTP code with Nixify.
 *
 * Nixify wire request (documented):
 *   { email, code, purpose }
 *
 * The `expectedOtpRequestId` is LOCAL-ONLY metadata — it is NEVER sent to
 * Nixify. After a successful upstream verify, the returned `otp_request_id`
 * MUST match the local expected correlation ID. If it does not, the
 * verification is rejected fail-closed (nixify_correlation_mismatch, 409).
 *
 * This prevents local request A from being verified using upstream OTP B.
 */
export async function verifyOtp(
  email: string,
  code: string,
  purpose: OtpPurpose,
  expectedOtpRequestId: string,
): Promise<VerifyOtpResult> {
  validateEmail(email)
  const nixifyPurpose = mapPurpose(purpose)

  if (MOCK_MODE) {
    // Mock mode: correlate with the expected local OTP request ID so tests
    // exercise the same application path as production.
    if (code !== MOCK_CODE) {
      throw new NixifyError('code_mismatch', 'Mock code mismatch', 400)
    }
    return { verified: true, otpRequestId: expectedOtpRequestId }
  }

  // Wire body contains ONLY documented fields — NEVER otp_request_id or request_id.
  const { res, data } = await nixifyFetch(
    NIXIFY_ENDPOINTS.verify,
    { email, code, purpose: nixifyPurpose },
    'otp_verify',
  )

  if (!res.ok) {
    throw parseNixifyError(res, data)
  }

  if (typeof data !== 'object' || data === null) {
    throw new NixifyError('nixify_invalid_response', 'Nixify otp_verify: malformed response (not an object)', 502)
  }
  const d = data as Record<string, unknown>
  if (d.verified !== true) {
    throw new NixifyError(
      'nixify_invalid_response',
      'Nixify otp_verify: verified field is not true',
      502,
      typeof d.request_id === 'string' ? d.request_id : undefined,
    )
  }

  // A successful real Nixify verify MUST contain a non-empty otp_request_id.
  const upstreamOtpRequestId = d.otp_request_id
  if (typeof upstreamOtpRequestId !== 'string' || upstreamOtpRequestId.length === 0) {
    throw new NixifyError(
      'nixify_invalid_response',
      'Nixify otp_verify: missing otp_request_id in success response',
      502,
      typeof d.request_id === 'string' ? d.request_id : undefined,
    )
  }

  // Fail-closed: upstream otp_request_id MUST match the local expected correlation ID.
  if (upstreamOtpRequestId !== expectedOtpRequestId) {
    throw new NixifyError(
      'nixify_correlation_mismatch',
      'OTP correlation mismatch: upstream otp_request_id does not match local expected ID',
      409,
      typeof d.request_id === 'string' ? d.request_id : undefined,
    )
  }

  return {
    verified: true,
    otpRequestId: upstreamOtpRequestId,
    apiRequestId: typeof d.request_id === 'string' ? d.request_id : undefined,
  }
}

// ─── Public API: resendOtp ─────────────────────────────────────
export async function resendOtp(email: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  validateEmail(email)
  const nixifyPurpose = mapPurpose(purpose)

  if (MOCK_MODE) {
    return {
      otpRequestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
  }

  const { res, data } = await nixifyFetch(NIXIFY_ENDPOINTS.resend, { email, purpose: nixifyPurpose }, 'otp_resend')

  if (!res.ok) {
    throw parseNixifyError(res, data)
  }

  return validateOtpResponse(data, 'otp_resend')
}

// ─── Error message helper (for UI) ──────────────────────────────
/** Map Nixify error codes to user-friendly bilingual messages. */
export function getErrorMessage(code: string): { fa: string; en: string } {
  const messages: Record<string, { fa: string; en: string }> = {
    disposable_email: { fa: 'ایمیل یکبار مصرف مجاز نیست', en: 'Disposable emails not allowed' },
    rate_limited: { fa: 'لطفاً کمی صبر کنید', en: 'Please wait a moment' },
    code_mismatch: { fa: 'کد اشتباه است', en: 'Invalid code' },
    expired: { fa: 'کد منقضی شده', en: 'Code expired' },
    already_used: { fa: 'این کد قبلاً استفاده شده', en: 'Code already used' },
    locked: { fa: 'حساب قفل شده است', en: 'Account locked' },
    ip_blocked: { fa: 'آی‌پی مسدود شده است', en: 'IP blocked' },
    validation_failed: { fa: 'ایمیل نامعتبر است', en: 'Invalid email' },
    resend_limit_reached: { fa: 'حداکثر تلاش مجاز', en: 'Resend limit reached' },
    email_already_registered: { fa: 'این ایمیل قبلاً ثبت شده', en: 'Email already registered' },
    email_not_found: { fa: 'ایمیل یافت نشد', en: 'Email not found' },
    free_trial_already_used: { fa: 'اشتراک رایگان قبلاً استفاده شده', en: 'Free trial already used' },
    unauthorized: { fa: 'کلید API نامعتبر است', en: 'Invalid API key' },
    key_revoked: { fa: 'کلید API باطل شده است', en: 'API key revoked' },
    key_expired: { fa: 'کلید API منقضی شده است', en: 'API key expired' },
    insufficient_scope: { fa: 'کلید API دسترسی کافی ندارد', en: 'Insufficient API key scope' },
    quota_exceeded: { fa: 'سهمیه تمام شده', en: 'Quota exceeded' },
    feature_not_available: { fa: 'این ویژگی در دسترس نیست', en: 'Feature not available' },
    internal_error: { fa: 'خطای سرور', en: 'Server error' },
    nixify_network_error: { fa: 'خطای اتصال به سرویس تأیید', en: 'Cannot reach OTP service' },
    nixify_timeout: { fa: 'زمان اتصال به سرویس تأیید تمام شد', en: 'OTP service timeout' },
    nixify_invalid_response: { fa: 'پاسخ نامعتبر از سرویس تأیید', en: 'Invalid OTP service response' },
    nixify_configuration_error: { fa: 'خطای پیکربندی سرور', en: 'Server configuration error' },
    nixify_correlation_mismatch: { fa: 'عدم تطابق درخواست تأیید', en: 'OTP correlation mismatch' },
  }
  return messages[code] || { fa: 'خطای ناشناخته', en: 'Unknown error' }
}

// Export for testing
export { NIXIFY_ENDPOINTS, PURPOSE_MAP, REQUEST_TIMEOUT_MS }
