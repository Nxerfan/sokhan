/**
 * Sukhan Widget — customer identity endpoint resolver + fetcher.
 *
 * Pure, zero-runtime-dependency module that handles the CUSTOMER-origin
 * identity lookup for `site_user_only` access mode. The browser GETs the
 * CUSTOMER backend's identity endpoint (same-origin only) with
 * `credentials: same-origin` + `Accept: application/json`; the customer
 * backend returns either:
 *
 *   { "authenticated": false }                                    // logged out
 *   { "authenticated": true, "token": "<short-lived Sukhan external identity token>" }
 *
 * The token is minted SERVER-TO-SERVER by the customer backend via
 * `POST <SUKHAN_ORIGIN>/api/widget/identity/token` (Authorization: Bearer
 * <integration secret>) — the browser NEVER sees the integration secret.
 *
 * SECURITY CONTRACT (fail-closed everywhere):
 *   - The endpoint is ALWAYS resolved against the CUSTOMER page origin
 *     (`window.location.origin`), NEVER against `apiUrl` / the Sukhan
 *     backend origin. A relative path like `/api/sukhan-identity` belongs
 *     to the customer site, not Sukhan.
 *   - Cross-origin absolute endpoints are REJECTED (no host auth cookies
 *     leaked to a third origin). Only same-origin relative paths OR an
 *     absolute URL whose origin === `window.location.origin` are accepted.
 *   - The request sends NO Sukhan credentials, NO externalUserId, NO
 *     visitorId, NO Contact id, NO realtime token. The customer's own
 *     session cookie rides along only through normal same-origin browser
 *     behavior.
 *   - Timeout / network failure / non-2xx / malformed body → fail closed
 *     (returns `null` = integration_unavailable). NEVER downgraded to
 *     `authenticated:false` and NEVER downgraded to anonymous.
 *   - The token is MEMORY-ONLY. The fetcher returns it; the widget holds it
 *     in a private field. It is NEVER written to localStorage /
 *     sessionStorage / cookies / IndexedDB, NEVER logged, NEVER put in
 *     URLs, NEVER exposed through DOM attributes.
 */

/** Bounded timeout for the customer identity lookup (ms). */
export const IDENTITY_TIMEOUT_MS = 5000

export interface IdentityResult {
  /** `true` when the customer reports a logged-in host user (with a token). */
  authenticated: boolean
  /** Present + non-empty ONLY when `authenticated === true`. Memory-only. */
  token?: string
}

/**
 * Strict parser for the customer identity response. Accepts ONLY:
 *
 *   { "authenticated": false }
 *   { "authenticated": true, "token": "<non-empty-string>" }
 *
 * Rejects (returns null) EVERYTHING else:
 *   - non-object / array / null
 *   - missing `authenticated`
 *   - `authenticated` not a boolean
 *   - `authenticated === true` without `token`
 *   - `authenticated === true` with empty/whitespace `token`
 *   - `token` not a string (no String() coercion of objects)
 *   - `authenticated === false` WITH a token (ambiguous — reject)
 *
 * Never throws — returns null on any malformed shape so the caller fails
 * closed consistently.
 */
export function parseIdentityResponse(body: unknown): IdentityResult | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const b = body as { authenticated?: unknown; token?: unknown }
  if (typeof b.authenticated !== 'boolean') return null
  if (b.authenticated === true) {
    if (typeof b.token !== 'string') return null
    if (b.token.length === 0 || b.token.trim().length === 0) return null
    // Reject an oversized token defensively (a real Sukhan external identity
    // token is a compact JWT; a megabyte-sized value signals corruption/abuse).
    if (b.token.length > 8192) return null
    return { authenticated: true, token: b.token }
  }
  // authenticated === false. A token alongside `false` is ambiguous — reject.
  if (b.token !== undefined && b.token !== null) return null
  return { authenticated: false }
}

/**
 * Resolve the customer identity endpoint URL. Pure.
 *
 * Priority:
 *   1. explicit `SukhanOptions.identityEndpoint`
 *   2. public config `identityEndpointPath`
 *
 * Resolution rules:
 *   - A relative path (`/...`, not `//`) resolves against the CUSTOMER page
 *     origin (`pageOrigin` / `window.location.origin`).
 *   - An absolute URL is accepted ONLY when its origin === the page origin
 *     (same-origin). Cross-origin absolute endpoints are REJECTED.
 *   - Protocol-relative `//`, `javascript:`, `data:`, backslash confusion,
 *     and any other unsafe form are REJECTED.
 *
 * Returns the absolute URL string, or `null` when no usable same-origin
 * endpoint exists (fail closed — the widget surfaces integration_unavailable
 * and does NOT downgrade to anonymous).
 */
export function resolveIdentityEndpoint(args: {
  explicit?: string
  configPath?: string | null
  pageOrigin?: string
}): string | null {
  const raw = args.explicit && args.explicit.trim().length > 0
    ? args.explicit
    : typeof args.configPath === 'string' && args.configPath.trim().length > 0
      ? args.configPath
      : null
  if (!raw) return null

  const pageOrigin =
    args.pageOrigin ??
    (typeof window !== 'undefined' && window.location ? window.location.origin : '')

  // Reject backslash confusion + control chars defensively.
  if (raw.includes('\\')) return null
  if (/[\x00-\x1f\x7f]/.test(raw)) return null

  // Relative same-origin path: `/...` (not `//`).
  if (raw === '/' || /^\/[^/]/.test(raw)) {
    if (!pageOrigin) return null
    try {
      return new URL(raw, pageOrigin).href
    } catch {
      return null
    }
  }

  // Absolute URL: accept ONLY same-origin.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      if (!pageOrigin) return null
      if (u.origin !== pageOrigin) return null // cross-origin → reject
      return u.href
    } catch {
      return null
    }
  }

  // Reject `//`, `javascript:`, `data:`, malformed, etc.
  return null
}

/**
 * Customer identity lookup. Bounded, same-origin, fail-closed.
 *
 * `GET <endpoint>` with `Accept: application/json` + `credentials: same-origin`.
 * Sends NO Sukhan credentials, NO externalUserId, NO visitorId, NO Contact id,
 * NO realtime token. The customer's own session cookie rides along only
 * through normal same-origin browser behavior.
 *
 * Returns:
 *   - `{ authenticated: false }`                       → logged-out host user
 *   - `{ authenticated: true, token: <string> }`       → logged-in host user
 *   - `null`                                          → integration unavailable
 *
 * `null` (integration_unavailable) is returned on: timeout, network failure,
 * non-2xx response, malformed JSON, or any rejected body shape. The widget
 * treats `null` as a safe integration-unavailable state — it does NOT equate
 * it with `authenticated:false` and does NOT downgrade to anonymous.
 *
 * The returned token is MEMORY-ONLY — the caller is responsible for never
 * persisting it (see module docstring).
 */
export async function fetchIdentity(
  endpoint: string,
  opts?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  },
): Promise<IdentityResult | null> {
  const timeoutMs = opts?.timeoutMs ?? IDENTITY_TIMEOUT_MS
  const fetchImpl = opts?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return null

  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null

  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
  } catch {
    // network failure OR abort (timeout) → fail closed.
    if (timer) clearTimeout(timer)
    return null
  }
  if (timer) clearTimeout(timer)

  if (!res.ok) return null // non-2xx → integration_unavailable

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null // malformed JSON → fail closed
  }
  return parseIdentityResponse(body)
}
