/**
 * Nixify OTP client.
 *
 * Sends and verifies OTP codes via the Nixify API.
 * Supports mock mode (NIXIFY_MOCK=true) for local dev and tests.
 */

const NIXIFY_API_KEY = process.env.NIXIFY_API_KEY || ''
const NIXIFY_BASE_URL = process.env.NIXIFY_BASE_URL || 'https://your-nixify-domain.com/api/v1'
const MOCK_MODE = process.env.NIXIFY_MOCK === 'true'
const MOCK_CODE = '123456'

export type OtpPurpose = 'signup' | 'login' | 'reset_password'

export interface SendOtpResult {
  requestId: string
  expiresAt: string
}

export interface VerifyOtpResult {
  verified: boolean
  requestId: string
}

export class NixifyError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message)
    this.name = 'NixifyError'
  }
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new NixifyError('validation_failed', 'Invalid email format', 400)
  }
}

export async function sendOtp(email: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  validateEmail(email)

  if (MOCK_MODE) {
    return {
      requestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
  }

  const res = await fetch(`${NIXIFY_BASE_URL}/otp/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NIXIFY_API_KEY}`,
    },
    body: JSON.stringify({ email, purpose }),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    const code = data.error || 'unknown_error'
    const status = res.status

    if (code === 'rate_limited') {
      const retryAfter = res.headers.get('retry-after') || '60'
      throw new NixifyError('rate_limited', `Rate limited. Retry after ${retryAfter}s`, 429)
    }
    if (code === 'disposable_email') {
      throw new NixifyError('disposable_email', 'Disposable email not allowed', 400)
    }
    if (code === 'locked') {
      throw new NixifyError('locked', 'Account locked', 403)
    }
    if (code === 'ip_blocked') {
      throw new NixifyError('ip_blocked', 'IP blocked', 403)
    }
    throw new NixifyError(code, data.message || 'Nixify API error', status)
  }

  return {
    requestId: data.request_id || data.requestId,
    expiresAt: data.expires_at || data.expiresAt,
  }
}

export async function verifyOtp(
  email: string,
  code: string,
  purpose: string,
  requestId: string,
): Promise<VerifyOtpResult> {
  validateEmail(email)

  if (MOCK_MODE) {
    return {
      verified: code === MOCK_CODE,
      requestId,
    }
  }

  const res = await fetch(`${NIXIFY_BASE_URL}/otp/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NIXIFY_API_KEY}`,
    },
    body: JSON.stringify({ email, code, purpose, request_id: requestId }),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    const errorCode = data.error || 'unknown_error'

    if (errorCode === 'code_mismatch') {
      throw new NixifyError('code_mismatch', 'Invalid code', 400)
    }
    if (errorCode === 'expired') {
      throw new NixifyError('expired', 'Code expired', 400)
    }
    if (errorCode === 'already_used') {
      throw new NixifyError('already_used', 'Code already used', 400)
    }
    if (errorCode === 'rate_limited') {
      throw new NixifyError('rate_limited', 'Rate limited', 429)
    }
    throw new NixifyError(errorCode, data.message || 'Verification failed', res.status)
  }

  return {
    verified: data.verified ?? true,
    requestId: data.request_id || requestId,
  }
}

export async function resendOtp(email: string, purpose: string): Promise<SendOtpResult> {
  validateEmail(email)

  if (MOCK_MODE) {
    return {
      requestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
  }

  const res = await fetch(`${NIXIFY_BASE_URL}/otp/resend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NIXIFY_API_KEY}`,
    },
    body: JSON.stringify({ email, purpose }),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    const code = data.error || 'unknown_error'
    if (code === 'rate_limited') {
      throw new NixifyError('rate_limited', 'Rate limited', 429)
    }
    throw new NixifyError(code, data.message || 'Resend failed', res.status)
  }

  return {
    requestId: data.request_id || data.requestId,
    expiresAt: data.expires_at || data.expiresAt,
  }
}

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
  }
  return messages[code] || { fa: 'خطای ناشناخته', en: 'Unknown error' }
}
