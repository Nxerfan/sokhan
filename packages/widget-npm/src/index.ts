/**
 * Sukhan Widget — main entry point.
 *
 * Exports the public API surface (`initSukhan`, `SukhanWidget`, types) and
 * auto-initializes the widget in a browser environment when the
 * `SUKHAN_API_KEY` environment variable is set (inlined at build time by
 * bundlers like webpack / Turbopack).
 *
 * ## Auto-initialization behavior
 *
 * - **Browser, key set**: on `DOMContentLoaded` (or immediately if the
 *   document is already loaded), `initSukhan()` is called with no args.
 *   The widget reads `SUKHAN_API_KEY` from `process.env` (build-time
 *   replacement) or `window.SUKHAN_API_KEY` (runtime injection).
 * - **Browser, key NOT set**: nothing happens. Consumers must call
 *   `initSukhan({ apiKey: '...' })` explicitly.
 * - **Server (Next.js SSR, Node)**: the module is a no-op. Safe to import
 *   in a server component or during SSR — initialization is deferred to
 *   the client.
 *
 * ## Runtime contract (Task W + PR #14 visitor access modes)
 *
 * - The hosted default `apiUrl` is `https://app.sukhan.chat`. The widget
 *   NEVER falls back to `window.location.origin` — the host page origin
 *   is NOT the Sukhan backend by default. Self-hosted deployments MUST
 *   pass `apiUrl` explicitly.
 * - The realtime endpoint config comes from the BACKEND `config.realtime`
 *   response (additive field). The widget passes it explicitly to
 *   `SukhanSocket` (no `window.__sukhan_api_url` coupling). An optional
 *   `SukhanOptions.realtime` override takes priority.
 * - The CURRENT visitor access policy (`accessMode` + `policyVersion` +
 *   login fields) is consumed from the public config. The widget drives
 *   the correct identity flow (anonymous / verified_visitor /
 *   site_user_only) and re-evaluates on every policy authorization
 *   failure. `setIdentity(token)` / `refreshIdentity()` expose the
 *   SPA/modal post-login integration surface. The package is NOT
 *   published to npm until external publication actually happens.
 *
 * @packageDocumentation
 */

import { SukhanWidget } from './widget.js'
import type { SukhanOptions, SukhanInstance } from './types.js'

export { SukhanWidget } from './widget.js'
export type { SukhanWidgetDeps } from './widget.js'
export { ApiClient, SukhanApiError, normalizeApiKey, resolveApiUrl } from './api.js'
export { SukhanSocket, loadScriptOnce } from './socket.js'
export type { SukhanSocketDeps } from './socket.js'
export {
  resolveIdentityEndpoint,
  fetchIdentity,
  parseIdentityResponse,
  IDENTITY_TIMEOUT_MS,
  type IdentityResult,
} from './identity.js'
export {
  resolveRealtimeUrl,
  resolveRealtimeFromConfig,
  buildSocketIoScriptUrl,
  HOSTED_API_URL,
  HOSTED_REALTIME_CONFIG,
  SukhanConfigError,
} from './realtime-resolve.js'
export { mergeMessages, mergeMessage } from './merge.js'
export type {
  WidgetConfig,
  Message,
  MessageContent,
  MessageAttachment,
  SenderType,
  IdentifyResponse,
  OtpStartResponse,
  OtpVerifyResponse,
  OtpResendResponse,
  AccessMode,
  SukhanOptions,
  SukhanInstance,
  SukhanSocketOptions,
  SocketEvent,
  SocketHandler,
  SukhanLoginRequiredDetail,
  RealtimeTransport,
  RealtimeEndpointConfig,
} from './types.js'

/**
 * Initialize the Sukhan widget. Returns a handle with open/close/send/
 * setIdentity/refreshIdentity/destroy methods. Calling this more than
 * once per page is a no-op (guarded by `window.__sukhan_mounted`).
 */
export function initSukhan(options: SukhanOptions = {}): SukhanInstance {
  const apiKey =
    options.apiKey ||
    (typeof window !== 'undefined'
      ? (window as unknown as { SUKHAN_API_KEY?: string }).SUKHAN_API_KEY
      : undefined) ||
    (typeof process !== 'undefined' && process.env ? process.env.SUKHAN_API_KEY : undefined)

  if (!apiKey) {
    throw new Error(
      'sukhan: no API key found. Pass { apiKey } to initSukhan(), set window.SUKHAN_API_KEY, or define SUKHAN_API_KEY in your environment.',
    )
  }

  const widget = new SukhanWidget({ ...options, apiKey })

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => widget.init())
    } else {
      widget.init()
    }
  }

  return {
    open: () => widget.open(),
    close: () => widget.close(),
    toggle: () => widget.toggle(),
    send: (text: string) => widget.send(text),
    destroy: () => widget.destroy(),
    setIdentity: (token: string | null) => widget.setIdentity(token),
    refreshIdentity: () => widget.refreshIdentity(),
    get config() {
      return widget.config
    },
    /** @internal — test-only: inject a message into the widget's state. */
    __ingestMessage: (m: unknown) => widget.__ingestMessage(m as any),
  } as SukhanInstance & { __ingestMessage: (m: unknown) => void }
}

// ---------- Auto-init ----------

declare const process: { env: Record<string, string | undefined> } | undefined

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const envKey =
    typeof process !== 'undefined' && process.env ? process.env.SUKHAN_API_KEY : undefined
  const windowKey = (window as unknown as { SUKHAN_API_KEY?: string }).SUKHAN_API_KEY
  const key = envKey || windowKey
  if (key) {
    try {
      initSukhan({ apiKey: key })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sukhan] auto-init failed', e)
    }
  }
}
