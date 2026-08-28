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
 *   in a server component or during SSR — initialization is deferred to the
 *   client.
 *
 * ## Next.js usage (client component)
 *
 * ```tsx
 * 'use client'
 * import { useEffect } from 'react'
 * import { initSukhan } from 'sukhan-widget'
 *
 * export function Chat() {
 *   useEffect(() => {
 *     initSukhan({ apiKey: process.env.NEXT_PUBLIC_SUKHAN_API_KEY })
 *   }, [])
 *   return null
 * }
 * ```
 *
 * ## Vanilla JS usage (script tag, no bundler)
 *
 * Don't import the NPM package — use the script-tag alternative endpoint
 * at `/api/widget/v1/sukhan.js` instead. That endpoint serves a
 * self-executing bundle that reads the API key from the `data-api-key`
 * attribute on the `<script>` tag.
 *
 * @packageDocumentation
 */

import { SukhanWidget } from './widget'
import type { SukhanOptions, SukhanInstance } from './types'

export { SukhanWidget } from './widget'
export { ApiClient, normalizeApiKey, resolveApiUrl } from './api'
export { SukhanSocket } from './socket'
export type {
  WidgetConfig,
  Message,
  MessageContent,
  MessageAttachment,
  SenderType,
  IdentifyResponse,
  SukhanOptions,
  SukhanInstance,
  SocketEvent,
  SocketHandler,
} from './types'

/**
 * Initialize the Sukhan widget. Returns a handle with open/close/send/destroy
 * methods. Calling this more than once per page is a no-op (guarded by
 * `window.__sukhan_mounted`).
 *
 * Resolves the API key from (in priority order):
 *   1. `options.apiKey`
 *   2. `window.SUKHAN_API_KEY` (runtime injection — useful for non-bundler
 *      setups that can't do build-time env replacement)
 *   3. `process.env.SUKHAN_API_KEY` (inlined at build time by webpack /
 *      Turbopack / Vite when the consumer's `env` is exposed)
 *
 * Throws synchronously if no API key is found.
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

  // Kick off async init (fetches config, mounts DOM, connects socket). Errors
  // are logged but not thrown — the page should still work without the widget.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => widget.init())
    } else {
      widget.init()
    }
  }

  // Return a handle that exposes the public API. The methods proxy to the
  // internal SukhanWidget — but guard against the widget not having mounted
  // yet (e.g. open() before DOMContentLoaded).
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

/**
 * Auto-initialize on import in a browser environment when SUKHAN_API_KEY is
 * set. On the server (Next.js SSR, Node), this is a no-op.
 *
 * The env var is read via `process.env.SUKHAN_API_KEY`. Bundlers like webpack
 * and Turbopack replace `process.env.SUKHAN_API_KEY` at build time, so the
 * consumer's `.env` file is the source of truth. For runtime injection (e.g.
 * when the API key isn't known at build time), set `window.SUKHAN_API_KEY`
 * before this module loads.
 */
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
