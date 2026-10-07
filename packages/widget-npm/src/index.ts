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
 * ## Runtime contract (Task W)
 *
 * - The hosted default `apiUrl` is `https://app.sukhan.chat`. The widget
 *   NEVER falls back to `window.location.origin` — the host page origin
 *   is NOT the Sukhan backend by default. Self-hosted deployments MUST
 *   pass `apiUrl` explicitly.
 * - The realtime endpoint config comes from the BACKEND `config.realtime`
 *   response (additive field). The widget passes it explicitly to
 *   `SukhanSocket` (no `window.__sukhan_api_url` coupling). An optional
 *   `SukhanOptions.realtime` override takes priority.
 *
 * @packageDocumentation
 */

import { SukhanWidget } from './widget'
import type { SukhanOptions, SukhanInstance } from './types'

export { SukhanWidget } from './widget'
export { ApiClient, normalizeApiKey, resolveApiUrl } from './api'
export { SukhanSocket, loadScriptOnce } from './socket'
export type { SukhanSocketDeps } from './socket'
export {
  resolveRealtimeUrl,
  resolveRealtimeFromConfig,
  buildSocketIoScriptUrl,
  HOSTED_API_URL,
  HOSTED_REALTIME_CONFIG,
  SukhanConfigError,
} from './realtime-resolve'
export { mergeMessages, mergeMessage } from './merge'
export type {
  WidgetConfig,
  Message,
  MessageContent,
  MessageAttachment,
  SenderType,
  IdentifyResponse,
  SukhanOptions,
  SukhanInstance,
  SukhanSocketOptions,
  SocketEvent,
  SocketHandler,
  RealtimeTransport,
  RealtimeEndpointConfig,
} from './types'

/**
 * Initialize the Sukhan widget. Returns a handle with open/close/send/destroy
 * methods. Calling this more than once per page is a no-op (guarded by
 * `window.__sukhan_mounted`).
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
    get config() {
      return widget.config
    },
  }
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
