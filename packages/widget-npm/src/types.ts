/**
 * Sukhan Widget — TypeScript type definitions.
 * @packageDocumentation
 */

export type {
  RealtimeTransport,
  RealtimeEndpointConfig,
} from './realtime-resolve.js'

// ─── Visitor access modes (mirrors the backend WidgetConfig policy) ───────
// The backend `GET /api/widget/<slug>/config` response spreads the additive
// public access-policy fields (accessMode / policyVersion / loginUrl /
// loginButtonLabel / loginReturnUrlParam / identityEndpointPath) on top of
// the visual config. The NPM widget consumes them to drive the correct
// identity flow. These are STRICT mirrors of the frozen backend contract in
// `src/lib/widget-access-evaluator.ts` — the runtime MUST NOT invent
// fallback modes when these fields are malformed/missing; it fail-closes.
export type AccessMode = 'anonymous' | 'verified_visitor' | 'site_user_only'

export interface WidgetConfig {
  slug: string
  name: string
  accentColor: string
  launcherShape: 'tab' | 'rounded' | 'pill'
  position: 'bottom-start' | 'bottom-end'
  avatarUrl?: string | null
  logoUrl?: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
  defaultDirection: 'rtl' | 'ltr'
  /**
   * Backend-supplied plan-lock flags (effective config). true when
   * the tenant's plan does not include customization (free plan) —
   * the widget then renders the "Powered by Sukhan" badge. The old
   * `plan` enum was stale: the backend never sends it.
   */
  isLocked?: boolean
  poweredBy?: boolean
  /**
   * V2 positioning (Phase 2). The backend resolves the EFFECTIVE
   * positioning per device from stored config + plan entitlements.
   * Offsets are included only for plans entitled to precise
   * positioning. Older backends omit this field → the widget falls
   * back to the V1 `position` field (bottom-start/bottom-end only).
   */
  positioning?: {
    desktop: import('./positioning').EffectivePositioning
    mobile: import('./positioning').EffectivePositioning
  }
  /**
   * V2 colors (Phase 2 / Feature 2). The backend resolves the EFFECTIVE
   * color tokens from stored config + plan entitlements. Custom colors
   * are included only for plans entitled to customColors. Older backends
   * omit this field → the widget falls back to the V1 `accentColor`.
   */
  colors?: {
    mode: string
    presetId?: string
    tokens: {
      accent: string
      launcherBg: string
      launcherFg: string
      headerBg: string
      headerText: string
      panelBg: string
      panelText: string
      visitorBubbleBg: string
      visitorBubbleText: string
      agentBubbleBg: string
      agentBubbleText: string
    }
  }
  /**
   * Backend-supplied realtime endpoint config (additive field). The widget
   * uses this as the PRIMARY runtime source. Older backends omit the
   * field; the widget falls back to the documented hosted default.
   */
  realtime?: import('./realtime-resolve').RealtimeEndpointConfig
  // ── Additive public access-policy fields (PR #14 visitor access modes) ──
  /** CURRENT visitor access mode. Drives the identity flow. */
  accessMode?: AccessMode
  /** CURRENT policy version. Tied to the realtime token; stale → policy_changed. */
  policyVersion?: number
  /** Optional customer login URL (absolute http/https or same-origin relative). */
  loginUrl?: string | null
  /** Optional customer login button label. */
  loginButtonLabel?: string | null
  /** Optional query param name to append the current page URL as the return URL. */
  loginReturnUrlParam?: string | null
  /** Optional customer backend identity endpoint path (same-origin relative). */
  identityEndpointPath?: string | null
}

export type SenderType = 'agent' | 'contact' | 'ai' | 'system'

export interface MessageAttachment {
  url: string
  type: 'image' | 'file'
  name: string
}

export interface MessageContent {
  text?: string
  attachments?: MessageAttachment[]
}

export interface Message {
  id: string
  conversationId: string
  senderType: SenderType
  contentType: 'text' | 'image' | 'file' | 'system'
  content: MessageContent
  status?: 'sent' | 'delivered' | 'read'
  createdAt: string
}

export interface IdentifyResponse {
  contactId: string
  conversationId: string | null
  realtimeToken: string
  locale: string
  direction: 'rtl' | 'ltr'
}

/**
 * Verified-visitor OTP START response.
 * `POST /api/widget/<slug>/verify-identity/start` body `{ visitorId, email, name? }`.
 */
export interface OtpStartResponse {
  requestId: string
  expiresAt: string
}

/**
 * Verified-visitor OTP VERIFY response.
 * `POST /api/widget/<slug>/verify-identity/verify` body `{ visitorId, email, requestId, code }`.
 * The `resumeCredential` is the long-lived credential stored in localStorage
 * (separate key from the visitorId) and used to bootstrap `/contact` with
 * `Authorization: Bearer <resume>`. The `realtimeToken` here is a
 * convenience — the canonical bootstrap path is the authenticated `/contact`
 * call which returns the authoritative conversationId + fresh realtimeToken.
 */
export interface OtpVerifyResponse {
  verified: true
  contactId: string
  resumeCredential: string
  realtimeToken: string
}

/**
 * Verified-visitor OTP RESEND response (rotates requestId + expiresAt).
 * `POST /api/widget/<slug>/verify-identity/resend` body `{ visitorId, email?, requestId? }`.
 */
export interface OtpResendResponse {
  requestId: string
  expiresAt: string
}

/**
 * Explicit realtime/socket configuration accepted by `SukhanSocket`.
 * The socket does NOT read any global state (`window.__sukhan_api_url`,
 * etc.) — it receives everything via this interface.
 */
export interface SukhanSocketOptions {
  token: string
  clientScriptUrl: string
  realtimeUrl: string
  realtimePath: string
  transports: import('./realtime-resolve').RealtimeTransport[]
  addTrailingSlash: boolean
}

/**
 * Safe detail passed to `SukhanOptions.onLoginRequired` and the
 * `sukhan:login-required` window CustomEvent when the widget enters the
 * site-user login-required state. Contains ONLY public, non-sensitive data.
 * NEVER includes the integration secret, identity token, realtime token, or
 * (preferably) the Contact id.
 */
export interface SukhanLoginRequiredDetail {
  accessMode: 'site_user_only'
  loginUrl: string | null
  loginButtonLabel: string | null
  loginReturnUrlParam: string | null
}

export interface SukhanOptions {
  apiKey?: string
  /**
   * The base URL of the Sukhan backend. Defaults to the hosted Sukhan
   * canonical origin `https://app.sukhan.chat`. NEVER defaults to
   * `window.location.origin` — the host page origin is NOT the Sukhan
   * backend by default.
   */
  apiUrl?: string
  /**
   * Optional override for the realtime endpoint config. Takes priority
   * over the backend-supplied `config.realtime`.
   */
  realtime?: import('./realtime-resolve').RealtimeEndpointConfig
  container?: HTMLElement
  locale?: 'fa' | 'en'
  direction?: 'rtl' | 'ltr'
  /** @internal — suppresses the polling fallback. Test-only. */
  disablePolling?: boolean
  visitor?: { name?: string; email?: string; visitorId?: string }
  /**
   * CUSTOMER application's backend identity endpoint (same-origin relative
   * path OR an absolute URL whose origin equals `window.location.origin`).
   * This is NOT a Sukhan API endpoint. The browser GETs it with
   * `credentials: same-origin` + `Accept: application/json`; the customer
   * backend returns `{ authenticated: false }` or
   * `{ authenticated: true, token: "<short-lived Sukhan external identity token>" }`.
   * The token is minted server-to-server by the customer backend via
   * `POST <SUKHAN_ORIGIN>/api/widget/identity/token` using the integration
   * secret — the browser never sees that secret. Priority:
   * 1) explicit `SukhanOptions.identityEndpoint`
   * 2) public config `identityEndpointPath`.
   * The resolved URL is ALWAYS against the CUSTOMER page origin
   * (`window.location.origin`), never `apiUrl` / the Sukhan backend.
   */
  identityEndpoint?: string
  /**
   * Fired ONCE when the widget enters the site-user login-required state
   * (logged-out host user under `site_user_only`). A matching
   * `sukhan:login-required` CustomEvent is also dispatched on `window`.
   * Avoid event storms — emit on entry, not on every render/reconnect tick.
   */
  onLoginRequired?: (detail: SukhanLoginRequiredDetail) => void
}

export type SocketEvent =
  | 'connect'
  | 'disconnect'
  | 'reconnect'
  | 'message:new'
  | 'conversation:updated'
  | 'typing:start'
  | 'typing:stop'

export type SocketHandler = (payload: unknown) => void

export interface SukhanInstance {
  open(): void
  close(): void
  toggle(): void
  send(text: string): Promise<void>
  destroy(): void
  config: WidgetConfig | null
  /**
   * Bootstrap / re-bootstrap the widget using an already-minted Sukhan
   * external identity token (obtained by the host from its OWN backend).
   * Calling this in `site_user_only` mode bootstraps the authenticated
   * Contact. Passing `null` treats the host user as logged out: clears the
   * current site-user identity state, disconnects the socket, stops polling,
   * clears Contact/conversation/realtime token/messages, and enters the
   * login-required state. Never retains the previous authenticated user's
   * conversation. Uses a generation guard so stale async responses from the
   * previous identity cannot mutate the new identity's state (SPA user-switch
   * safety).
   */
  setIdentity(token: string | null): Promise<void>
  /**
   * Re-fetch the configured customer `identityEndpoint`. If authenticated,
   * obtain the new external identity token and bootstrap with it. If
   * unauthenticated, enter the login-required state. The primary SPA/modal
   * post-login integration method — works WITHOUT reloading the page.
   */
  refreshIdentity(): Promise<void>
}
