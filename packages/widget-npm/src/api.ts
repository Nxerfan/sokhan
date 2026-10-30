/**
 * Sukhan Widget — API communication layer.
 *
 * Wraps the public widget endpoints behind a typed client. The base
 * URL (`apiUrl`) resolution lives in `./realtime-resolve.ts`
 * (`resolveApiUrl`) — a pure function with no env access. Re-exported
 * here for backwards compatibility with consumers that import from
 * `'./api'`.
 *
 * Identity contract (PR #14 visitor access modes):
 *   - The SAME `POST /api/widget/<slug>/contact` endpoint serves all three
 *     modes. The BACKEND determines the mode from its CURRENT policy; the
 *     browser differentiates via the `Authorization: Bearer` header:
 *       anonymous       → no bearer, body { visitorId, email?, name? }
 *       verified_visitor → Bearer <resumeCredential>, body unused
 *       site_user_only   → Bearer <externalIdentityToken>, body unused
 *   - Verified-visitor OTP lives under `/verify-identity/{start,verify,resend}`.
 *   - The external identity token is minted SERVER-TO-SERVER by the customer
 *     backend via `POST /api/widget/identity/token` (Authorization: Bearer
 *     <integration secret>) — the browser ApiClient NEVER calls that route.
 *
 * Error contract: all failures throw `SukhanApiError` carrying a safe
 * `code` (parsed ONLY from a JSON `{ error: string }` body — never the raw
 * response body, never String()-coerced objects) + `status`. The widget
 * uses `code` to drive the correct identity-upgrade flow (policy_changed →
 * re-fetch config + verification flow; website_login_required → login UI).
 */

import type {
  WidgetConfig,
  IdentifyResponse,
  Message,
  OtpStartResponse,
  OtpVerifyResponse,
  OtpResendResponse,
} from './types.js'

// Re-export for backwards compat with `import { resolveApiUrl } from './api.js'`.
export { resolveApiUrl, HOSTED_API_URL } from './realtime-resolve.js'
import { resolveApiUrl } from './realtime-resolve.js'

/** Strip the optional `sk_` prefix from an API key. */
export function normalizeApiKey(key: string): string {
  return key.startsWith('sk_') ? key.slice(3) : key
}

/**
 * Typed, safe API error. Carries a stable `code` (parsed ONLY from a JSON
 * `{ error: string }` body) + HTTP `status`. The raw response body is NEVER
 * surfaced — malformed bodies become `code: 'unknown'`. This lets the widget
 * drive identity-upgrade flows from safe backend error codes:
 *   - policy_changed / verification_required / website_login_required /
 *     identity_token_invalid / policy_unavailable  → re-fetch config +
 *     the appropriate identity flow (never auto-resend the user's message).
 */
export class SukhanApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message?: string) {
    super(message || `sukhan: ${code} (${status})`)
    this.name = 'SukhanApiError'
    this.status = status
    this.code = code
    Object.setPrototypeOf(this, SukhanApiError.prototype)
  }
}

/**
 * Parse a safe error from a fetch Response. Accepts ONLY a JSON body shaped
 * `{ error: string }`. Anything else (non-2xx with malformed JSON, array,
 * missing `error`, non-string `error`, or a body that cannot be safely
 * interpreted) → `code: 'unknown'` with `status` preserved. The raw body
 * text is NEVER included in the error (no leak of internal details).
 *
 * A 2xx response returns null (no error).
 */
async function parseError(res: Response): Promise<SukhanApiError | null> {
  if (res.ok) return null
  const status = res.status
  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    // malformed JSON / non-JSON body → fail closed with a generic code.
    return new SukhanApiError(status, 'unknown', `sukhan: request failed (${status})`)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return new SukhanApiError(status, 'unknown', `sukhan: request failed (${status})`)
  }
  const code = (payload as { error?: unknown }).error
  if (typeof code === 'string' && code.length > 0 && code.length <= 200) {
    return new SukhanApiError(status, code, `sukhan: ${code} (${status})`)
  }
  return new SukhanApiError(status, 'unknown', `sukhan: request failed (${status})`)
}

/** Throw the parsed error if the response is not ok. Returns the JSON body otherwise. */
async function ensureOk<T>(res: Response): Promise<T> {
  const err = await parseError(res)
  if (err) throw err
  return (await res.json()) as T
}

/**
 * Typed API client for the Sukhan widget endpoints.
 *
 * The base URL defaults to the hosted Sukhan canonical origin
 * `https://app.sukhan.chat`; pass `apiUrl` explicitly for self-hosted
 * deployments.
 */
export class ApiClient {
  readonly slug: string
  readonly apiUrl: string

  constructor(apiKey: string, apiUrl?: string) {
    this.slug = normalizeApiKey(apiKey)
    this.apiUrl = resolveApiUrl(apiUrl)
  }

  async fetchConfig(): Promise<WidgetConfig> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/config`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    return ensureOk<WidgetConfig>(res)
  }

  /**
   * Anonymous visitor bootstrap — historical behavior (PR5/PR9). Sends
   * `{ visitorId, email?, name? }` with NO Authorization header. The backend
   * resolves/creates the visitor Contact + returns the realtime token.
   */
  async identifyVisitor(input: {
    visitorId: string
    email?: string
    name?: string
  }): Promise<IdentifyResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    })
    return ensureOk<IdentifyResponse>(res)
  }

  /**
   * Authenticated `/contact` bootstrap with a Bearer credential. Used for
   * BOTH verified_visitor (resume credential) and site_user_only (external
   * identity token). The backend determines the mode from its CURRENT
   * policy — the SAME endpoint + the SAME Authorization header shape serve
   * both; the credential TYPE is what differs. The body is not needed for
   * authenticated modes (the backend resolves the Contact from the signed
   * credential) — an empty JSON object is sent for a well-formed POST.
   *
   * On failure throws SukhanApiError with a safe code:
   *   - `verification_required` (verified_visitor, stale/invalid resume)
   *   - `website_login_required` (site_user_only, missing/invalid token)
   *   - `policy_unavailable` / `not_found` / `rate_limited` / ...
   */
  async bootstrapContact(bearer: string): Promise<IdentifyResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({}),
    })
    return ensureOk<IdentifyResponse>(res)
  }

  async loadMessages(token: string, conversationId: string): Promise<Message[]> {
    if (!conversationId) return []
    const res = await fetch(
      `${this.apiUrl}/api/widget/${this.slug}/messages?conversationId=${encodeURIComponent(conversationId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    )
    // Historical behavior: a failed history load returns [] (best-effort).
    // Do NOT throw SukhanApiError here — history reconciliation is a safety
    // net, silent on failure (preserves PR5/PR9 reconnect gap recovery).
    if (!res.ok) return []
    const data = (await res.json()) as { messages?: Message[] }
    return data.messages ?? []
  }

  /**
   * Send a message. On failure throws SukhanApiError carrying a safe code
   * (e.g. `policy_changed` / `verification_required` / `website_login_required`
   * / `identity_token_invalid` / `policy_unavailable` / `rate_limited`).
   * The widget uses `code` to drive the identity-upgrade flow WITHOUT
   * auto-resending the user's message (explicit retry remains safer).
   */
  async sendMessage(token: string, text: string): Promise<{
    message?: Message
    conversationId?: string
    aiResponse?: Message
    clientMessageId?: string
  }> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text }),
    })
    return ensureOk<{ message?: Message; conversationId?: string; aiResponse?: Message; clientMessageId?: string }>(res)
  }

  async submitCsat(
    token: string,
    conversationId: string,
    rating: number,
    comment?: string | null,
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/csat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ conversationId, rating, comment: comment ?? null }),
    })
    return ensureOk<{ ok: boolean }>(res)
  }

  // ── Verified-visitor OTP (existing backend routes) ──────────────────────

  /**
   * `POST /api/widget/<slug>/verify-identity/start` body `{ visitorId, email, name? }`.
   * Returns `{ requestId, expiresAt }`. Throws SukhanApiError on failure
   * (rate_limited / mode_mismatch / policy_unavailable / invalid_email /
   * verification_conflict / internal_error / provider codes).
   */
  async startOtp(input: {
    visitorId: string
    email: string
    name?: string
  }): Promise<OtpStartResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/verify-identity/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    })
    return ensureOk<OtpStartResponse>(res)
  }

  /**
   * `POST /api/widget/<slug>/verify-identity/verify` body
   * `{ visitorId, email, requestId, code }`. Returns
   * `{ verified: true, contactId, resumeCredential, realtimeToken }`.
   * Throws SukhanApiError on failure (code_mismatch / expired /
   * request_superseded / already_used / attempt_limit_reached / ...).
   */
  async verifyOtp(input: {
    visitorId: string
    email: string
    requestId: string
    code: string
  }): Promise<OtpVerifyResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/verify-identity/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    })
    return ensureOk<OtpVerifyResponse>(res)
  }

  /**
   * `POST /api/widget/<slug>/verify-identity/resend` body
   * `{ visitorId, email?, requestId? }`. Returns the ROTATED
   * `{ requestId, expiresAt }`. Throws SukhanApiError on failure
   * (resend_limit / expired / wrong_correlation / ...).
   */
  async resendOtp(input: {
    visitorId: string
    email?: string
    requestId?: string
  }): Promise<OtpResendResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/verify-identity/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    })
    return ensureOk<OtpResendResponse>(res)
  }
}
